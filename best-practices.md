# Low-Level Design (LLD) Architecture: Node.js & Express Backend

This document details the software architecture, design patterns, engineering methodologies, and implementation practices employed across the backend server. It focuses on the server's architectural design, structure, and system engineering.

---

## 1. System Topology & Directory Structure

The backend follows a **Layered Architecture (Separation of Concerns)** with strict isolation between the HTTP transport layer, domain business services, data schemas, infrastructure drivers, and cross-cutting middlewares.

```text
server/
├── app.js                         # Express HTTP pipeline, global middlewares, CORS, Scalar docs
├── server.js                      # Multi-core clustering, process lifecycle & graceful termination
├── db.js                          # Mongoose connection pooling, IPv4 pinning & query profiling
├── router.js                      # Master gateway routing delegator
├── common_router.js               # Common domain routes (Auth, Passbook, Viral, Comments, Market)
├── v1_router.js                   # V1 Upstox Direct Broker OAuth & Ingestion
├── v2_router.js                   # V2 Multi-Broker Statement Ingestion & Family Portfolios
├── v3_router.js                   # V3 Red-Team Orchestration, Evidence Engine, Adjudication
│
├── config/                        # Environment configurations & operational thresholds
│   ├── creditEconomyConfig.js     # Conviction Credit rules, costs, and limits
│   ├── rateLimitConfig.js         # Service-level rate-limiting tiers & window thresholds
│   └── swaggerConfig.js           # OpenAPI 3.0 schema definitions
│
├── controllers/                   # HTTP Transport Layer (Request parsing, status codes, SSE streams)
│   ├── v3Controller.js            # V3 orchestration endpoints & SSE streaming handlers
│   └── marketController.js        # Market batch fundamentals transport
│
├── middleware/                    # Cross-cutting HTTP interceptors
│   ├── asyncHandler.js            # Async wrapper preventing unhandled promise rejections
│   ├── auth.js                    # JWT verification, Redis token revocation blacklist, broker vault
│   ├── rateLimiter.js             # Distributed Redis rate-limiter with 15-min penalty blocks
│   ├── error.js                   # Centralized error serialization & HTTP status mapping
│   ├── compression.js             # Zero-dependency native gzip/deflate response stream compressor
│   ├── cookies.js                 # Zero-dependency HTTP cookie header parser
│   ├── requestLogger.js           # Inbound HTTP auditing & response latency profiler
│   └── validateUnsynthesizedComments.js # Business rule validator for journal limits
│
├── models/                        # Mongoose Schema & Database Abstraction Layer
│   ├── User.js                    # User profile, CC balance, roles, user-specific config overrides
│   ├── TokenTransaction.js        # Double-entry CC immutable audit ledger (unique sparse idempotency)
│   ├── Holding.js                 # Portfolio stock assets, cache timestamps, ISIN-ticker mappings
│   ├── HoldingComment.js          # Granular investment journal notes (Conviction, Doubt, Catalyst)
│   ├── ThesisSynthesis.js         # Canonical snapshots of investor beliefs with versioning
│   ├── AiAnalysis.js              # Multi-model red-team reports, verdicts & falsification metrics
│   └── PortfolioSource.js         # Multi-broker ingestion sources (Zerodha, Groww, Upstox, CAS)
│
├── services/                      # Domain Business Logic & Infrastructure Connectors
│   ├── redis.js                   # Native socket RESP client with TLS & bounded in-memory fallback
│   ├── creditLedger.js            # Atomic credit mutations ($inc preconditions), rollback safety
│   ├── fundamentals.js            # Market data aggregator, cache manager (09:15 AM IST TTL expiry)
│   ├── primaryAuth.js             # Google OAuth & Email OTP verification
│   ├── holdings.js                # Holding CRUD, portfolio valuations, CSV exports
│   └── holdingComments.js         # Journal note lifecycle & watermark tracking
│
├── utils/                         # Reusable core utilities & infrastructure helpers
│   ├── logger.js                  # Dual-stream colorized console & daily rotating file logger
│   ├── jwt.js                     # HMAC-SHA256 token generation & signature verification
│   └── portfolioSnapshotHelper.js # Authoritative financial mathematics & portfolio weighting
│
└── v3_services/                   # Level 1/2/3 Domain Engines (Isolated Domain Layer)
    ├── v3ThesisOrchestrator.js    # Master pipeline coordinator (debits, staging, fallbacks, rollbacks)
    ├── evidenceEngine.js          # Authoritative multi-tier evidence pack compiler (T1-T5)
    ├── financialCalculations.js   # Deterministic financial ratio engine (Section 3 & 4 metrics)
    ├── sectorArchetypeEngine.js   # Dynamic sector playbook matching & swing-factor discovery
    ├── adjudicationService.js     # Dual-model disagreement resolution & claim validation
    └── disagreementEngine.js      # Structural diffing between model verdicts & claims
```

