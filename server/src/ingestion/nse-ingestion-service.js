const { createHash, randomBytes } = require("node:crypto");
const sources = require("../config/nse-source-registry");
const {
  buildNseDataset,
  datasetSchemaVersion,
} = require("./nse-dataset-builder");
const {
  discoverNseReports,
  downloadReport,
} = require("./nse-report-discovery");
const { enrichArchivedReports } = require("./nse-report-enricher");
const { RedisDatasetPublisher } = require("./redis-dataset-publisher");

const lockTtlSeconds = 20 * 60;
const releaseLockScript =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

class NseIngestionService {
  constructor({
    redisClient,
    archiveService = null,
    fetchImpl = fetch,
    clock = () => new Date(),
  }) {
    this.redisClient = redisClient;
    this.archiveService = archiveService;
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.publisher = new RedisDatasetPublisher(redisClient);
    this.sources = new Map(sources.map((source) => [source.id, source]));
  }

  async run({
    archiveAllReports = true,
    expectedTradeDate = null,
    skipIfCurrent = false,
  } = {}) {
    if (!this.redisClient?.isReady) {
      throw new Error("Redis is not ready; NSE data was not ingested.");
    }

    const reports = await discoverNseReports({ fetchImpl: this.fetchImpl });
    if (expectedTradeDate && reports.tradeDate !== expectedTradeDate) {
      throw new Error(
        `NSE has not published the expected trade date ${expectedTradeDate}; latest complete report date is ${reports.tradeDate}.`,
      );
    }
    const reportListingSignature = hashBytes(
      Buffer.from(
        reports.reportFiles
          .map((report) =>
            JSON.stringify([
              report.displayName,
              report.fileName,
              report.url,
              report.fileSize,
            ]),
          )
          .sort()
          .join("\n"),
      ),
    );
    const lockKey = `lock:nse:eq:ingestion:${reports.tradeDate}`;
    const lockValue = randomBytes(24).toString("base64url");
    const acquired = await this.redisClient.set(lockKey, lockValue, {
      NX: true,
      EX: lockTtlSeconds,
    });
    if (acquired !== "OK") {
      throw new Error(
        `An NSE ingestion is already running for ${reports.tradeDate}.`,
      );
    }

    try {
      const previousMetadataRaw = await this.redisClient.get(
        "nse:eq:dataset:latest",
      );
      let previousMetadata = null;
      if (previousMetadataRaw) {
        try {
          previousMetadata = JSON.parse(previousMetadataRaw);
        } catch {
          throw new Error(
            "The active Redis dataset pointer is invalid; refusing to replace it.",
          );
        }
      }
      const activeVersionPrefix = previousMetadata?.datasetVersion
        ? `nse:eq:v:${previousMetadata.datasetVersion}`
        : null;
      const activeIndexExists = activeVersionPrefix
        ? await this.redisClient.exists(`${activeVersionPrefix}:index:symbol`)
        : 0;

      if (
        skipIfCurrent &&
        activeIndexExists > 0 &&
        previousMetadata?.tradeDate === reports.tradeDate &&
        previousMetadata?.datasetSchemaVersion === datasetSchemaVersion &&
        previousMetadata?.reportListingSignature === reportListingSignature &&
        (!this.archiveService?.hasCompleteArchive ||
          (await this.archiveService.hasCompleteArchive(reports.tradeDate)))
      ) {
        return {
          skipped: true,
          skipReason: "ACTIVE_DATASET_MATCHES_CURRENT_NSE_REPORT_LISTING",
          tradeDate: reports.tradeDate,
          datasetVersion: previousMetadata.datasetVersion,
          reportCount: reports.reportFiles.length,
        };
      }

      const retrievedAt = this.clock().toISOString();
      let archive = null;
      let bhavcopyBytes;
      let securityMasterBytes;
      if (archiveAllReports) {
        if (!this.archiveService) {
          throw new Error("Local NSE report archive is not configured.");
        }
        archive = await this.archiveService.saveReportSet({
          tradeDate: reports.tradeDate,
          reportFiles: reports.reportFiles,
          pairUrls: new Set([reports.bhavcopy.url, reports.securityMaster.url]),
        });
        bhavcopyBytes = archive.pairBytes.get(reports.bhavcopy.url);
        securityMasterBytes = archive.pairBytes.get(reports.securityMaster.url);
      } else {
        [bhavcopyBytes, securityMasterBytes] = await Promise.all([
          downloadReport(reports.bhavcopy, { fetchImpl: this.fetchImpl }),
          downloadReport(reports.securityMaster, { fetchImpl: this.fetchImpl }),
        ]);
      }
      const bhavcopySource = this.#sourceMetadata(
        "market.all-reports",
        reports.bhavcopy,
        bhavcopyBytes,
        retrievedAt,
      );
      const securityMasterSource = this.#sourceMetadata(
        "market.security-master",
        reports.securityMaster,
        securityMasterBytes,
        retrievedAt,
      );

