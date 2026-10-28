"use strict";

const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { gunzipSync, unzipSync } = require("fflate");
const { parse } = require("csv-parse/sync");
const {
  parseVarDatFile,
  parseMtoDatFile,
  parseAppsecCollvalFile,
  parseCsqrFile,
  parseFcmIntrmDatFile,
} = require("./nse-source-mappers");

const projectRoot = path.resolve(__dirname, "../../..");
const maximumExpandedBytes = 40 * 1024 * 1024;
const isinHeaders = new Set(["isin", "isinno", "isincode", "securityisin"]);
const symbolHeaders = new Set([
  "symbol",
  "tckrsymb",
  "tradingsymbol",
  "securitysymbol",
  "ticker",
  "symbolname",
  "nameofsecurity",
  "securityname",
  "secname",
  "scripcode",
]);
const seriesHeaders = new Set(["series", "sctysrs", "securityseries"]);

const nonSecurityFilePatterns = [
  /^Daily_Settlement_Statistics.*\.doc$/i,
  /^circuit_.*\.csv$/i,
  /^CM_Latency_stats.*\.csv$/i,
  /^MA[0-9].*\.csv$/i,
];

function isNonSecurityReport(fileName) {
  return nonSecurityFilePatterns.some((pattern) => pattern.test(fileName));
}

function resolveReportType(fileName, displayName = "") {
  const name = `${fileName} ${displayName}`.toLowerCase();
  if (name.includes("var")) return "VAR";
  if (name.includes("mto") || name.includes("delivery")) return "DELIVERY_POSITION";
  if (name.includes("volt")) return "VOLATILITY";
  if (name.includes("shortselling") || name.includes("short selling")) return "SHORT_SELLING";
  if (name.includes("reg_ind") || name.includes("surveillance")) return "SURVEILLANCE";
  if (name.includes("52_wk") || name.includes("52 week")) return "HIGH_LOW_52_WEEK";
  if (name.includes("bulk")) return "BULK_DEALS";
  if (name.includes("block")) return "BLOCK_DEALS";
  if (name.includes("pe_") || name.includes("pe ratio")) return "PE_RATIO";
  if (name.includes("band") || name.includes("sec_list")) return "PRICE_BAND";
  if (name.includes("collval") || name.includes("haircut") || name.includes("appsec")) return "HAIRCUT";
  if (name.includes("auction") || name.includes("aub_")) return "AUCTION";
  if (name.includes("csqr") || name.includes("close out")) return "CLOSE_OUT";
  if (name.includes("stt")) return "STT";
  if (name.includes("bhavcopy") || name.includes("bhavdata")) return "BHAVCOPY";
  if (name.includes("corpbond")) return "CORPORATE_BOND";
  if (name.includes("series_change")) return "SERIES_CHANGE";
  return "OTHER_SECURITY_REPORT";
}

