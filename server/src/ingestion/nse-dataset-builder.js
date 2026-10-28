const datasetSchemaVersion = "1.2";

function findReportByType(reports, type) {
  if (!reports) return null;
  for (const rep of Object.values(reports)) {
    if (rep.reportType === type) return rep;
  }
  return null;
}

function findReportByKeyMatch(reports, pattern) {
  if (!reports) return null;
  for (const [key, rep] of Object.entries(reports)) {
    if (
      pattern.test(key) ||
      pattern.test(rep.sourceFile ?? "") ||
      pattern.test(rep.displayName ?? "")
    ) {
      return rep;
    }
  }
  return null;
}

function extractDelivery(reports) {
  const rep =
    findReportByType(reports, "DELIVERY_POSITION") ||
    findReportByKeyMatch(reports, /mto|sec_bhavdata/i);
  if (!rep) return null;
  const row = rep.latestRow || rep.rows?.[0];
  if (!row) return null;
  return {
    quantityTraded:
      Number(row.quantityTraded ?? row.TTL_TRD_QNTY ?? row.TradedQuantity) ||
      null,
    deliverableQuantity:
      Number(row.deliverableQty ?? row.DELIV_QTY ?? row.DeliverableQty) ||
      null,
    deliverablePercent:
      Number(row.deliverablePer ?? row.DELIV_PER ?? row.DeliverablePercent) ||
      null,
  };
}

function extractSurveillance(reports) {
  const rep =
    findReportByType(reports, "SURVEILLANCE") ||
    findReportByKeyMatch(reports, /reg_ind/i);
  if (!rep) return null;
  const row = rep.latestRow || rep.rows?.[0];
  if (!row) return null;
  return {
    status: row.Status || row.status || null,
    gsm: row.GSM || row.gsm || null,
    asm:
      row["Long_Term_Additional_Surveillance_Measure (Long Term ASM)"] ||
      row["Short_Term_Additional_Surveillance_Measure (Short Term ASM)"] ||
      row.asm ||
      null,
    esm: row.ESM || row.esm || null,
  };
}

function extractShortSelling(reports) {
  const rep =
    findReportByType(reports, "SHORT_SELLING") ||
    findReportByKeyMatch(reports, /shortselling/i);
  if (!rep) return null;
  const row = rep.latestRow || rep.rows?.[0];
  if (!row) return null;
  return {
    tradeDate: row["Trade Date"] || row.tradeDate || null,
    quantity: Number(row.Quantity || row.quantity) || null,
  };
}

function extractVolatility(reports) {
  const rep =
    findReportByType(reports, "VOLATILITY") ||
    findReportByKeyMatch(reports, /volt/i);
  if (!rep) return null;
  const row = rep.latestRow || rep.rows?.[0];
  if (!row) return null;
  const dailyKey = Object.keys(row).find((k) =>
    k.includes("Current Day Underlying Daily Volatility"),
  );
  const annualKey = Object.keys(row).find((k) =>
    k.includes("Underlying Annualised Volatility"),
  );
  return {
    dailyVolatility: dailyKey
      ? Number(row[dailyKey]) || null
      : Number(row.dailyVolatility) || null,
    annualizedVolatility: annualKey
      ? Number(row[annualKey]) || null
      : Number(row.annualizedVolatility) || null,
  };
}

function extractPe(reports) {
  const rep =
    findReportByType(reports, "PE_RATIO") ||
    findReportByKeyMatch(reports, /pe_/i);
  if (!rep) return null;
  const row = rep.latestRow || rep.rows?.[0];
  if (!row) return null;
  return {
    symbolPe: Number(row["SYMBOL P/E"] ?? row.symbolPe) || null,
    adjustedPe: Number(row["ADJUSTED P/E"] ?? row.adjustedPe) || null,
  };
}

function extract52Week(reports) {
  const rep =
    findReportByType(reports, "HIGH_LOW_52_WEEK") ||
    findReportByKeyMatch(reports, /52_wk/i);
  if (!rep) return null;
  const row = rep.latestRow || rep.rows?.[0];
  if (!row) return null;
  return {
    adjusted52WeekHigh:
      Number(row.Adjusted_52_Week_High ?? row.adjusted52WeekHigh) || null,
    highDate: row["52_Week_High_Date"] || row.highDate || null,
    adjusted52WeekLow:
      Number(row.Adjusted_52_Week_Low ?? row.adjusted52WeekLow) || null,
    lowDate: row["52_Week_Low_DT"] || row.lowDate || null,
  };
}

function extractPriceBand(reports) {
  const rep =
    findReportByType(reports, "PRICE_BAND") ||
    findReportByKeyMatch(reports, /sec_list|band/i);
  if (!rep) return null;
  const row = rep.latestRow || rep.rows?.[0];
  if (!row) return null;
  return {
    band: row.Band ?? row.band ?? null,
    remarks: row.Remarks ?? row.remarks ?? null,
  };
}

function extractVar(reports) {
  const rep =
    findReportByType(reports, "VAR") ||
    findReportByKeyMatch(reports, /c_var1/i);
  if (!rep) return null;
  const row = rep.latestRow || rep.rows?.[0];
  if (!row) return null;
  return {
    varMarginRate: Number(row.varMarginRate) || null,
    extremeLossRate: Number(row.extremeLossRate) || null,
    applicableMarginRate: Number(row.applicableMarginRate) || null,
  };
}