---

## 2. Process & Runtime Lifecycle Architecture

### Multi-Core Clustering & Worker Supervision (`server.js`)

- **Primary / Worker Topology**: Employs the native Node.js `cluster` module. The primary process reads the system's CPU topology via `os.cpus().length` and forks dedicated worker processes.
- **Process Auto-Healing**: Listens for the `cluster.on('exit')` event. If a worker process exits unexpectedly (e.g., uncaught memory pressure), the primary logs the PID and exit signal and immediately spawns a replacement worker to maintain throughput.
- **Graceful Termination Protocol**: Listens to POSIX termination signals (`SIGINT`, `SIGTERM`, `SIGUSR2`). Sets an internal shutdown flag, terminates active workers via `worker.kill()`, ensures child PIDs are cleared, and permits open TCP connections to flush before exiting cleanly (`process.exit(0)`).
- **DNS Resolution Optimization**: Intercepts Node's underlying `c-ares` resolver via `dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1'])` to bypass Windows DNS SRV lookup bugs with MongoDB Atlas connection strings.

---

## 3. Layered Design & Separation of Concerns

```text
  Client Request (HTTP / SSE)
              │
              ▼
   ┌────────────────────────────────────────────────────────┐
   │ 1. HTTP Pipeline & Middlewares                         │
   │    requestLogger ➔ compression ➔ cookieParser ➔ CORS   │
   │    ➔ createRateLimiter ➔ requireAuth ➔ asyncHandler     │
   └────────────────────────────────────────────────────────┘
              │
              ▼
   ┌────────────────────────────────────────────────────────┐
   │ 2. Controller Layer (Transport Only)                   │
   │    - Parses params, queries, and headers               │
   │    - Negotiates JSON vs Server-Sent Events (SSE)       │
   │    - Returns standardized HTTP response envelopes      │
   └────────────────────────────────────────────────────────┘
              │
              ▼
   ┌────────────────────────────────────────────────────────┐
   │ 3. Service Layer (Core Business Logic)                 │
   │    - Completely decoupled from req/res objects         │
   │    - Pure functions and business orchestration         │
   │    - Progress reporting via event callbacks            │
   └────────────────────────────────────────────────────────┘
        │                            │
        ▼                            ▼
   ┌──────────────────────┐    ┌────────────────────────────┐
   │ 4. Data Layer        │    │ 5. Infrastructure Layer    │
   │    - Mongoose Models │    │    - Native Redis Client   │
   │    - Sparse Indexes  │    │    - Fallback Memory Store │
   │    - Atomic $inc     │    │    - Dual-Stream Logger    │
   └──────────────────────┘    └────────────────────────────┘
```

### Layer Responsibilities

1. **Controllers (`controllers/`)**:
   - Strictly responsible for HTTP transport mechanics: parameter extraction (`req.params`, `req.query`, `req.body`), header negotiation (`text/event-stream` vs `application/json`), and status code emission.
   - Never execute direct database queries or raw business calculations.
2. **Services (`services/`, `v3_services/`)**:
   - Pure domain logic modules. They accept plain JavaScript primitives/objects and return domain entities.
   - Completely testable in isolation without mocking Express request or response objects.
3. **Models (`models/`)**:
   - Define database schema integrity, field types, enums, compound indexes, and unique constraints.

---

## 4. HTTP Middleware Architecture & Patterns

### A. Centralized Asynchronous Handler (`middleware/asyncHandler.js`)

- Implements the **Higher-Order Function Pattern**:
  ```javascript
  const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
  ```
- Eliminates boilerplate `try-catch` blocks across all routes and prevents unhandled promise rejections from crashing the worker process by routing errors to `next(err)`.

### B. Distributed Rate Limiting with Penalty Locks (`middleware/rateLimiter.js`)

- **Factory Pattern**: Dynamically produces rate-limiting middleware configured per domain (`global`, `auth`, `heavy`).
- **Multi-Key Client Identification**: Resolves proxy headers (`x-forwarded-for`) with fallback to `req.ip`. If authenticated, upgrades the key to `usr:<userId>` to prevent multi-IP bypassing.
- **15-Minute Penalty Lockout**: If a client exceeds the threshold within the active window, a secondary penalty key (`whyfolio:rl:blocked:<client>`) is created in Redis. Subsequent requests are rejected with `429 Too Many Requests` without touching backend logic until the TTL expires.
- **IETF Standard Headers**: Automatically emits `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, and `Retry-After`.

