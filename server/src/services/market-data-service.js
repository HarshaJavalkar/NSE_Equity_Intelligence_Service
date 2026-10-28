const { AppError } = require("../utils/app-error");

const sectionReaders = {
  market: (snapshot) => snapshot.market,
  fundamentals: (snapshot) => snapshot.fundamentals,
  results: (snapshot) => snapshot.financialResults,
  announcements: (snapshot) => snapshot.announcements,
  corporateActions: (snapshot) => snapshot.corporateActions,
  surveillance: (snapshot) => snapshot.market?.surveillance,
  delivery: (snapshot) => snapshot.market?.delivery,
  shortSelling: (snapshot) => snapshot.market?.shortSelling,
  marginTrading: (snapshot) => snapshot.market?.marginTrading,
  derived: (snapshot) => snapshot.derived,
  xbrl: (snapshot) => snapshot.xbrl,
  integratedFilings: (snapshot) => snapshot.integratedFilings,
  reports: (snapshot) => snapshot.reports,
};

class MarketDataService {
  constructor(repository) {
    this.repository = repository;
  }

  async getBySymbol(symbol, sections) {
    const dataset = await this.repository.getDatasetMetadata();
    const isin = await this.repository.getIsinBySymbol(
      symbol,
      dataset.datasetVersion,
    );
    if (!isin) {
      throw new AppError(
        404,
        "SECURITY_NOT_FOUND",
        `No NSE security was found for symbol ${symbol}.`,
      );
    }

    const snapshot = await this.repository.getSnapshot(
      isin,
      dataset.datasetVersion,
    );
    if (!snapshot) {
      throw new AppError(
        404,
        "SECURITY_NOT_FOUND",
        "The security is not present in the active dataset.",
      );
    }
    return this.#formatSnapshot(snapshot, dataset, sections);
  }

  async getByIsin(isin) {
    const dataset = await this.repository.getDatasetMetadata();
    const snapshot = await this.repository.getSnapshot(
      isin.toUpperCase(),
      dataset.datasetVersion,
    );
    if (!snapshot) {
      throw new AppError(
        404,
        "SECURITY_NOT_FOUND",
        `No NSE security was found for ISIN ${isin}.`,
      );
    }
    return this.#formatSnapshot(snapshot, dataset);
  }

  async getBatch(symbols, sections) {
    const dataset = await this.repository.getDatasetMetadata();
    const results = await Promise.all(
      symbols.map(async (symbol) => {
        try {
          const isin = await this.repository.getIsinBySymbol(
            symbol,
            dataset.datasetVersion,
          );
          if (!isin) {
            return {
              symbol,
              status: "UNAVAILABLE",
              error: { code: "SECURITY_NOT_FOUND" },
            };
          }
          const snapshot = await this.repository.getSnapshot(
            isin,
            dataset.datasetVersion,
          );
          if (!snapshot) {
            return {
              symbol,
              status: "UNAVAILABLE",
              error: { code: "SECURITY_NOT_FOUND" },
            };
          }
          return {
            symbol,
            status: "CURRENT",
            data: this.#formatSnapshot(snapshot, dataset, sections),
          };
        } catch (error) {
          if (error instanceof AppError && error.statusCode < 500) {
            return {
              symbol,
              status: "UNAVAILABLE",
              error: { code: error.code },
            };
          }
          throw error;
        }
      }),
    );

    return { datasetDate: dataset.tradeDate, results };
  }

  async search(query, limit) {
    const dataset = await this.repository.getDatasetMetadata();
    const securities = await this.repository.search(
      query,
      limit,
      dataset.datasetVersion,
    );
    return { datasetDate: dataset.tradeDate, securities };
  }

  async getDatasetStatus() {
    const metadata = await this.repository.getDatasetMetadata();
    return {
      ...metadata,
      status: metadata.status === "READY" ? "CURRENT" : metadata.status,
    };
  }

  async getReadiness() {
    const redis = await this.repository.ping();
    const dataset = await this.getDatasetStatus();
    if (!["CURRENT"].includes(dataset.status)) {
      throw new AppError(
        503,
        "DATA_NOT_AVAILABLE",
        "A current dataset is not ready to serve.",
      );
    }
    return {
      redis: redis ? "UP" : "DOWN",
      dataset: dataset.status,
      datasetDate: dataset.tradeDate,
    };
  }

  #formatSnapshot(snapshot, dataset, requestedSections) {
    const data = {};
    const sections = requestedSections ?? Object.keys(sectionReaders);
    for (const section of sections) {
      const value = sectionReaders[section](snapshot);
      data[section] =
        value === undefined
          ? { status: "UNAVAILABLE", reason: "SECTION_NOT_PUBLISHED" }
          : value;
    }

    return {
      status: dataset.status === "READY" ? "CURRENT" : dataset.status,
      datasetDate: dataset.tradeDate,
      generatedAt: snapshot.dataset?.generatedAt ?? dataset.generatedAt,
      symbol: snapshot.identity.symbol,
      data,
      provenance: snapshot.provenance ?? {},
    };
  }
}

module.exports = { MarketDataService };
