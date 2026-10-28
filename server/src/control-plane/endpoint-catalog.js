const endpointCatalog = [
  {
    id: "market.equity.read",
    method: "GET",
    path: "/api/v1/market/equities/:symbol",
    label: "Full equity snapshot",
  },
  {
    id: "market.equity.market",
    method: "GET",
    path: "/api/v1/market/equities/:symbol/market",
    label: "Market data",
  },
  {
    id: "market.equity.fundamentals",
    method: "GET",
    path: "/api/v1/market/equities/:symbol/fundamentals",
    label: "Fundamentals",
  },
  {
    id: "market.equity.results",
    method: "GET",
    path: "/api/v1/market/equities/:symbol/results",
    label: "Financial results",
  },
  {
    id: "market.equity.announcements",
    method: "GET",
    path: "/api/v1/market/equities/:symbol/announcements",
    label: "Announcements",
  },
  {
    id: "market.equity.corporateActions",
    method: "GET",
    path: "/api/v1/market/equities/:symbol/corporate-actions",
    label: "Corporate actions",
  },
  {
    id: "market.equity.surveillance",
    method: "GET",
    path: "/api/v1/market/equities/:symbol/surveillance",
    label: "Surveillance",
  },
  {
    id: "market.equity.delivery",
    method: "GET",
    path: "/api/v1/market/equities/:symbol/delivery",
    label: "Delivery statistics",
  },
  {
    id: "market.equity.shortSelling",
    method: "GET",
    path: "/api/v1/market/equities/:symbol/short-selling",
    label: "Short selling",
  },
  {
    id: "market.equity.marginTrading",
    method: "GET",
    path: "/api/v1/market/equities/:symbol/margin-trading",
    label: "Margin trading",
  },
  {
    id: "market.equity.derived",
    method: "GET",
    path: "/api/v1/market/equities/:symbol/derived",
    label: "Derived metrics",
  },
  {
    id: "market.equity.batch",
    method: "POST",
    path: "/api/v1/market/equities/batch",
    label: "Batch equities",
  },
  {
    id: "market.search",
    method: "GET",
    path: "/api/v1/market/search",
    label: "Security search",
  },
  {
    id: "market.security.isin",
    method: "GET",
    path: "/api/v1/market/securities/:isin",
    label: "Security by ISIN",
  },
  {
    id: "market.dataset.status",
    method: "GET",
    path: "/api/v1/market/dataset/status",
    label: "Dataset status",
  },
];

const endpointById = new Map(
  endpointCatalog.map((endpoint) => [endpoint.id, endpoint]),
);

function identifyEndpoint(method, path) {
  const normalized = path.split("?")[0].replace(/\/+$/, "") || "/";
  if (method === "POST" && normalized === "/api/v1/market/equities/batch")
    return "market.equity.batch";
  if (method === "GET" && normalized === "/api/v1/market/search")
    return "market.search";
  if (method === "GET" && normalized === "/api/v1/market/dataset/status")
    return "market.dataset.status";
  if (
    method === "GET" &&
    /^\/api\/v1\/market\/securities\/[A-Z0-9]+$/i.test(normalized)
  )
    return "market.security.isin";

  const match = normalized.match(
    /^\/api\/v1\/market\/equities\/[^/]+(?:\/([^/]+))?$/,
  );
  if (!match) return null;
  if (!match[1]) return method === "GET" ? "market.equity.read" : null;

  const sectionIds = {
    market: "market.equity.market",
    fundamentals: "market.equity.fundamentals",
    results: "market.equity.results",
    announcements: "market.equity.announcements",
    "corporate-actions": "market.equity.corporateActions",
    surveillance: "market.equity.surveillance",
    delivery: "market.equity.delivery",
    "short-selling": "market.equity.shortSelling",
    "margin-trading": "market.equity.marginTrading",
    derived: "market.equity.derived",
  };
  return method === "GET" ? (sectionIds[match[1]] ?? null) : null;
}

module.exports = { endpointById, endpointCatalog, identifyEndpoint };