### C. Authentication & Token Revocation Architecture (`middleware/auth.js`)

- **Cryptographic Verification**: Verifies application-scoped JWT signatures using HMAC-SHA256 (`WHYFOLIO_JWT_SECRET`).
- **Instant Revocation Blacklist**: Computes `crypto.createHash('sha256').update(token).digest('hex')` and checks Redis (`jwt:blacklist:<hash>`) on every incoming request. If a user logs out, the token is invalidated immediately across all cluster workers.
- **Separation of Concerns for Broker Secrets**: Broker tokens (e.g., Upstox access tokens) are never embedded inside the client-facing JWT. They are kept server-side in Redis under `whyfolio:broker_vault:<userId>` and accessed lazily via `req.getBrokerToken()`.

### D. Zero-Dependency Native Compression & Cookie Parsing

- **Compression (`middleware/compression.js`)**: Wraps Node's native `zlib.createGzip()` / `zlib.createDeflate()` streams without third-party dependencies, intercepting `res.write` and `res.end` when client accepts compression.
- **Cookies (`middleware/cookies.js`)**: Synchronously parses RFC 6265 compliant cookie strings from `req.headers.cookie` directly into `req.cookies`.

### E. Centralized Error Handling (`middleware/error.js`)

- Enforces consistent JSON error responses across the API:
  ```json
  {
    "ok": false,
    "reason": "Detailed error description"
  }
  ```
- Includes a `res.headersSent` guard to prevent runtime double-send exceptions if an error occurs mid-stream (such as during SSE transfers).

---

## 5. Ledger & Financial Transaction Integrity

The server manages "Conviction Credits" (CC) through an audited, double-entry ledger architecture (`services/creditLedger.js` and `models/TokenTransaction.js`).

```text
User Request ──► Check Idempotency Key ──► Precondition $inc (Atomic) ──► Record Ledger Entry
                       │                              │                             │
                  Found duplicate?               Balance < Cost?            Save TokenTransaction
                       │                              │                             │
                  Return cached                  Return 402                   Invalidate Cache
                  transaction                    INSUFFICIENT_CREDITS         (Profile & Passbook)
```

1. **Atomic Precondition Debiting**:
   - Uses MongoDB atomic `$inc` operators with balance precondition checks:
     ```javascript
     await User.findOneAndUpdate(
       { sub: userId, convictionCreditBalance: { $gte: safeAmount } },
       { $inc: { convictionCreditBalance: -safeAmount } },
       { new: true },
     );
     ```
   - Guarantees that no race condition or concurrent request can overdraft a user's balance, eliminating the need for heavy two-phase locking.
2. **Idempotency Engine**:
   - Every transaction uses an `idempotencyKey` indexed in MongoDB as `{ unique: true, sparse: true }`.
   - Replayed network requests return the existing transaction record rather than executing a duplicate deduction.
3. **Transaction Rollback Safety**:
   - If a long-running downstream operation fails, the system executes an automated compensating transaction with `type: 'REVERSAL'`, ensuring credits are never orphaned.
4. **Cache Invalidation on Mutation**:
   - On every balance change, Redis keys (`user:profile:<userId>` and `whyfolio:passbook:<userId>`) are invalidated to maintain cache coherence.

---

## 6. Caching & Resilience Infrastructure (`services/redis.js`)

To eliminate bloated dependencies and maximize runtime stability, the server implements a custom, zero-dependency Redis client:

