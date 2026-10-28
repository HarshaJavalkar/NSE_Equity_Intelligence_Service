"use strict";

const { randomUUID } = require("node:crypto");

const JOB_LOCK_KEY = "nse:eq:ingestion:job-lock";
const JOB_STATUS_KEY = "nse:eq:ingestion:job-status";
const JOB_LOCK_TTL_SECONDS = 4 * 60 * 60;
const JOB_STATUS_TTL_SECONDS = 30 * 24 * 60 * 60;
const releaseLockScript =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

class NseIngestionCoordinator {
  constructor({
    redisClient,
    ingestionService,
    logger = console,
    clock = () => new Date(),
  }) {
    this.redisClient = redisClient;
    this.ingestionService = ingestionService;
    this.logger = logger;
    this.clock = clock;
  }

  async getStatus() {
    const raw = await this.redisClient.get(JOB_STATUS_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error("Stored NSE ingestion job status is invalid.");
    }
  }

  async recoverOrphanedJobs() {
    try {
      const job = await this.getStatus();
      if (job?.status === "RUNNING") {
        const lockHolder = await this.redisClient.get(JOB_LOCK_KEY);
        if (!lockHolder || lockHolder !== job.jobId) {
          job.status = "INTERRUPTED";
          job.completedAt = this.clock().toISOString();
          job.error = "Job was interrupted by a server restart or expired lock.";
          await this.#saveStatus(job);
          this.logger.log({
            event: "nse_ingestion_orphaned_job_recovered",
            jobId: job.jobId,
          });
          return job;
        }
      }
    } catch (error) {
      this.logger.error({
        event: "nse_ingestion_job_recovery_failed",
        error: error.message,
      });
    }
    return null;
  }

  async isDateCompleted(tradeDate) {
    if (!tradeDate) return false;
    try {
      const raw = await this.redisClient.get("nse:eq:dataset:latest");
      if (!raw) return false;
      const meta = JSON.parse(raw);
      return meta.tradeDate === tradeDate && meta.status === "READY";
    } catch {
      return false;
    }
  }

  async start({
    trigger,
    expectedTradeDate = null,
    skipIfCurrent = false,
    force = false,
    requestedBy = null,
  }) {
    // If a previous job crashed without lock release, clean up before starting
    await this.recoverOrphanedJobs();

    const jobId = randomUUID();
    const acquired = await this.redisClient.set(JOB_LOCK_KEY, jobId, {
      NX: true,
      EX: JOB_LOCK_TTL_SECONDS,
    });
    if (acquired !== "OK") {
      return { accepted: false, job: await this.getStatus() };
    }

    const job = {
      jobId,
      trigger,
      status: "RUNNING",
      requestedBy,
      expectedTradeDate,
      startedAt: this.clock().toISOString(),
      completedAt: null,
      result: null,
      error: null,
    };
    await this.#saveStatus(job);
    void this.#execute(jobId, job, {
      expectedTradeDate,
      skipIfCurrent: force ? false : skipIfCurrent,
    });
    return { accepted: true, job };
  }

  async #execute(jobId, initialJob, options) {
    let job = initialJob;
    try {
      const result = await this.ingestionService.run({
        archiveAllReports: true,
        ...options,
      });
      job = {
        ...job,
        status: result.skipped ? "SKIPPED" : "SUCCEEDED",
        completedAt: this.clock().toISOString(),
        result: {
          skipped: result.skipped ?? false,
          skipReason: result.skipReason ?? null,
          tradeDate: result.tradeDate ?? result.metadata?.tradeDate ?? null,
          datasetVersion:
            result.datasetVersion ?? result.metadata?.datasetVersion ?? null,
          reportCount:
            result.reportArchive?.reportCount ?? result.reportCount ?? null,
          archiveDirectory: result.reportArchive?.directory ?? null,
          enrichment: result.enrichment ?? null,
          sourceRows: result.sourceRows ?? null,
        },
      };
    } catch (error) {
      job = {
        ...job,
        status: "FAILED",
        completedAt: this.clock().toISOString(),
        error: error.message,
      };
      this.logger.error({
        event: "nse_ingestion_job_failed",
        trigger: job.trigger,
        jobId,
        message: error.message,
      });
    } finally {
      try {
        await this.#saveStatus(job);
      } catch (error) {
        this.logger.error({
          event: "nse_ingestion_job_status_write_failed",
          jobId,
          message: error.message,
        });
      }
      try {
        await this.redisClient.eval(releaseLockScript, {
          keys: [JOB_LOCK_KEY],
          arguments: [jobId],
        });
      } catch (error) {
        this.logger.error({
          event: "nse_ingestion_job_lock_release_failed",
          jobId,
          message: error.message,
        });
      }
    }
  }

  async #saveStatus(job) {
    await this.redisClient.set(JOB_STATUS_KEY, JSON.stringify(job), {
      EX: JOB_STATUS_TTL_SECONDS,
    });
  }
}

module.exports = { NseIngestionCoordinator };
