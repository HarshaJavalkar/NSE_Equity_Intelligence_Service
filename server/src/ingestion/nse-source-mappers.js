const { gunzipSync, unzipSync } = require("fflate");
const { parse } = require("csv-parse/sync");

const securityMasterColumns = [
  "FinInstrmId",
  "TckrSymb",
  "SctySrs",
  "FinInstrmNm",
  "ISIN",
  "DelFlg",
  "UpdDt",
];
const udiFfColumns = [
  "TradDt",
  "FinInstrmTp",
  "ISIN",
  "TckrSymb",
  "SctySrs",
  "OpnPric",
  "HghPric",
  "LwPric",
  "ClsPric",
  "LastPric",
  "PrvsClsgPric",
  "TtlTradgVol",
  "TtlTrfVal",
  "TtlNbOfTxsExctd",
];
const equityIsinPattern = /^INE[A-Z0-9]{9}$/;

function parseCsv(bytes, requiredColumns, sourceName) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${sourceName} is not valid UTF-8.`);
  }

  let records;
  try {
    records = parse(text, {
      bom: true,
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
  } catch (error) {
    throw new Error(`${sourceName} CSV parse failed: ${error.message}`);
  }

  if (!records.length)
    throw new Error(`${sourceName} CSV contains no records.`);
  const availableColumns = Object.keys(records[0]);
  const missingColumns = requiredColumns.filter(
    (column) => !availableColumns.includes(column),
  );
  if (missingColumns.length) {
    throw new Error(
      `${sourceName} CSV schema is missing: ${missingColumns.join(", ")}.`,
    );
  }
  return records;
}

function parseSecurityMasterFile(compressedBytes) {
  let csvBytes;
  try {
    csvBytes = gunzipSync(compressedBytes);
  } catch {
    throw new Error("NSE security master is not a valid GZIP archive.");
  }
  if (csvBytes.byteLength > 40 * 1024 * 1024) {
    throw new Error("NSE security master expands beyond the 40 MiB limit.");
  }
  return parseCsv(csvBytes, securityMasterColumns, "NSE security master");
}

function parseUdiFfBhavcopyFile(compressedBytes) {
  let entries;
  try {
    entries = unzipSync(compressedBytes);
  } catch {
    throw new Error("NSE UDiFF bhavcopy is not a valid ZIP archive.");
  }
  const csvFiles = Object.entries(entries).filter(([name]) =>
    name.toLowerCase().endsWith(".csv"),
  );
  if (csvFiles.length !== 1) {
    throw new Error("NSE UDiFF archive must contain exactly one CSV file.");
  }
  const [fileName, csvBytes] = csvFiles[0];
  if (
    fileName.includes("..") ||
    fileName.includes("/") ||
    fileName.includes("\\")
  ) {
    throw new Error("NSE UDiFF archive contains an unsafe entry name.");
  }
  if (csvBytes.byteLength > 40 * 1024 * 1024) {
    throw new Error("NSE UDiFF CSV expands beyond the 40 MiB limit.");
  }
  return parseCsv(csvBytes, udiFfColumns, "NSE UDiFF bhavcopy");
}

function normalizeSecurityMasterRows(
  rows,
  { minimumSecurities = 1000, preferredSymbolsByIsin = new Map() } = {},
) {
  const candidatesByIsin = new Map();
  let excludedEquityRows = 0;

  for (const row of rows) {
    if (row.SctySrs !== "EQ" || row.DelFlg !== "N") continue;
    const isin = (row.ISIN ?? "").toUpperCase();
    const symbol = (row.TckrSymb ?? "").toUpperCase();
    if (!equityIsinPattern.test(isin) || !symbol) {
      excludedEquityRows += 1;
      continue;
    }

    const security = {
      isin,
      symbol,
      securityCode: row.FinInstrmId || null,
      series: row.SctySrs,
      companyName: row.FinInstrmNm?.trim() || null,
      updatedAt: Number.isFinite(Number(row.UpdDt)) ? Number(row.UpdDt) : 0,
    };
    const candidates = candidatesByIsin.get(isin) ?? [];
    candidates.push(security);
    candidatesByIsin.set(isin, candidates);
  }

  const securities = [];
  for (const [isin, candidates] of candidatesByIsin) {
    const preferredSymbol = preferredSymbolsByIsin.get(isin);
    const matchingQuote = preferredSymbol
      ? candidates.filter((candidate) => candidate.symbol === preferredSymbol)
      : [];
    const candidatesToResolve = matchingQuote.length
      ? matchingQuote
      : candidates;
    const newestUpdate = Math.max(
      ...candidatesToResolve.map((row) => row.updatedAt),
    );
    const newestCandidates = candidatesToResolve.filter(
      (row) => row.updatedAt === newestUpdate,
    );
    const identities = new Set(
      newestCandidates.map(
        (row) => `${row.symbol}\u0000${row.companyName ?? ""}`,
      ),
    );
    if (identities.size !== 1) {
      throw new Error(
        `NSE security master has unresolved identity for ${isin}.`,
      );
    }
    newestCandidates.sort((left, right) =>
      (left.securityCode ?? "").localeCompare(right.securityCode ?? ""),
    );
    const { updatedAt, ...security } = newestCandidates[0];
    securities.push(security);
  }

  if (securities.length < minimumSecurities) {
    throw new Error(
      `NSE security master contains too few validated EQ securities (${securities.length}).`,
    );
  }
  return { securities, excludedEquityRows };
}

function parseNullableNumber(value, field, isin) {
  if (value === undefined || value === null || value.trim() === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`NSE bhavcopy has an invalid ${field} for ${isin}.`);
  }
  return number;
}

function normalizeUdiFfRows(
  rows,
  expectedTradeDate,
  { minimumQuotes = 1000 } = {},
) {
  const quotes = new Map();
  let excludedEquityRows = 0;

  for (const row of rows) {
    if (row.FinInstrmTp !== "STK" || row.SctySrs !== "EQ") continue;
    const isin = (row.ISIN ?? "").toUpperCase();
    const symbol = (row.TckrSymb ?? "").toUpperCase();
    if (
      !equityIsinPattern.test(isin) ||
      !symbol ||
      row.TradDt !== expectedTradeDate
    ) {
      excludedEquityRows += 1;
      continue;
    }

    const quote = {
      isin,
      symbol,
      tradeDate: row.TradDt,
      price: {
        open: parseNullableNumber(row.OpnPric, "OpnPric", isin),
        high: parseNullableNumber(row.HghPric, "HghPric", isin),
        low: parseNullableNumber(row.LwPric, "LwPric", isin),
        close: parseNullableNumber(row.ClsPric, "ClsPric", isin),
        last: parseNullableNumber(row.LastPric, "LastPric", isin),
        previousClose: parseNullableNumber(
          row.PrvsClsgPric,
          "PrvsClsgPric",
          isin,
        ),
      },
      volume: {
        traded: parseNullableNumber(row.TtlTradgVol, "TtlTradgVol", isin),
        turnover: parseNullableNumber(row.TtlTrfVal, "TtlTrfVal", isin),
        transactions: parseNullableNumber(
          row.TtlNbOfTxsExctd,
          "TtlNbOfTxsExctd",
          isin,
        ),
      },
      freshness: "END_OF_DAY",
    };

    if (quotes.has(isin)) {
      throw new Error(
        `NSE UDiFF bhavcopy contains duplicate EQ rows for ${isin}.`,
      );
    }
    quotes.set(isin, quote);
  }

  if (quotes.size < minimumQuotes) {
    throw new Error(
      `NSE UDiFF bhavcopy contains too few validated EQ rows (${quotes.size}).`,
    );
  }
  return { quotes: [...quotes.values()], excludedEquityRows };
}

function parseVarDatFile(bytes) {
  const text = new TextDecoder("utf-8").decode(bytes);
  const lines = text.split(/\r?\n/);
  const rows = [];
  const varColumns = [
    "recordType",
    "symbol",
    "series",
    "isin",
    "securityVaR",
    "indexVaR",
    "varMarginRate",
    "extremeLossRate",
    "applicableMarginRate",
    "additionalMarginRate",
  ];
  for (const line of lines) {
    if (!line.startsWith("20,")) continue;
    const parts = line.split(",").map((s) => s.trim());
    if (parts.length < 9) continue;
    const row = {};
    for (let i = 0; i < varColumns.length && i < parts.length; i++) {
      row[varColumns[i]] = parts[i];
    }
    rows.push(row);
  }
  return rows;
}

function normalizeVarRows(rows) {
  const byIsin = new Map();
  for (const row of rows) {
    const isin = (row.isin ?? "").toUpperCase();
    if (!equityIsinPattern.test(isin)) continue;
    byIsin.set(isin, {
      isin,
      symbol: row.symbol?.toUpperCase(),
      series: row.series,
      securityVaR: Number(row.securityVaR) || 0,
      indexVaR: Number(row.indexVaR) || 0,
      varMarginRate: Number(row.varMarginRate) || 0,
      extremeLossRate: Number(row.extremeLossRate) || 0,
      applicableMarginRate: Number(row.applicableMarginRate) || 0,
    });
  }
  return [...byIsin.values()];
}

function parseMtoDatFile(bytes) {
  const text = new TextDecoder("utf-8").decode(bytes);
  const lines = text.split(/\r?\n/);
  const rows = [];
  const mtoColumns = [
    "recordType",
    "srNo",
    "symbol",
    "series",
    "quantityTraded",
    "deliverableQty",
    "deliverablePer",
  ];
  for (const line of lines) {
    if (!line.startsWith("20,")) continue;
    const parts = line.split(",").map((s) => s.trim());
    if (parts.length < 7) continue;
    const row = {};
    for (let i = 0; i < mtoColumns.length && i < parts.length; i++) {
      row[mtoColumns[i]] = parts[i];
    }
    rows.push(row);
  }
  return rows;
}

function normalizeMtoRows(rows) {
  const bySymbol = new Map();
  for (const row of rows) {
    if (row.series !== "EQ") continue;
    const symbol = (row.symbol ?? "").toUpperCase();
    if (!symbol) continue;
    bySymbol.set(symbol, {
      symbol,
      series: row.series,
      quantityTraded: Number(row.quantityTraded) || 0,
      deliverableQty: Number(row.deliverableQty) || 0,
      deliverablePer: Number(row.deliverablePer) || 0,
    });
  }
  return [...bySymbol.values()];
}

function parseAppsecCollvalFile(bytes) {
  const text = new TextDecoder("utf-8").decode(bytes);
  const lines = text.split(/\r?\n/);
  const rows = [];
  const columns = [
    "srNo",
    "symbol",
    "isin",
    "valuationPrice",
    "applicableHaircut",
  ];
  for (const line of lines) {
    const parts = line.split(",").map((s) => s.trim());
    if (parts.length < 5) continue;
    const row = {};
    for (let i = 0; i < columns.length; i++) {
      row[columns[i]] = parts[i];
    }
    rows.push(row);
  }
  return rows;
}

function parseCsqrFile(bytes) {
  const text = new TextDecoder("utf-8").decode(bytes);
  const lines = text.split(/\r?\n/);
  const rows = [];
  const columns = ["symbol", "series", "market", "settlement", "closeOutPrice"];
  for (const line of lines) {
    const parts = line.split(",").map((s) => s.trim());
    if (parts.length < 5) continue;
    const row = {};
    for (let i = 0; i < columns.length; i++) {
      row[columns[i]] = parts[i];
    }
    rows.push(row);
  }
  return rows;
}

function parseFcmIntrmDatFile(bytes) {
  const text = new TextDecoder("utf-8").decode(bytes);
  const lines = text.split(/\r?\n/);
  const rows = [];
  const columns = [
    "securityName",
    "symbol",
    "series",
    "delFlg",
    "openPrice",
    "highPrice",
    "lowPrice",
    "closePrice",
    "lastPrice",
    "prevClosePrice",
    "trdQty",
    "trdVal",
    "trdTrades",
    "filler",
    "tradeDate",
    "filler2",
    "avgPrice",
  ];
  for (const line of lines) {
    const parts = line.split(",").map((s) => s.trim());
    if (parts.length < 15) continue;
    const row = {};
    for (let i = 0; i < columns.length && i < parts.length; i++) {
      row[columns[i]] = parts[i];
    }
    rows.push(row);
  }
  return rows;
}

function parseShortSellingFile(bytes) {
  return parseCsv(bytes, ["Security Name", "Symbol Name", "Trade Date", "Quantity"], "NSE Short Selling");
}

function normalizeShortSellingRows(rows) {
  return rows.map((row) => ({
    symbol: row["Symbol Name"]?.trim().toUpperCase(),
    securityName: row["Security Name"]?.trim(),
    tradeDate: row["Trade Date"]?.trim(),
    quantity: Number(row.Quantity) || 0,
  }));
}

function parseSurveillanceFile(bytes) {
  return parseCsv(bytes, ["Symbol", "Series"], "NSE Surveillance Indicator");
}

function normalizeSurveillanceRows(rows) {
  return rows
    .filter((row) => row.Series === "EQ" || !row.Series)
    .map((row) => ({
      symbol: row.Symbol?.trim().toUpperCase(),
      series: row.Series?.trim(),
      status: row.Status?.trim(),
      gsm: row.GSM?.trim(),
      asm: (row["Long_Term_Additional_Surveillance_Measure (Long Term ASM)"] || row["Short_Term_Additional_Surveillance_Measure (Short Term ASM)"])?.trim(),
      esm: row.ESM?.trim(),
    }));
}

function parse52WeekHighLowFile(bytes) {
  const text = new TextDecoder("utf-8").decode(bytes);
  const lines = text.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => l.includes("SYMBOL") && l.includes("Adjusted_52_Week_High"));
  if (headerIdx < 0) throw new Error("NSE 52 Week High Low header not found.");
  const csvText = lines.slice(headerIdx).join("\n");
  const records = parse(csvText, {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
  return records;
}

function normalize52WeekHighLowRows(rows) {
  return rows
    .filter((row) => row.SERIES === "EQ")
    .map((row) => ({
      symbol: row.SYMBOL?.trim().toUpperCase(),
      series: row.SERIES?.trim(),
      adjusted52WeekHigh: Number(row.Adjusted_52_Week_High?.trim()) || null,
      highDate: row["52_Week_High_Date"]?.trim() || null,
      adjusted52WeekLow: Number(row.Adjusted_52_Week_Low?.trim()) || null,
      lowDate: row["52_Week_Low_DT"]?.trim() || null,
    }));
}

function parsePeFile(bytes) {
  return parseCsv(bytes, ["SYMBOL", "SYMBOL P/E", "ADJUSTED P/E"], "NSE PE Ratio");
}

function normalizePeRows(rows) {
  return rows.map((row) => ({
    symbol: row.SYMBOL?.trim().toUpperCase(),
    symbolPe: Number(row["SYMBOL P/E"]) || null,
    adjustedPe: Number(row["ADJUSTED P/E"]) || null,
  }));
}

function parseDailyVolatilityFile(bytes) {
  return parseCsv(bytes, ["Symbol", "Date"], "NSE Daily Volatility");
}

function normalizeDailyVolatilityRows(rows) {
  return rows.map((row) => {
    const dailyVoltKey = Object.keys(row).find((k) => k.includes("Current Day Underlying Daily Volatility"));
    const annualVoltKey = Object.keys(row).find((k) => k.includes("Underlying Annualised Volatility"));
    return {
      symbol: row.Symbol?.trim().toUpperCase(),
      date: row.Date?.trim(),
      dailyVolatility: dailyVoltKey ? Number(row[dailyVoltKey]) || 0 : 0,
      annualizedVolatility: annualVoltKey ? Number(row[annualVoltKey]) || 0 : 0,
    };
  });
}

module.exports = {
  equityIsinPattern,
  normalizeSecurityMasterRows,
  normalizeUdiFfRows,
  parseSecurityMasterFile,
  parseUdiFfBhavcopyFile,
  parseVarDatFile,
  normalizeVarRows,
  parseMtoDatFile,
  normalizeMtoRows,
  parseAppsecCollvalFile,
  parseCsqrFile,
  parseFcmIntrmDatFile,
  parseShortSellingFile,
  normalizeShortSellingRows,
  parseSurveillanceFile,
  normalizeSurveillanceRows,
  parse52WeekHighLowFile,
  normalize52WeekHighLowRows,
  parsePeFile,
  normalizePeRows,
  parseDailyVolatilityFile,
  normalizeDailyVolatilityRows,
};
