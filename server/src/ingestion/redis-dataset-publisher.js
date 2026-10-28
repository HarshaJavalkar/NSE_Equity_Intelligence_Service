const DATASET_LATEST_KEY = "nse:eq:dataset:latest";
const DATASET_VERSIONS_KEY = "nse:eq:dataset:versions";
const DEFAULT_RETENTION_COUNT = 3;
const snapshotBatchSize = 250;
const indexBatchSize = 500;

class RedisDatasetPublisher {
  constructor(redisClient, { retentionCount = DEFAULT_RETENTION_COUNT } = {}) {
    this.redisClient = redisClient;
    this.retentionCount = retentionCount;
  }

  async publish(dataset, { retentionCount = this.retentionCount } = {}) {
    if (!this.redisClient?.isReady) {
      throw new Error("Redis must be ready before a dataset can be published.");
    }
    const versionPrefix = `nse:eq:v:${dataset.metadata.datasetVersion}`;

    for (
      let offset = 0;
      offset < dataset.snapshotEntries.length;
      offset += snapshotBatchSize
    ) {
      const batch = dataset.snapshotEntries.slice(
        offset,
        offset + snapshotBatchSize,
      );
      const transaction = this.redisClient.multi();
      for (const [isin, snapshot] of batch) {
        transaction.set(
          `${versionPrefix}:security:${isin}`,
          JSON.stringify(snapshot),
        );
      }
      const results = await transaction.exec();
      if (results.length !== batch.length) {
        throw new Error(
          "Redis did not confirm every versioned snapshot write.",
        );
      }
    }

    await this.#writeHash(`${versionPrefix}:index:symbol`, dataset.symbolIndex);
    await this.#writeHash(`${versionPrefix}:index:search`, dataset.searchIndex);
    await this.#verifySnapshots(versionPrefix, dataset.snapshotEntries);

    const symbolCount = await this.redisClient.hLen(
      `${versionPrefix}:index:symbol`,
    );
    const searchCount = await this.redisClient.hLen(
      `${versionPrefix}:index:search`,
    );
    if (
      symbolCount !== Object.keys(dataset.symbolIndex).length ||
      searchCount !== Object.keys(dataset.searchIndex).length
    ) {
      throw new Error(
        "Redis index verification did not match the validated dataset.",
      );
    }

    const pointer = JSON.stringify(dataset.metadata);
    await this.redisClient.set(DATASET_LATEST_KEY, pointer);
    const publishedPointer = await this.redisClient.get(DATASET_LATEST_KEY);
    if (publishedPointer !== pointer) {
      throw new Error("Redis did not confirm the active dataset pointer.");
    }

    // Record new version in versions sorted set (scored by timestamp)
    await this.redisClient.zAdd(DATASET_VERSIONS_KEY, [
      { score: Date.now(), value: dataset.metadata.datasetVersion },
    ]);

    // Establish retention and cleanup for obsolete versions
    const cleanedVersions = await this.cleanupObsoleteVersions({
      retentionCount,
      activeVersion: dataset.metadata.datasetVersion,
    });

    return {
      ...dataset.metadata,
      retention: {
        retainedCount: retentionCount,
        cleanedVersions,
      },
    };
  }

  async cleanupObsoleteVersions({
    retentionCount = this.retentionCount,
    activeVersion = null,
  } = {}) {
    if (!this.redisClient?.isReady) return [];
    try {
      const allVersions = await this.redisClient.zRange(
        DATASET_VERSIONS_KEY,
        0,
        -1,
      );
      if (allVersions.length <= retentionCount) {
        return [];
      }

      const obsoleteVersions = allVersions.slice(
        0,
        allVersions.length - retentionCount,
      );
      const cleaned = [];

      for (const version of obsoleteVersions) {
        // Never delete the currently active version
        if (version === activeVersion) continue;

        await this.#deleteVersion(version);
        await this.redisClient.zRem(DATASET_VERSIONS_KEY, version);
        cleaned.push(version);
      }
      return cleaned;
    } catch (error) {
      console.error({
        event: "redis_obsolete_version_cleanup_failed",
        error: error.message,
      });
      return [];
    }
  }

  async #deleteVersion(version) {
    const versionPrefix = `nse:eq:v:${version}`;
    await this.redisClient.del([
      `${versionPrefix}:index:symbol`,
      `${versionPrefix}:index:search`,
    ]);

    let cursor = "0";
    do {
      const reply = await this.redisClient.scan(cursor, {
        MATCH: `${versionPrefix}:security:*`,
        COUNT: 250,
      });
      cursor = typeof reply === "string" ? "0" : (reply.cursor ?? "0");
      const keys = Array.isArray(reply) ? reply : (reply.keys ?? []);
      if (keys.length > 0) {
        await this.redisClient.del(keys);
      }
    } while (cursor !== "0" && cursor !== 0);
  }

  async #writeHash(key, entries) {
    const pairs = Object.entries(entries);
    for (let offset = 0; offset < pairs.length; offset += indexBatchSize) {
      const batch = Object.fromEntries(
        pairs.slice(offset, offset + indexBatchSize),
      );
      await this.redisClient.hSet(key, batch);
    }
  }

  async #verifySnapshots(versionPrefix, entries) {
    for (let offset = 0; offset < entries.length; offset += snapshotBatchSize) {
      const batch = entries.slice(offset, offset + snapshotBatchSize);
      const keys = batch.map(([isin]) => `${versionPrefix}:security:${isin}`);
      const snapshots = await this.redisClient.mGet(keys);
      if (
        snapshots.length !== keys.length ||
        snapshots.some((value) => value === null)
      ) {
        throw new Error("Redis snapshot verification found missing records.");
      }
    }
  }
}

module.exports = {
  RedisDatasetPublisher,
  DATASET_LATEST_KEY,
  DATASET_VERSIONS_KEY,
  DEFAULT_RETENTION_COUNT,
};