      const securityMasterRows = this.#source("market.security-master").parser(
        securityMasterBytes,
      );
      const bhavcopyRows =
        this.#source("market.all-reports").parser(bhavcopyBytes);
      const marketQuotes = this.#source("market.all-reports").normalizer(
        bhavcopyRows,
        reports.tradeDate,
      );
      const preferredSymbolsByIsin = new Map(
        marketQuotes.quotes.map((quote) => [quote.isin, quote.symbol]),
      );
      const securityMaster = this.#source("market.security-master").normalizer(
        securityMasterRows,
        { preferredSymbolsByIsin },
      );
      const reportEnrichment = archive
        ? await enrichArchivedReports({
            files: archive.files,
            securities: securityMaster.securities,
          })
        : null;

      const contentSignature = hashBytes(
        Buffer.from(
          `${datasetSchemaVersion}\n${
            archive
              ? archive.files
                  .map((file) => `${file.sourceUrl}:${file.sha256}`)
                  .sort()
                  .join("\n")
              : `${securityMasterSource.contentHash}:${bhavcopySource.contentHash}`
          }`,
        ),
      );
      const datasetVersion = `${reports.tradeDate}-${contentSignature.slice(0, 16)}`;
      const generatedAt =
        previousMetadata?.datasetVersion === datasetVersion
          ? previousMetadata.generatedAt
          : this.clock().toISOString();
      const dataset = buildNseDataset({
        tradeDate: reports.tradeDate,
        datasetVersion,
        generatedAt,
        securityMaster,
        marketQuotes,
        securityMasterSource,
        bhavcopySource,
        reportEnrichment,
        reportListingSignature,
      });
      const previousDatasetVersion = previousMetadata?.datasetVersion ?? null;
      if (previousDatasetVersion === datasetVersion && activeIndexExists > 0) {
        const refreshedMetadata = {
          ...previousMetadata,
          datasetSchemaVersion,
          reportListingSignature,
        };
        const refreshedPointer = JSON.stringify(refreshedMetadata);
        if (refreshedPointer !== previousMetadataRaw) {
          await this.redisClient.set("nse:eq:dataset:latest", refreshedPointer);
          if (
            (await this.redisClient.get("nse:eq:dataset:latest")) !==
            refreshedPointer
          ) {
            throw new Error(
              "Redis did not confirm the refreshed dataset pointer.",
            );
          }
        }
        return {
          ...refreshedMetadata,
          skipped: true,
          skipReason: "CONTENT_IDENTICAL_TO_ACTIVE_DATASET",
          reportArchive: archive
            ? {
                id: archive.archiveId,
                directory: archive.archiveDirectory,
                manifest: archive.manifestFile,
                reportCount: archive.reportCount,
                totalBytes: archive.totalBytes,
              }
            : null,
          enrichment: {
            status: reportEnrichment?.metadata.status ?? "PARTIAL",
            layer: "CANONICAL_IDENTITY_AND_REPORT_FIELD_ENRICHMENT",
            matchedFiles: reportEnrichment?.metadata.matchedFiles ?? 0,
            fileCount: reportEnrichment?.metadata.fileCount ?? 0,
            matchedRows: reportEnrichment?.metadata.matchedRows ?? 0,
            unmatchedRows: reportEnrichment?.metadata.unmatchedRows ?? 0,
          },
          cacheInvalidation: {
            strategy: "UNCHANGED_CONTENT_VERSION_RETAINED",
            previousDatasetVersion,
            activeDatasetVersion: datasetVersion,
            previousSnapshotsRetained: true,
          },
          sourceRows: {
            securityMaster: securityMasterRows.length,
            bhavcopy: bhavcopyRows.length,
            reportMatched: reportEnrichment?.metadata.matchedRows ?? 0,
          },
        };
      }
      const metadata = await this.publisher.publish(dataset);
      return {
        ...metadata,
        reportArchive: archive
          ? {
              id: archive.archiveId,
              directory: archive.archiveDirectory,
              manifest: archive.manifestFile,
              reportCount: archive.reportCount,
              totalBytes: archive.totalBytes,
            }
          : null,
        enrichment: {
          status: reportEnrichment?.metadata.status ?? "PARTIAL",
          layer: "CANONICAL_IDENTITY_AND_REPORT_FIELD_ENRICHMENT",
          matchedFiles: reportEnrichment?.metadata.matchedFiles ?? 0,
          fileCount: reportEnrichment?.metadata.fileCount ?? 0,
          matchedRows: reportEnrichment?.metadata.matchedRows ?? 0,
          unmatchedRows: reportEnrichment?.metadata.unmatchedRows ?? 0,
        },
        cacheInvalidation: {
          strategy: "VERSIONED_DATASET_POINTER_SWAP",
          previousDatasetVersion,
          activeDatasetVersion: metadata.datasetVersion,
          previousSnapshotsRetained: true,
        },
        sourceRows: {
          securityMaster: securityMasterRows.length,
          bhavcopy: bhavcopyRows.length,
          reportMatched: reportEnrichment?.metadata.matchedRows ?? 0,
        },
      };
    } finally {
      try {
        await this.redisClient.eval(releaseLockScript, {
          keys: [lockKey],
          arguments: [lockValue],
        });
      } catch (error) {
        console.error({
          event: "nse_ingestion_lock_release_failed",
          tradeDate: reports.tradeDate,
          code: error.code ?? "REDIS_ERROR",
        });
      }
    }
  }

  #source(sourceId) {
    const source = this.sources.get(sourceId);
    if (
      !source?.enabled ||
      typeof source.parser !== "function" ||
      typeof source.normalizer !== "function"
    ) {
      throw new Error(
        `NSE source ${sourceId} is not configured for ingestion.`,
      );
    }
    return source;
  }

  #sourceMetadata(sourceId, report, bytes, retrievedAt) {
    const source = this.#source(sourceId);
    return {
      sourceId,
      reportName: source.reportName,
      reportDate: report.tradingDate,
      sourceDocument: report.url,
      contentHash: hashBytes(bytes),
      byteLength: bytes.byteLength,
      retrievedAt,
    };
  }
}

module.exports = { NseIngestionService };
