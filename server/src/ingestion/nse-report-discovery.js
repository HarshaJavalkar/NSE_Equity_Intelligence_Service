const reportPageUrl = "https://www.nseindia.com/all-reports";
const dailyReportsUrl = "https://www.nseindia.com/api/daily-reports?key=CM";
const archiveHost = "nsearchives.nseindia.com";
const maxFeedBytes = 4 * 1024 * 1024;
const maxArchiveBytes = 100 * 1024 * 1024;
const maxReportCount = 200;
const monthNumber = new Map(
  [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ].map((month, index) => [
    month.toLowerCase(),
    String(index + 1).padStart(2, "0"),
  ]),
);

async function readResponse(response, limitBytes, description) {
  if (!response.ok) {
    throw new Error(`${description} returned HTTP ${response.status}.`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
    throw new Error(`${description} exceeds the ${limitBytes} byte limit.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > limitBytes) {
    throw new Error(`${description} exceeds the ${limitBytes} byte limit.`);
  }
  return bytes;
}

function toIsoTradeDate(value) {
  const match = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(value ?? "");
  if (!match)
    throw new Error(`NSE report has an invalid trading date: ${value}.`);
  const month = monthNumber.get(match[2].toLowerCase());
  if (!month)
    throw new Error(`NSE report has an invalid trading date: ${value}.`);
  return `${match[3]}-${month}-${match[1]}`;
}

function findReportPair(feed) {
  if (
    !feed ||
    !Array.isArray(feed.PreviousDay) ||
    !Array.isArray(feed.CurrentDay)
  ) {
    throw new Error("NSE daily-reports response has an unexpected shape.");
  }
  const reportGroups = [
    feed.PreviousDay,
    feed.CurrentDay,
    ...(Array.isArray(feed.FutureDay) ? [feed.FutureDay] : []),
  ];
  const reports = new Map();
  const securityMasters = new Map();

  for (const group of reportGroups) {
    for (const item of group) {
      const displayName = item.displayName?.trim() ?? "";
      const isBhavcopy = /^CM-UDiFF Common Bhavcopy Final(?:\s|$)/i.test(
        displayName,
      );
      const isSecurityMaster =
        /^CM - MII - Security File \(\.gz\) \(NSE Listed securities\)$/i.test(
          displayName,
        );
      if (!isBhavcopy && !isSecurityMaster) continue;
      const date = toIsoTradeDate(item.tradingDate);
      const target = isBhavcopy ? reports : securityMasters;
      if (target.has(date)) {
        throw new Error(
          `NSE report listing has duplicate source entries for ${date}.`,
        );
      }
      target.set(date, item);
    }
  }

  const commonDates = [...reports.keys()]
    .filter((date) => securityMasters.has(date))
    .sort()
    .reverse();
  if (!commonDates.length) {
    throw new Error(
      "NSE has not published a matching bhavcopy/security-master pair.",
    );
  }

  const tradeDate = commonDates[0];
  const reportFilesByUrl = new Map();
  for (const group of reportGroups) {
    for (const item of group) {
      if (!item.fileActlName || !item.filePath || !item.tradingDate) continue;
      if (toIsoTradeDate(item.tradingDate) !== tradeDate) continue;
      const report = validateReportFile(item);
      reportFilesByUrl.set(report.url, report);
    }
  }
  const reportFiles = [...reportFilesByUrl.values()];
  if (reportFiles.length > maxReportCount) {
    throw new Error(
      `NSE listed ${reportFiles.length} reports; the ${maxReportCount} report safety limit was exceeded.`,
    );
  }
  return {
    tradeDate,
    bhavcopy: validateReportFile(reports.get(tradeDate), "zip"),
    securityMaster: validateReportFile(securityMasters.get(tradeDate), "gz"),
    reportFiles,
  };
}

function validateReportFile(report, expectedExtension = null) {
  const fileName = report.fileActlName;
  if (
    typeof fileName !== "string" ||
    !/^[A-Za-z0-9_.() -]{1,200}$/.test(fileName) ||
    fileName.includes("..") ||
    (expectedExtension &&
      !fileName.toLowerCase().endsWith(`.${expectedExtension}`))
  ) {
    throw new Error("NSE report listing contains an invalid archive filename.");
  }
  const baseUrl = new URL(report.filePath);
  baseUrl.pathname = baseUrl.pathname.replace(/\/{2,}/g, "/");
  const allowedArchivePath = [
    "/content/",
    "/archives/",
    "/products/content/",
    "/sme/content/",
  ].some((prefix) => baseUrl.pathname.startsWith(prefix));
  if (
    baseUrl.protocol !== "https:" ||
    baseUrl.hostname !== archiveHost ||
    !allowedArchivePath ||
    !/^\/[A-Za-z0-9_./-]+\/$/.test(
      baseUrl.pathname.endsWith("/")
        ? baseUrl.pathname
        : `${baseUrl.pathname}/`,
    )
  ) {
    throw new Error(
      "NSE report listing contains an unapproved archive location.",
    );
  }
  if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname += "/";
  const url = new URL(fileName, baseUrl);
  if (url.origin !== baseUrl.origin || !url.pathname.startsWith(baseUrl.pathname)) {
    throw new Error("NSE report listing contains an unsafe archive path.");
  }
  return {
    displayName: report.displayName ?? fileName,
    fileName,
    url: url.toString(),
    tradingDate: report.tradingDate,
    fileSize: report.fileSize ?? null,
  };
}

async function discoverNseReports({ fetchImpl = fetch } = {}) {
  const commonHeaders = {
    "user-agent": "Mozilla/5.0 WhyFolioNseDataService/1.0",
    accept: "text/html,application/json;q=0.9,*/*;q=0.8",
    referer: reportPageUrl,
  };
  const pageResponse = await fetchImpl(reportPageUrl, {
    headers: commonHeaders,
    signal: AbortSignal.timeout(15000),
  });
  await readResponse(pageResponse, maxFeedBytes, "NSE All Reports page");
  const cookies =
    pageResponse.headers
      .getSetCookie?.()
      .map((cookie) => cookie.split(";")[0])
      .join("; ") ?? "";

  const feedResponse = await fetchImpl(dailyReportsUrl, {
    headers: {
      ...commonHeaders,
      accept: "application/json,text/plain,*/*",
      ...(cookies ? { cookie: cookies } : {}),
    },
    signal: AbortSignal.timeout(15000),
  });
  const contentType = feedResponse.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error("NSE daily-reports feed did not return JSON.");
  }
  const feedBytes = await readResponse(
    feedResponse,
    maxFeedBytes,
    "NSE daily-reports feed",
  );
  let feed;
  try {
    feed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(feedBytes),
    );
  } catch {
    throw new Error("NSE daily-reports feed returned invalid JSON.");
  }
  return findReportPair(feed);
}

async function downloadReport(
  report,
  { fetchImpl = fetch, maxBytes = maxArchiveBytes } = {},
) {
  const response = await fetchImpl(report.url, {
    headers: {
      "user-agent": "Mozilla/5.0 WhyFolioNseDataService/1.0",
      referer: reportPageUrl,
    },
    signal: AbortSignal.timeout(30000),
  });
  if (new URL(response.url).hostname !== archiveHost) {
    throw new Error(
      "NSE report download redirected outside the approved archive host.",
    );
  }
  const bytes = await readResponse(
    response,
    maxBytes,
    `NSE release ${report.fileName}`,
  );
  return bytes;
}

module.exports = {
  discoverNseReports,
  downloadReport,
  findReportPair,
  toIsoTradeDate,
  maxArchiveBytes,
};