function extractHaircut(reports) {
  const rep =
    findReportByType(reports, "HAIRCUT") ||
    findReportByKeyMatch(reports, /appsec|collval/i);
  if (!rep) return null;
  const row = rep.latestRow || rep.rows?.[0];
  if (!row) return null;
  return {
    valuationPrice:
      Number(row.valuationPrice ?? row["Valuation Price"]) || null,
    applicableHaircut:
      Number(row.applicableHaircut ?? row["Applicable Haircut"]) || null,
  };
}

function buildNseDataset({
  tradeDate,
  datasetVersion,
  generatedAt,
  securityMaster,
  marketQuotes,
  securityMasterSource,
  bhavcopySource,
  reportEnrichment = null,
  reportListingSignature = null,
}) {
  const securitiesByIsin = new Map(
    securityMaster.securities.map((security) => [security.isin, security]),
  );
  const symbols = new Map();
  for (const security of securityMaster.securities) {
    const existingIsin = symbols.get(security.symbol);
    if (existingIsin && existingIsin !== security.isin) {
      throw new Error(
        `NSE security master maps ${security.symbol} to multiple ISINs.`,
      );
    }
    symbols.set(security.symbol, security.isin);
  }

  const quotesByIsin = new Map();
  const unresolved = [];
  for (const quote of marketQuotes.quotes) {
    const security = securitiesByIsin.get(quote.isin);
    if (!security) {
      unresolved.push({
        isin: quote.isin,
        symbol: quote.symbol,
        reason: "SECURITY_MASTER_MISSING",
      });
      continue;
    }
    if (security.symbol !== quote.symbol) {
      unresolved.push({
        isin: quote.isin,
        symbol: quote.symbol,
        reason: "SYMBOL_MISMATCH",
      });
      continue;
    }
    quotesByIsin.set(quote.isin, quote);
  }

  const status = unresolved.length ? "PARTIAL" : "READY";
  const snapshotEntries = [];
  const symbolIndex = {};
  const searchIndex = {};

  for (const security of securityMaster.securities) {
    const identity = {
      isin: security.isin,
      symbol: security.symbol,
      securityCode: security.securityCode,
      series: security.series,
      companyName: security.companyName,
    };
    const quote = quotesByIsin.get(security.isin);
    const securityReports =
      reportEnrichment?.reportsByIsin.get(security.isin) ?? {};

    const delivery = extractDelivery(securityReports);
    const surveillance = extractSurveillance(securityReports);
    const shortSelling = extractShortSelling(securityReports);
    const volatility = extractVolatility(securityReports);
    const pe = extractPe(securityReports);
    const highLow52Week = extract52Week(securityReports);
    const priceBand = extractPriceBand(securityReports);
    const varData = extractVar(securityReports);
    const haircut = extractHaircut(securityReports);

    const snapshot = {
      schemaVersion: datasetSchemaVersion,
      identity,
      dataset: { datasetVersion, tradeDate, generatedAt, status },
      provenance: {
        securityMaster: securityMasterSource,
        ...(quote ? { market: bhavcopySource } : {}),
      },
      reports: securityReports,
    };

    if (
      quote ||
      delivery ||
      surveillance ||
      shortSelling ||
      volatility ||
      pe ||
      highLow52Week ||
      priceBand ||
      varData ||
      haircut
    ) {
      snapshot.market = {
        sourceDate: quote?.tradeDate ?? tradeDate,
        freshnessStatus: quote?.freshness ?? "END_OF_DAY",
        price: quote?.price ?? null,
        volume: quote?.volume ?? null,
        ...(delivery ? { delivery } : {}),
        ...(surveillance ? { surveillance } : {}),
        ...(shortSelling ? { shortSelling } : {}),
        ...(volatility ? { volatility } : {}),
        ...(pe ? { pe } : {}),
        ...(highLow52Week ? { highLow52Week } : {}),
        ...(priceBand ? { priceBand } : {}),
        ...(varData ? { var: varData } : {}),
        ...(haircut ? { haircut } : {}),
      };
    }

    snapshotEntries.push([security.isin, snapshot]);
    symbolIndex[security.symbol] = security.isin;
    const searchField =
      `${security.symbol} ${security.companyName ?? ""} ${security.isin}`
        .trim()
        .toUpperCase();
    searchIndex[searchField] = JSON.stringify(identity);
  }

  const metadata = {
    datasetSchemaVersion,
    datasetVersion,
    tradeDate,
    status,
    generatedAt,
    securityCount: snapshotEntries.length,
    marketQuoteCount: quotesByIsin.size,
    unresolvedIdentityCount: unresolved.length,
    unresolvedIdentityExamples: unresolved.slice(0, 20),
    excludedSecurityMasterEquityRows: securityMaster.excludedEquityRows,
    excludedBhavcopyEquityRows: marketQuotes.excludedEquityRows,
    sources: { securityMaster: securityMasterSource, bhavcopy: bhavcopySource },
    reportListingSignature,
    reportEnrichment: reportEnrichment?.metadata ?? {
      status: "NOT_RUN",
      fileCount: 0,
      matchedFiles: 0,
      matchedRows: 0,
      unmatchedRows: 0,
      files: [],
    },
  };

  return { metadata, snapshotEntries, symbolIndex, searchIndex };
}

module.exports = { buildNseDataset, datasetSchemaVersion };
