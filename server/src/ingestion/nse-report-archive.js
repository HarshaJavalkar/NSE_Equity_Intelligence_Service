const { createHash, randomBytes } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { downloadReport, maxArchiveBytes } = require("./nse-report-discovery");

const projectRoot = path.resolve(__dirname, "../../..");
const maxTotalBytes = 512 * 1024 * 1024;
const downloadConcurrency = 3;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function createRunId(now = new Date()) {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  return `${timestamp}-${randomBytes(4).toString("hex")}`;
}

class NseReportArchive {
  constructor({
    dataRoot = path.join(projectRoot, "server", "assets", "data"),
    fetchImpl = fetch,
  } = {}) {
    this.dataRoot = path.resolve(dataRoot);
    this.fetchImpl = fetchImpl;
  }

  async hasCompleteArchive(tradeDate) {
    const archiveDirectory = path.join(this.dataRoot, `nse-${tradeDate}`);
    let manifest;
    try {
      manifest = JSON.parse(
        await fs.readFile(path.join(archiveDirectory, "manifest.json"), "utf8"),
      );
    } catch {
      return false;
    }
    if (
      manifest.tradeDate !== tradeDate ||
      !Array.isArray(manifest.files) ||
      manifest.reportCount !== manifest.files.length
    ) {
      return false;
    }

    for (const file of manifest.files) {
      const storedPath = path.resolve(projectRoot, file.storedFile ?? "");
      const relativePath = path.relative(archiveDirectory, storedPath);
      if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        return false;
      }
      try {
        const stats = await fs.stat(storedPath);
        if (!stats.isFile() || stats.size !== file.byteLength) return false;
      } catch {
        return false;
      }
    }
    return manifest.files.length > 0;
  }

  async saveReportSet({ tradeDate, reportFiles, pairUrls }) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
      throw new Error("NSE archive trade date is invalid.");
    }
    if (!Array.isArray(reportFiles) || reportFiles.length === 0) {
      throw new Error("NSE report feed returned no downloadable files.");
    }

    const runId = createRunId();
    const archiveName = `nse-${tradeDate}`;
    const archiveDirectory = path.join(this.dataRoot, archiveName);
    const stagingDirectory = path.join(
      this.dataRoot,
      `.${archiveName}.${runId}.staging`,
    );
    const backupDirectory = path.join(
      this.dataRoot,
      `.${archiveName}.${runId}.previous`,
    );
    const pairBytes = new Map();
    const archivedFiles = new Array(reportFiles.length);
    let totalBytes = 0;
    let nextIndex = 0;
    const failures = [];

    await fs.mkdir(this.dataRoot, { recursive: true });
    await fs.mkdir(stagingDirectory);
    const worker = async () => {
      while (nextIndex < reportFiles.length && failures.length === 0) {
        const index = nextIndex++;
        const report = reportFiles[index];
        try {
          const bytes = await downloadReport(report, {
            fetchImpl: this.fetchImpl,
            maxBytes: maxArchiveBytes,
          });
          totalBytes += bytes.byteLength;
          if (totalBytes > maxTotalBytes) {
            throw new Error(
              `NSE report set exceeds the ${maxTotalBytes} byte safety limit.`,
            );
          }

          const digest = sha256(bytes);
          const archiveName = `${sha256(report.url).slice(0, 12)}-${report.fileName}`;
          const destination = path.join(stagingDirectory, archiveName);
          const temporary = `${destination}.${randomBytes(4).toString("hex")}.part`;
          await fs.writeFile(temporary, bytes, { flag: "wx" });
          await fs.rename(temporary, destination);

          archivedFiles[index] = {
            displayName: report.displayName,
            sourceUrl: report.url,
            originalFileName: report.fileName,
            storedFile: path.relative(
              projectRoot,
              path.join(archiveDirectory, archiveName),
            ),
            byteLength: bytes.byteLength,
            sha256: digest,
          };
          if (pairUrls.has(report.url)) pairBytes.set(report.url, bytes);
        } catch (error) {
          failures.push(error);
        }
      }
    };

    try {
      await Promise.all(
        Array.from(
          { length: Math.min(downloadConcurrency, reportFiles.length) },
          () => worker(),
        ),
      );
      if (failures.length) throw failures[0];
      for (const url of pairUrls) {
        if (!pairBytes.has(url)) {
          throw new Error(`Required source file was not archived: ${url}`);
        }
      }

      const manifest = {
        schemaVersion: "1.0",
        source: "NSE All Reports CM daily report feed",
        tradeDate,
        archiveId: runId,
        fetchedAt: new Date().toISOString(),
        replacementPolicy: "COMPLETE_DATE_DIRECTORY_REPLACEMENT",
        reportCount: archivedFiles.length,
        totalBytes,
        files: archivedFiles,
      };
      await fs.writeFile(
        path.join(stagingDirectory, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { flag: "wx" },
      );

      let previousDirectoryMoved = false;
      try {
        await fs.rename(archiveDirectory, backupDirectory);
        previousDirectoryMoved = true;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }

      try {
        await fs.rename(stagingDirectory, archiveDirectory);
      } catch (error) {
        if (previousDirectoryMoved) {
          await fs.rename(backupDirectory, archiveDirectory);
        }
        throw error;
      }
      if (previousDirectoryMoved) {
        await fs.rm(backupDirectory, { recursive: true, force: true });
      }

      return {
        archiveId: runId,
        archiveDirectory: path.relative(projectRoot, archiveDirectory),
        reportCount: archivedFiles.length,
        totalBytes,
        files: archivedFiles,
        manifestFile: path.relative(
          projectRoot,
          path.join(archiveDirectory, "manifest.json"),
        ),
        pairBytes,
      };
    } catch (error) {
      await fs.rm(stagingDirectory, { recursive: true, force: true });
      throw error;
    }
  }
}

module.exports = { NseReportArchive };
