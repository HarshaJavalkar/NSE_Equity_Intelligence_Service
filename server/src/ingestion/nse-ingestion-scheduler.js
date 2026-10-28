"use strict";

const INDIA_TIME_ZONE = "Asia/Kolkata";
const SCHEDULE_START_MINUTE = 19 * 60 + 30; // 7:30 PM IST
const SCHEDULE_END_MINUTE = 23 * 60 + 59; // 11:59 PM IST
const SCHEDULE_POLL_MINUTES = 5;
const SCHEDULER_TICK_MS = 60 * 1000;
const MAX_DAILY_RETRIES = 12;

const indiaClock = new Intl.DateTimeFormat("en-CA", {
  timeZone: INDIA_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
  hourCycle: "h23",
});

function getIndiaTime(date) {
  const parts = Object.fromEntries(
    indiaClock
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map(({ type, value }) => [type, value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

class NseIngestionScheduler {
  constructor({ coordinator, logger = console, clock = () => new Date() }) {
    this.coordinator = coordinator;
    this.logger = logger;
    this.clock = clock;
    this.timer = null;
    this.lastAttemptSlot = null;
    this.retriesByDate = new Map();
    this.completedDates = new Set();
  }

  start() {
    if (this.timer) return;
    void this.#initializeAndCatchUp();
    this.timer = setInterval(() => void this.#tick(), SCHEDULER_TICK_MS);
    this.timer.unref?.();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async #initializeAndCatchUp() {
    // 1. Recover any orphaned jobs from a previous server crash
    if (typeof this.coordinator.recoverOrphanedJobs === "function") {
      await this.coordinator.recoverOrphanedJobs();
    }
    // 2. Perform startup catch-up
    await this.#startCatchUp();
  }

  async #startCatchUp() {
    try {
      const result = await this.coordinator.start({
        trigger: "STARTUP_CATCH_UP",
        skipIfCurrent: true,
      });
      if (!result.accepted) {
        this.logger.log({
          event: "nse_startup_catch_up_skipped",
          reason: "JOB_ALREADY_RUNNING",
        });
      }
    } catch (error) {
      this.logger.error({
        event: "nse_startup_catch_up_failed",
        message: error.message,
      });
    }
  }

  async #tick() {
    const now = getIndiaTime(this.clock());
    // Only poll within the release window (7:30 PM to midnight IST)
    if (now.minutes < SCHEDULE_START_MINUTE || now.minutes > SCHEDULE_END_MINUTE) {
      return;
    }

    // Completion deduplication: if today's dataset is already published and ready, do not pound NSE
    if (this.completedDates.has(now.date)) {
      return;
    }
    if (typeof this.coordinator.isDateCompleted === "function") {
      const isDone = await this.coordinator.isDateCompleted(now.date);
      if (isDone) {
        this.completedDates.add(now.date);
        this.logger.log({
          event: "nse_scheduled_ingestion_already_completed",
          tradeDate: now.date,
        });
        return;
      }
    }

    // Bounded retries: limit poll attempts to prevent infinite retries
    const attempts = this.retriesByDate.get(now.date) ?? 0;
    if (attempts >= MAX_DAILY_RETRIES) {
      if (attempts === MAX_DAILY_RETRIES) {
        this.retriesByDate.set(now.date, attempts + 1);
        this.logger.warn({
          event: "nse_scheduled_ingestion_max_retries_reached",
          tradeDate: now.date,
          attempts,
        });
      }
      return;
    }

    const slot = `${now.date}:${Math.floor(
      (now.minutes - SCHEDULE_START_MINUTE) / SCHEDULE_POLL_MINUTES,
    )}`;
    if (slot === this.lastAttemptSlot) return;
    this.lastAttemptSlot = slot;

    try {
      const result = await this.coordinator.start({
        trigger: "DAILY_SCHEDULE",
        expectedTradeDate:
          now.weekday === "Sat" || now.weekday === "Sun" ? null : now.date,
        skipIfCurrent: true,
      });
      if (result.accepted) {
        this.logger.log({
          event: "nse_scheduled_ingestion_started",
          tradeDate: now.date,
          jobId: result.job?.jobId,
          attempt: attempts + 1,
        });
        this.retriesByDate.set(now.date, attempts + 1);
      } else {
        this.logger.log({
          event: "nse_scheduled_ingestion_lock_held_by_peer",
          tradeDate: now.date,
        });
      }
    } catch (error) {
      this.logger.error({
        event: "nse_scheduled_ingestion_start_failed",
        tradeDate: now.date,
        message: error.message,
      });
      this.retriesByDate.set(now.date, attempts + 1);
    }
  }
}

module.exports = { NseIngestionScheduler, getIndiaTime, MAX_DAILY_RETRIES };
