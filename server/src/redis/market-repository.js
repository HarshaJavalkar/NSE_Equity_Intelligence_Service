const { AppError } = require("../utils/app-error");

const DATASET_LATEST_KEY = "nse:eq:dataset:latest";

class MarketRepository {
  constructor(redisClient) {
    this.redisClient = redisClient;
  }

  async ping() {
    this.#assertReady();
    try {
      return (await this.redisClient.ping()) === "PONG";
    } catch (error) {
      throw this.#redisError(error);
    }
  }

  async getDatasetMetadata() {
    const raw = await this.#get(DATASET_LATEST_KEY);
    if (!raw) {
      throw new AppError(
        503,
        "DATA_NOT_AVAILABLE",
        "No validated dataset has been published.",
      );
    }

    const metadata = this.#parseJson(raw, DATASET_LATEST_KEY);
    if (!metadata.datasetVersion || !metadata.tradeDate || !metadata.status) {
      throw new AppError(
        503,
        "DATA_NOT_AVAILABLE",
        "The published dataset pointer is incomplete.",
      );
    }
    if (!["READY", "CURRENT", "STALE", "PARTIAL"].includes(metadata.status)) {
      throw new AppError(
        503,
        "DATA_NOT_AVAILABLE",
        "No valid dataset is active.",
      );
    }
    return metadata;
  }

  async getIsinBySymbol(symbol, datasetVersion) {
    const normalizedSymbol = symbol.trim().toUpperCase();
    const key = this.#indexKey(datasetVersion, "symbol");
    const isin = await this.#hGet(key, normalizedSymbol);
    return isin || null;
  }

  async getSnapshot(isin, datasetVersion) {
    const key = `nse:eq:v:${datasetVersion}:security:${isin}`;
    const raw = await this.#get(key);
    if (!raw) return null;

    const snapshot = this.#parseJson(raw, key);
    if (snapshot.identity?.isin !== isin) {
      throw new AppError(
        500,
        "DATASTORE_CORRUPT",
        "Snapshot identity does not match its Redis key.",
      );
    }
    if (
      snapshot.dataset?.datasetVersion &&
      snapshot.dataset.datasetVersion !== datasetVersion
    ) {
      throw new AppError(
        500,
        "DATASTORE_CORRUPT",
        "Snapshot version does not match the active dataset.",
      );
    }
    return snapshot;
  }

  async search(query, limit, datasetVersion) {
    this.#assertReady();
    const normalizedQuery = query.trim().toUpperCase();
    const escapedQuery = normalizedQuery.replace(/[\\*?\[\]]/g, "\\$&");
    const matches = [];
    const key = this.#indexKey(datasetVersion, "search");

    try {
      for await (const entries of this.redisClient.hScanIterator(key, {
        MATCH: `*${escapedQuery}*`,
        COUNT: Math.min(limit * 2, 100),
      })) {
        for (const { value } of entries) {
          matches.push(this.#parseJson(value, key));
          if (matches.length >= limit) break;
        }
        if (matches.length >= limit) break;
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw this.#redisError(error);
    }

    return matches;
  }

  async #get(key) {
    this.#assertReady();
    try {
      return await this.redisClient.get(key);
    } catch (error) {
      throw this.#redisError(error);
    }
  }

  async #hGet(key, field) {
    this.#assertReady();
    try {
      return await this.redisClient.hGet(key, field);
    } catch (error) {
      throw this.#redisError(error);
    }
  }

  #parseJson(raw, key) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new AppError(
        500,
        "DATASTORE_CORRUPT",
        `Stored JSON is invalid for key ${key}.`,
      );
    }
  }

  #indexKey(datasetVersion, indexName) {
    if (!/^[A-Za-z0-9T:._+-]{1,80}$/.test(datasetVersion)) {
      throw new AppError(
        500,
        "DATASTORE_CORRUPT",
        "Dataset version contains invalid key characters.",
      );
    }
    return `nse:eq:v:${datasetVersion}:index:${indexName}`;
  }

  #assertReady() {
    if (!this.redisClient?.isReady) {
      throw new AppError(503, "REDIS_UNAVAILABLE", "Redis is not ready.");
    }
  }

  #redisError(error) {
    return new AppError(503, "REDIS_UNAVAILABLE", "Redis request failed.");
  }
}

module.exports = { MarketRepository };
