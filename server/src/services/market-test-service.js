const { AppError } = require("../utils/app-error");
const { endpointById } = require("../control-plane/endpoint-catalog");

const sectionByEndpoint = {
  "market.equity.market": "market",
  "market.equity.fundamentals": "fundamentals",
  "market.equity.results": "results",
  "market.equity.announcements": "announcements",
  "market.equity.corporateActions": "corporateActions",
  "market.equity.surveillance": "surveillance",
  "market.equity.delivery": "delivery",
  "market.equity.shortSelling": "shortSelling",
  "market.equity.marginTrading": "marginTrading",
  "market.equity.derived": "derived",
};

class MarketTestService {
  constructor({ developerService, marketDataService }) {
    this.developerService = developerService;
    this.marketDataService = marketDataService;
  }

  async execute(developerUserId, request) {
    const endpoint = endpointById.get(request.endpointId);
    if (!endpoint || endpoint.method !== request.method) {
      throw new AppError(
        400,
        "ENDPOINT_NOT_SUPPORTED",
        "Choose a supported catalog endpoint and method.",
      );
    }

    if (!request.apiKey) {
      throw new AppError(
        401,
        "API_KEY_REQUIRED",
        "An endpoint-scoped API key is required.",
      );
    }

    const apiKey = await this.developerService.validateApiKey(
      request.apiKey,
      endpoint.id,
    );
    if (apiKey.ownerId.toString() !== developerUserId) {
      throw new AppError(
        403,
        "API_KEY_OWNER_MISMATCH",
        "Use an API key belonging to this developer account.",
      );
    }

    let statusCode = 500;
    try {
      const data = await this.#dispatch(request);
      statusCode = 200;
      return {
        endpoint,
        statusCode,
        data,
        authenticatedUserId: developerUserId,
      };
    } finally {
      try {
        await this.developerService.recordUsage({
          ownerId: apiKey.ownerId,
          apiKeyId: apiKey._id,
          endpointId: endpoint.id,
          endpoint: `${endpoint.method} ${endpoint.path}`,
          statusCode,
        });
      } catch (error) {
        console.error({
          event: "usage_record_failed",
          endpointId: endpoint.id,
          code: error.code ?? "USAGE_ERROR",
        });
      }
    }
  }

  async #dispatch(request) {
    const params = request.params ?? {};
    const query = request.query ?? {};
    const body = request.body ?? {};

    if (request.endpointId === "market.dataset.status") {
      return this.marketDataService.getDatasetStatus();
    }
    if (request.endpointId === "market.security.isin") {
      return this.marketDataService.getByIsin(params.isin ?? "");
    }
    if (request.endpointId === "market.search") {
      return this.marketDataService.search(
        query.q ?? "",
        Number(query.limit ?? 20),
      );
    }
    if (request.endpointId === "market.equity.batch") {
      return this.marketDataService.getBatch(body.symbols ?? [], body.sections);
    }
    if (request.endpointId === "market.equity.read") {
      const sections =
        typeof query.sections === "string"
          ? query.sections
              .split(",")
              .map((section) => section.trim())
              .filter(Boolean)
          : query.sections;
      return this.marketDataService.getBySymbol(params.symbol ?? "", sections);
    }

    const section = sectionByEndpoint[request.endpointId];
    if (section)
      return this.marketDataService.getBySymbol(params.symbol ?? "", [section]);
    throw new AppError(
      400,
      "ENDPOINT_NOT_SUPPORTED",
      "This endpoint is not available in the test console.",
    );
  }
}

module.exports = { MarketTestService };