function normalizeHeader(header) {
  return String(header ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function detectDelimiter(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const sampleLine = lines[0] ?? "";
  const candidates = [",", "|", "\t", ";"];
  return candidates
    .map((delimiter) => ({
      delimiter,
      count: sampleLine.split(delimiter).length - 1,
    }))
    .sort((left, right) => right.count - left.count)[0] ?? { delimiter: ",", count: 0 };
}

function parseDelimited(bytes, sourceName) {
  if (bytes.byteLength > maximumExpandedBytes) {
    throw new Error("Expanded report exceeds the 40 MiB parsing limit.");
  }

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Report is not valid UTF-8 text.");
  }
  const detected = detectDelimiter(text);

  let records;
  try {
    records = parse(text, {
      bom: true,
      columns: false,
      delimiter: detected.delimiter,
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true,
      max_record_size: 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`${sourceName} CSV parse failed: ${error.message}`);
  }

  const headerIndex = records.findIndex(
    (record) =>
      Array.isArray(record) &&
      (record.some((column) => isinHeaders.has(normalizeHeader(column))) ||
        record.some((column) => symbolHeaders.has(normalizeHeader(column)))),
  );
  if (headerIndex < 0) {
    throw new Error("Report has no recognized ISIN or symbol header.");
  }

  const headerRow = records[headerIndex];
  const maxRowLength = Math.max(...records.slice(headerIndex).map((r) => r.length));
  const headerCounts = new Map();
  const columns = [];

  for (let i = 0; i < maxRowLength; i++) {
    const rawColumn = i < headerRow.length ? String(headerRow[i] ?? "").trim() : "";
    const base = rawColumn || `column_${i + 1}`;
    const count = (headerCounts.get(base) ?? 0) + 1;
    headerCounts.set(base, count);
    columns.push(count === 1 ? base : `${base}_${count}`);
  }

  const rows = records
    .slice(headerIndex + 1)
    .map((record) =>
      Object.fromEntries(
        columns.map((column, index) => [
          column,
          String(record[index] ?? "").trim(),
        ]),
      ),
    );
  if (!rows.length) throw new Error("Report contains no data rows.");
  return rows;
}

function parseExplicitFile(fileName, bytes) {
  if (/^C_VAR1_.*\.DAT$/i.test(fileName)) {
    return parseVarDatFile(bytes);
  }
  if (/^MTO_.*\.DAT$/i.test(fileName)) {
    return parseMtoDatFile(bytes);
  }
  if (/^APPSEC_COLLVAL_.*\.csv$/i.test(fileName)) {
    return parseAppsecCollvalFile(bytes);
  }
  if (/^CSQR_.*\.csv$/i.test(fileName)) {
    return parseCsqrFile(bytes);
  }
  if (/^FCM_INTRM_BC.*\.DAT$/i.test(fileName)) {
    return parseFcmIntrmDatFile(bytes);
  }
  return null;
}

function getTabularEntries(bytes, fileName) {
  const lowerName = fileName.toLowerCase();
  if (isNonSecurityReport(fileName)) {
    return [];
  }

  if (lowerName.endsWith(".zip")) {
    let entries;
    try {
      entries = unzipSync(bytes);
    } catch {
      throw new Error("Report is not a valid ZIP archive.");
    }
    const csvEntries = Object.entries(entries).filter(
      ([name]) => !name.endsWith("/") && /\.(csv|dat|txt)$/i.test(name),
    );
    if (!csvEntries.length)
      throw new Error("ZIP contains no tabular text files.");
    return csvEntries.map(([name, data]) => ({ name, bytes: data }));
  }

  if (lowerName.endsWith(".gz")) {
    let data;
    try {
      data = gunzipSync(bytes);
    } catch {
      throw new Error("Report is not a valid GZIP archive.");
    }
    return [{ name: fileName.replace(/\.gz$/i, ""), bytes: data }];
  }

  if (/\.(csv|dat|txt)$/i.test(fileName)) {
    return [{ name: fileName, bytes }];
  }
  return [];
}

function findColumn(columns, candidates) {
  return columns.find((column) => candidates.has(normalizeHeader(column)));
}

function createReportKey(sourceUrl, entryName) {
  const digest = createHash("sha256")
    .update(`${sourceUrl}\n${entryName}`)
    .digest("hex")
    .slice(0, 12);
  const label = path
    .basename(entryName)
    .replace(/\.[^.]+$/, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${label || "report"}-${digest}`;
}

async function enrichArchivedReports({ files, securities }) {
  const securitiesByIsin = new Map(
    securities.map((security) => [security.isin, security]),
  );
  const securitiesBySymbol = new Map(
    securities.map((security) => [security.symbol.toUpperCase(), security]),
  );
  const reportsByIsin = new Map();
  const fileResults = [];
  let matchedRows = 0;
  let unmatchedRows = 0;
  let matchedFiles = 0;

  for (const file of files) {
    const isNonSec = isNonSecurityReport(file.originalFileName);
    const fileResult = {
      displayName: file.displayName,
      sourceFile: file.originalFileName,
      status: isNonSec ? "NON_SECURITY_RAW_ARCHIVED" : "UNPROCESSED",
      isNonSecurity: isNonSec,
      reportType: resolveReportType(file.originalFileName, file.displayName),
      tabularFiles: 0,
      matchedRows: 0,
      unmatchedRows: 0,
    };

    if (isNonSec) {
      fileResult.message = "Market-level or summary document report archived raw without security snapshot enrichment.";
      fileResults.push(fileResult);
      continue;
    }

    try {
      const sourcePath = path.resolve(projectRoot, file.storedFile);
      const bytes = await fs.readFile(sourcePath);
      const tabularEntries = getTabularEntries(bytes, file.originalFileName);

      for (const entry of tabularEntries) {
        let rows = parseExplicitFile(entry.name, entry.bytes);
        if (!rows) {
          rows = parseDelimited(entry.bytes, entry.name);
        }
        if (!rows || !rows.length) continue;

        const columns = Object.keys(rows[0]);
        const isinColumn = findColumn(columns, isinHeaders);
        const symbolColumn = findColumn(columns, symbolHeaders);
        const seriesColumn = findColumn(columns, seriesHeaders);
        if (!isinColumn && !symbolColumn) continue;

        fileResult.tabularFiles += 1;
        const reportKey = createReportKey(file.sourceUrl, entry.name);

        for (const row of rows) {
          const isin = String(row[isinColumn] ?? "")
            .trim()
            .toUpperCase();
          const symbol = String(row[symbolColumn] ?? "")
            .trim()
            .toUpperCase();
          const rowSeries = seriesColumn
            ? String(row[seriesColumn] ?? "").trim().toUpperCase()
            : null;

          const byIsin = isin ? securitiesByIsin.get(isin) : null;
          const bySymbol = symbol ? securitiesBySymbol.get(symbol) : null;
          const security = byIsin || bySymbol;

          if (
            !security ||
            (byIsin && bySymbol && byIsin.isin !== bySymbol.isin)
          ) {
            fileResult.unmatchedRows += 1;
            continue;
          }

          let securityReports = reportsByIsin.get(security.isin);
          if (!securityReports) {
            securityReports = {};
            reportsByIsin.set(security.isin, securityReports);
          }
          let reportData = securityReports[reportKey];
          if (!reportData) {
            reportData = {
              displayName: file.displayName,
              sourceFile: file.originalFileName,
              sourceUrl: file.sourceUrl,
              reportType: fileResult.reportType,
              columns,
              rows: [],
              latestRow: null,
            };
            securityReports[reportKey] = reportData;
          }

          reportData.rows.push(row);
          if (
            !reportData.latestRow ||
            (rowSeries && rowSeries === security.series)
          ) {
            reportData.latestRow = row;
          }
          fileResult.matchedRows += 1;
        }
      }

      if (fileResult.tabularFiles > 0 && fileResult.matchedRows > 0) {
        fileResult.status = "ENRICHED";
        matchedFiles += 1;
      } else if (fileResult.tabularFiles > 0) {
        fileResult.status = "NO_MATCHING_SECURITIES";
      } else {
        fileResult.status = "NO_IDENTITY_COLUMNS";
      }
    } catch (error) {
      fileResult.status = error.message.includes(
        "no recognized ISIN or symbol header",
      )
        ? "NO_IDENTITY_COLUMNS"
        : "UNSUPPORTED_OR_INVALID";
      fileResult.message = error.message;
    }

    matchedRows += fileResult.matchedRows;
    unmatchedRows += fileResult.unmatchedRows;
    fileResults.push(fileResult);
  }

  const securityFiles = fileResults.filter((f) => !f.isNonSecurity);
  const allSecurityEnriched =
    securityFiles.length > 0 &&
    securityFiles.every((f) => f.status === "ENRICHED");

  return {
    reportsByIsin,
    metadata: {
      status: allSecurityEnriched ? "COMPLETE" : "PARTIAL",
      fileCount: fileResults.length,
      securityFileCount: securityFiles.length,
      nonSecurityFileCount: fileResults.length - securityFiles.length,
      matchedFiles,
      matchedRows,
      unmatchedRows,
      files: fileResults,
    },
  };
}

module.exports = { enrichArchivedReports, resolveReportType, isNonSecurityReport };