- **Native RESP Protocol Client**: Implemented directly using Node.js `net.Socket` and `tls.TLSSocket`. It serializes and parses the Redis Serialization Protocol (RESP) natively.
- **Environment-Adaptive Transport**:
  - Local development connects via plain TCP socket to `127.0.0.1:6379`.
  - Production and staging detect cloud URLs (`rediss://`, Upstash) and automatically establish TLS sockets with SNI (`servername`).
- **In-Memory Fallback Mechanism**:
  - If the Redis server is unreachable or experiences network partitions, the client transparently routes operations to an internal memory store (`Map` with TTL expiration).
  - **Memory Bounding**: The fallback store is hard-capped at 5,000 keys with automatic LRU eviction to prevent heap starvation.
- **Deterministic TTL Alignment**:
  - Fundamental market data (`fundamentals:v3:<symbol>`) does not use static 24-hour expiration. It computes the exact number of seconds until the **next 09:15 AM IST (Indian Standard Time)** market open, guaranteeing fresh quotes at every market session.

---

## 7. Real-Time Streaming Architecture (Server-Sent Events)

For multi-stage orchestrations, the server utilizes **Server-Sent Events (SSE)** rather than polling or WebSockets:

- **HTTP Response Headers**:
  ```http
  Content-Type: text/event-stream; charset=utf-8
  Cache-Control: no-cache, no-transform
  Connection: keep-alive
  X-Accel-Buffering: no
  ```
  _(The `X-Accel-Buffering: no` header instructs reverse proxies like Nginx to disable chunk buffering and deliver frames immediately to the browser.)_
- **Streaming Protocol**:
  - Emits typed JSON events:

    ```text
    data: {"type":"status","step":"evidence","message":"Compiling evidence pack..."}

    data: {"type":"result","data":{ ... }}

    data: [DONE]
    ```

- **Connection Liveness & Cleanup**: Checks `!res.writableEnded` before every write to avoid memory leaks or write-after-close errors when users close their browser tabs.

---

## 8. Observability, Logging & Profiling (`utils/logger.js`)

- **Dual-Channel Output**:
  1. **Colorized Standard Output**: Formats logs with ANSI color markers (`\x1b[31m` for errors, `\x1b[33m` for warnings, `\x1b[35m` for latency warnings).
  2. **Daily Rotating File Log**: Atomically appends structured records to `logs/server-YYYY-MM-DD.log`.
- **Latency Profiling**:
  - Methods record high-resolution timestamps via `process.hrtime.bigint()`.
  - Operations taking $\ge 300\text{ms}$ are tagged with `⏳`. Operations taking $\ge 1000\text{ms}$ are flagged with `⚠️ [SLOW]`.
- **Deep Object Inspection**:
  - Employs `util.inspect(meta, { depth: null, colors: true, compact: true })` for console logging, preventing nested metadata from being collapsed into `[Object]`.
- **Database Query Profiling (`db.js`)**:
  - Hooks into `mongoose.set('debug')` to record query execution and execution times, while filtering out schema indexing operations (`createIndex`) to reduce noise.

---

## 9. Architectural Principles & Best Practices Summary

| Architectural Area     | Implemented Methodology                             | Primary Benefit                                                            |
| :--------------------- | :-------------------------------------------------- | :------------------------------------------------------------------------- |
| **Process Model**      | Node.js native `cluster` + auto-healing             | Maximizes multi-core CPU throughput; auto-recovers from crashed workers    |
| **Route Architecture** | Versioned Gateways (`router.js` ➔ `v1`, `v2`, `v3`) | Decouples legacy broker integrations from newer multi-source features      |
| **Layering**           | Controller / Service / Model separation             | Controllers handle transport only; business logic is isolated and testable |
| **Error Handling**     | `asyncHandler` + centralized `errorHandler`         | Prevents unhandled async rejections and standardizes JSON error responses  |
| **Ledger Integrity**   | Double-entry ledger + atomic `$inc` preconditions   | Prevents balance race conditions; enforces sparse unique idempotency       |
| **Data Storage**       | Native RESP socket client + memory fallback         | Zero external dependencies; app survives if Redis experiences downtime     |
| **Real-time UX**       | Server-Sent Events (SSE) + reverse proxy bypass     | Provides live pipeline feedback without polling overhead                   |
| **Observability**      | Dual-channel file & console logger with PID tags    | Tracks performance bottlenecks and retains immutable audit trails          |
