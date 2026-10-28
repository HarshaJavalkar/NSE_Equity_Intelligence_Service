const { nseSourceSchema } = require("../schemas/nse-source-schema");
const {
  normalizeSecurityMasterRows,
  normalizeUdiFfRows,
  parseSecurityMasterFile,
  parseUdiFfBhavcopyFile,
  parseSurveillanceFile,
  normalizeSurveillanceRows,
  parseShortSellingFile,
  normalizeShortSellingRows,
  parse52WeekHighLowFile,
  normalize52WeekHighLowRows,
  parseMtoDatFile,
  normalizeMtoRows,
} = require("../ingestion/nse-source-mappers");

const sourceRegistry = [
  {
    id: "market.all-reports",
    category: "MARKET_EOD",
    officialPage: "https://www.nseindia.com/all-reports",
    discoveryMethod:
      "Read the official All Reports page's UI-backed daily-reports feed and follow its reported archive path and filename; do not synthesize dated URLs.",
    reportName: "CM-UDiFF Common Bhavcopy Final",
    frequency: "TRADING_DAY",
    expectedFormat: "ZIP containing one UDiFF CSV file",
    dateParameter: null,
    parser: parseUdiFfBhavcopyFile,
    normalizer: normalizeUdiFfRows,
    enabled: true,
    verificationStatus: "LIVE_REPORT_PAIR_AND_CSV_COLUMNS_VERIFIED_2026-10-08",
  },
  {
    id: "market.security-master",
    category: "SECURITY_MASTER",
    officialPage: "https://www.nseindia.com/all-reports",
    discoveryMethod:
      "Read the official All Reports page's UI-backed daily-reports feed and follow its reported archive path and filename; do not synthesize dated URLs.",
    reportName: "CM - MII - Security File (NSE Listed securities)",
    frequency: "TRADING_DAY",
    expectedFormat: "CSV_GZIP (page listing; schema unverified)",
    dateParameter: null,
    parser: parseSecurityMasterFile,
    normalizer: normalizeSecurityMasterRows,
    enabled: true,
    verificationStatus: "LIVE_REPORT_PAIR_AND_CSV_COLUMNS_VERIFIED_2026-10-08",
  },
  {
    id: "market.surveillance-indicator",
    category: "SURVEILLANCE",
    officialPage: "https://www.nseindia.com/all-reports",
    discoveryMethod:
      "Read the official All Reports page and follow its current report listing; do not construct download URLs.",
    reportName: "Surveillance Indicator",
    frequency: "TRADING_DAY",
    expectedFormat: "CSV (page listing; schema unverified)",
    dateParameter: null,
    parser: parseSurveillanceFile,
    normalizer: normalizeSurveillanceRows,
    enabled: true,
    verificationStatus: "LIVE_REPORT_AND_COLUMNS_VERIFIED_2026-10-10",
  },
  {
    id: "market.surveillance-indicator-new",
    category: "SURVEILLANCE",
    officialPage: "https://www.nseindia.com/all-reports",
    discoveryMethod:
      "Read the official All Reports page and follow its current report listing; do not construct download URLs.",
    reportName: "Surveillance Indicator New",
    frequency: "TRADING_DAY",
    expectedFormat: "CSV (page listing; schema unverified)",
    dateParameter: null,
    parser: parseSurveillanceFile,
    normalizer: normalizeSurveillanceRows,
    enabled: true,
    verificationStatus: "LIVE_REPORT_AND_COLUMNS_VERIFIED_2026-10-10",
  },
  {
    id: "market.short-selling",
    category: "MARKET_EOD",
    officialPage: "https://www.nseindia.com/all-reports",
    discoveryMethod:
      "Read the official All Reports page and follow its current report listing; do not construct download URLs.",
    reportName: "Short Selling",
    frequency: "TRADING_DAY",
    expectedFormat: "CSV (page listing; schema unverified)",
    dateParameter: null,
    parser: parseShortSellingFile,
    normalizer: normalizeShortSellingRows,
    enabled: true,
    verificationStatus: "LIVE_REPORT_AND_COLUMNS_VERIFIED_2026-10-10",
  },
  {
    id: "filings.corporate-actions",
    category: "CORPORATE_ACTIONS",
    officialPage:
      "https://www.nseindia.com/companies-listing/corporate-filings-actions",
    discoveryMethod:
      "Read the official corporate actions page and follow its current UI-provided export or record links.",
    reportName: "Corporate Actions",
    frequency: "EVENT_DRIVEN",
    expectedFormat:
      "HTML listing and CSV export are exposed by the page; export schema unverified",
    dateParameter: null,
    parser: null,
    normalizer: null,
    enabled: false,
    verificationStatus:
      "PAGE_OBSERVED_EXPORT_SCHEMA_AND_DISCOVERY_REQUIRE_VERIFICATION",
  },
  {
    id: "filings.announcements",
    category: "ANNOUNCEMENTS",
    officialPage:
      "https://www.nseindia.com/companies-listing/corporate-filings-announcements",
    discoveryMethod:
      "Read the official announcements page and follow its current UI-provided record and attachment links.",
    reportName: "Announcements",
    frequency: "EVENT_DRIVEN",
    expectedFormat: "HTML listing; record and attachment schemas unverified",
    dateParameter: null,
    parser: null,
    normalizer: null,
    enabled: false,
    verificationStatus:
      "PAGE_OBSERVED_RECORD_SCHEMA_AND_DISCOVERY_REQUIRE_VERIFICATION",
  },
  {
    id: "filings.financial-results",
    category: "FINANCIAL_RESULTS",
    officialPage:
      "https://www.nseindia.com/companies-listing/corporate-filings-financial-results",
    discoveryMethod:
      "Read the official financial results page and follow its current UI-provided record and document links.",
    reportName: "Financial Results",
    frequency: "EVENT_DRIVEN",
    expectedFormat: null,
    dateParameter: null,
    parser: null,
    normalizer: null,
    enabled: false,
    verificationStatus:
      "OFFICIAL_PAGE_LINK_CONFIRMED_CONTENT_AND_SCHEMA_REQUIRE_VERIFICATION",
  },
  {
    id: "filings.integrated-financials",
    category: "INTEGRATED_FILINGS",
    officialPage:
      "https://www.nseindia.com/companies-listing/corporate-integrated-filing?integratedType=integratedfilingfinancials",
    discoveryMethod:
      "Read the official integrated filing financials page and follow its current UI-provided record and document links.",
    reportName: "Integrated Filing - Financials",
    frequency: "EVENT_DRIVEN",
    expectedFormat:
      "HTML listing with details and attachment references; document schema unverified",
    dateParameter: null,
    parser: null,
    normalizer: null,
    enabled: false,
    verificationStatus:
      "PAGE_AND_RECORD_CATEGORIES_OBSERVED_DOCUMENT_SCHEMA_UNVERIFIED",
  },
  {
    id: "market.high-low-52-week",
    category: "MARKET_EOD",
    officialPage: "https://www.nseindia.com/all-reports",
    discoveryMethod:
      "Resolve the current report name and link from the official All Reports page at runtime.",
    reportName: "52 Week High Low Report",
    frequency: "TRADING_DAY",
    expectedFormat: "CSV",
    dateParameter: null,
    parser: parse52WeekHighLowFile,
    normalizer: normalize52WeekHighLowRows,
    enabled: true,
    verificationStatus: "LIVE_REPORT_AND_COLUMNS_VERIFIED_2026-10-10",
  },
  {
    id: "market.delivery-positions",
    category: "MARKET_EOD",
    officialPage: "https://www.nseindia.com/all-reports",
    discoveryMethod:
      "Resolve the current report name and link from the official All Reports page at runtime.",
    reportName: "Security-wise Delivery Positions",
    frequency: "TRADING_DAY",
    expectedFormat: "DAT",
    dateParameter: null,
    parser: parseMtoDatFile,
    normalizer: normalizeMtoRows,
    enabled: true,
    verificationStatus: "LIVE_REPORT_AND_COLUMNS_VERIFIED_2026-10-10",
  },
  {
    id: "market.margin-trading-disclosure",
    category: "MARKET_EOD",
    officialPage: "https://www.nseindia.com/all-reports",
    discoveryMethod:
      "Resolve the current report name and link from the official All Reports page at runtime.",
    reportName: "CM Margin Trading Disclosure",
    frequency: "TRADING_DAY",
    expectedFormat: null,
    dateParameter: null,
    parser: null,
    normalizer: null,
    enabled: false,
    verificationStatus:
      "REPORT_LISTING_AND_FILE_SCHEMA_REQUIRE_RUNTIME_VERIFICATION",
  },
  {
    id: "filings.announcements-xbrl",
    category: "XBRL",
    officialPage:
      "https://www.nseindia.com/companies-listing/corporate-filings-announcements-xbrl",
    discoveryMethod:
      "Read the official announcements XBRL page and follow its current UI-provided record links.",
    reportName: "Announcements XBRL",
    frequency: "EVENT_DRIVEN",
    expectedFormat: null,
    dateParameter: null,
    parser: null,
    normalizer: null,
    enabled: false,
    verificationStatus:
      "OFFICIAL_PAGE_LINK_CONFIRMED_CONTENT_AND_SCHEMA_REQUIRE_VERIFICATION",
  },
  {
    id: "filings.integrated-governance",
    category: "INTEGRATED_FILINGS",
    officialPage:
      "https://www.nseindia.com/companies-listing/corporate-integrated-filing?integratedType=integratedfilinggovernance",
    discoveryMethod:
      "Read the official integrated filing governance page and follow its current UI-provided records.",
    reportName: "Integrated Filing - Governance",
    frequency: "EVENT_DRIVEN",
    expectedFormat: null,
    dateParameter: null,
    parser: null,
    normalizer: null,
    enabled: false,
    verificationStatus:
      "OFFICIAL_PAGE_LINK_CONFIRMED_CONTENT_AND_SCHEMA_REQUIRE_VERIFICATION",
  },
  {
    id: "filings.xbrl-information",
    category: "XBRL",
    officialPage: "https://www.nseindia.com/companies-listing/xbrl-information",
    discoveryMethod:
      "Read the official NSE XBRL information page for filing references and taxonomy discovery.",
    reportName: "XBRL Filing Information and Taxonomies",
    frequency: "ON_CHANGE",
    expectedFormat: null,
    dateParameter: null,
    parser: null,
    normalizer: null,
    enabled: false,
    verificationStatus:
      "OFFICIAL_LINK_OBSERVED_CONTENT_AND_TAXONOMY_SCHEMA_REQUIRE_VERIFICATION",
  },
];

const validatedSources = sourceRegistry.map((source) =>
  nseSourceSchema.parse(source),
);
const sourceIds = new Set();

for (const source of validatedSources) {
  if (sourceIds.has(source.id)) {
    throw new Error(`Duplicate NSE source id: ${source.id}`);
  }
  sourceIds.add(source.id);
}

module.exports = Object.freeze(
  validatedSources.map((source) => Object.freeze(source)),
);
