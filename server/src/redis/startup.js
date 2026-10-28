"use strict";

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createClient } = require("redis");

const execFileAsync = promisify(execFile);
const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379";

async function runCommand(command, args) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: 120000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, stdout: stdout.trim() };
  } catch {
    return { ok: false, stdout: "" };
  }
}

async function pingRedis(url) {
  const client = createClient({
    url,
    socket: {
      connectTimeout: 2000,
      reconnectStrategy: () => false,
    },
  });
  client.on("error", () => {});

  let timeout;
  try {
    const response = await Promise.race([
      (async () => {
        await client.connect();
        return client.ping();
      })(),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve(null), 3000);
      }),
    ]);
    return response === "PONG";
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
    if (client.isOpen) client.destroy();
  }
}

async function startDockerRedis(port, run) {
  const inspected = await run("docker", [
    "inspect",
    "--format",
    "{{.State.Status}}",
    "redis",
  ]);

  if (inspected.ok) {
    const state = inspected.stdout.toLowerCase();
    if (state === "running") return true;
    const action = state === "paused" ? "unpause" : "start";
    return (await run("docker", [action, "redis"])).ok;
  }

  return (
    await run("docker", [
      "run",
      "-d",
      "--restart",
      "unless-stopped",
      "-p",
      `127.0.0.1:${port}:6379`,
      "--name",
      "redis",
      "--volume",
      "whyfolio-redis-data:/data",
      "redis:alpine",
      "redis-server",
      "--maxmemory",
      "256mb",
      "--maxmemory-policy",
      "allkeys-lru",
    ])
  ).ok;
}

async function startWslRedis(run) {
  const serviceStarted = await run("wsl", [
    "sudo",
    "-n",
    "service",
    "redis-server",
    "start",
  ]);
  if (serviceStarted.ok) return true;
  return (await run("wsl", ["redis-server", "--daemonize", "yes"])).ok;
}

async function startNativeRedis(run) {
  const serviceStarted = await run("service", ["redis-server", "start"]);
  if (serviceStarted.ok) return true;
  return (await run("redis-server", ["--daemonize", "yes"])).ok;
}

async function waitForRedis({ url, ping, sleep, attempts }) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await ping(url)) return true;
    await sleep(500);
  }
  return false;
}

async function ensureRedisReady({
  url = process.env.REDIS_URL || DEFAULT_REDIS_URL,
  ping = pingRedis,
  run = runCommand,
  sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
  logger = console,
  platform = process.platform,
  attempts = 20,
} = {}) {
  if (await ping(url)) {
    logger.log({ event: "redis_ping_success", response: "PONG" });
    return;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error("REDIS_URL is invalid.");
  }

  const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) {
    throw new Error(
      `Redis at ${hostname} is unavailable and cannot be started locally.`,
    );
  }

  const port = Number(parsedUrl.port || 6379);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("REDIS_URL must contain a valid TCP port.");
  }

  logger.log({ event: "redis_local_start_attempt", hostname, port });
  const providers = [() => startDockerRedis(port, run)];
  if (platform === "win32") providers.push(() => startWslRedis(run));
  else providers.push(() => startNativeRedis(run));

  for (const startProvider of providers) {
    if (await startProvider()) {
      if (await waitForRedis({ url, ping, sleep, attempts })) {
        logger.log({ event: "redis_ping_success", response: "PONG" });
        return;
      }
    }
  }

  logger.error({
    event: "redis_start_failed",
    providers: platform === "win32" ? ["docker", "wsl"] : ["docker", "native"],
  });
  throw new Error("Redis did not become ready after startup attempts.");
}

module.exports = { ensureRedisReady };
