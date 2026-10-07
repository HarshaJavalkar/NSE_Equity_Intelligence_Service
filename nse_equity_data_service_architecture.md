# WhyFolio NSE Equity Intelligence Service
## Production System Design & Copilot Implementation Specification

**Document type:** Production architecture / implementation contract  
**Primary consumer:** WhyFolio backend and AI enrichment pipeline  
**Data authority:** NSE India official equity-market and corporate-filing sources  
**Refresh model:** Daily trading-day ingestion with refresh-aligned TTL  
**Canonical serving unit:** One normalized security snapshot object per security  
**Design rule:** Never fabricate, infer, or silently overwrite source data

---

# 1. Problem Statement

WhyFolio currently needs equity-market, corporate-filing, financial-result, corporate-action and security-level information from multiple sources.

This creates:

```text
WhyFolio
 ├── external market API
 ├── external fundamentals API
 ├── NSE report requests
 ├── corporate filing requests
 ├── repeated document lookups
 └── repeated normalization
```

The new service creates a dedicated NSE data layer:

```text
NSE official sources
        ↓
Central ingestion
        ↓
Normalization + validation
        ↓
Canonical security snapshot
        ↓
Redis
        ↓
Custom APIs
        ↓
WhyFolio
```

The purpose is to fetch NSE-published equity information once per trading day, normalize it once, and make it available through stable application APIs.

---

# 2. Architectural Decisions

## 2.1 Repository Independence

Create a completely independent repository:

```text
whyfolio-nse-data-service
```

It must not depend on WhyFolio application internals.

It exposes a documented HTTP API consumed by WhyFolio.

---

## 2.2 "One Object" Definition

The requirement for "all data in Redis in one object" means:

> one canonical JSON security snapshot per security and dataset version.

It does **not** mean one Redis key containing every NSE security and every document in the market.

Do not create:

```text
nse:all-equities
```

containing the entire market.

Create:

```text
nse:eq:snapshot:{isin}
```

where the value is one canonical normalized object for that security.

This keeps reads bounded and prevents a single giant Redis object from becoming a bottleneck.

---

# 3. Official NSE Source Domains

The service must consume only official NSE sources for NSE-originated data.

The source registry must be driven by official NSE report/filing definitions rather than hardcoded assumptions.

Current official NSE surfaces include:

- All Reports — Equities
- CM-UDiFF Common Bhavcopy Final
- NSE security files / security master
- 52 Week High Low Report
- Surveillance Indicator / Surveillance Indicator New
- Security-wise Delivery Positions
- CM Short Selling
- CM Margin Trading Disclosure
- Corporate Actions
- Corporate Announcements
- Announcement XBRL
- Financial Results
- Integrated Filing — Financials
- XBRL filing information / taxonomies

NSE currently identifies the older CM Bhavcopy/older Common Bhavcopy formats as discontinued and directs users to the UDiFF Common Bhavcopy Final format. Therefore, the implementation must not hardcode obsolete bhavcopy filenames.

Official source catalog must be verified at implementation time from the NSE website.

---

# 4. Source Registry

Create a single registry:

```text
src/config/nse-source-registry
```

Every source definition must contain:

```js
{
  id,
  category,
  officialPage,
  discoveryMethod,
  reportName,
  frequency,
  expectedFormat,
  dateParameter,
  parser,
  normalizer,
  enabled
}
```

Do NOT scatter NSE URLs throughout collectors.

The registry is the only place that defines source discovery.

---

# 5. Source Categories

## 5.1 Market / EOD

Collect where officially available:

```text
CM-UDiFF Common Bhavcopy Final
Security Master / MII Security File
52 Week High Low
Security-wise Delivery Positions
Surveillance Indicators
CM Short Selling
CM Margin Trading Disclosure
Market Activity / relevant CM reports
```

These provide exchange-level market and security information.

---

## 5.2 Corporate Actions

Collect:

```text
dividend
bonus
split
rights
buyback
merger / restructuring related actions
record dates
ex dates
book closure dates
```

Corporate actions are event records.

Do not overwrite an event with a scalar "latest corporate action" value.

---

## 5.3 Corporate Announcements

Collect the announcement record:

```text
symbol
company
subject
details
attachment
XBRL reference when present
broadcast timestamp
submission type where available
```

The service stores the announcement record and source references.

Do not summarize the announcement during ingestion.

---

## 5.4 Financial Results

Collect available NSE financial-result records.

Preserve:

```text
company
symbol
period
periodEnd
quarter / year
audited / unaudited
standalone / consolidated
cumulative / non-cumulative where supplied
Ind-AS / applicable reporting classification
XBRL reference
broadcast timestamp
details reference
```

Do not force every company into one identical financial schema.

Normalize only fields that can be mapped deterministically.

---

## 5.5 Integrated Filing / XBRL

Where available, capture:

```text
financial data
shareholding pattern
corporate governance
investor complaints
reconciliation of share capital
other published XBRL filing categories
```

Preserve the original filing classification and reporting period.

---

# 6. Data Classification

Every field entering the canonical dataset must be classified as one of:

```text
REPORTED_NSE
CALCULATED
EVENT
DOCUMENT_REFERENCE
UNAVAILABLE
```

Never classify an inferred value as `REPORTED_NSE`.

---

# 7. End-to-End Architecture

```text
                         NSE INDIA
                            │
                ┌───────────┴───────────┐
                │ Source Discovery      │
                │ Official Report Pages │
                └───────────┬───────────┘
                            │
                      Fetch Scheduler
                            │
                       HTTP Client
                            │
                   Rate Limit / Retry
                            │
                       Raw Ingestion
                            │
                 ┌──────────┴───────────┐
                 │                     │
              Parsers              Metadata
                 │                     │
                 └──────────┬──────────┘
                            │
                      Normalization
                            │
                  Security Identity Map
                            │
                       Validation
                            │
                 Deterministic Calculations
                            │
                  Canonical Snapshot Builder
                            │
                    Atomic Redis Publish
                            │
                  ┌─────────┴─────────┐
                  │                   │
              Read APIs           Health APIs
                  │
                  ▼
             WhyFolio
```

---

# 8. Repository Structure

Use the repository's existing language/tooling if already established.

For a greenfield Node repository:

```text
whyfolio-nse-data-service/
│
├── src/
│   ├── config/
│   │   ├── env.*
│   │   └── nse-source-registry.*
│   │
│   ├── clients/
│   │   └── nse/
│   │       ├── nse-http-client.*
│   │       ├── nse-session.*
│   │       └── nse-discovery.*
│   │
│   ├── collectors/
│   │   ├── market/
│   │   ├── corporate-actions/
│   │   ├── announcements/
│   │   ├── financial-results/
│   │   └── xbrl/
│   │
│   ├── parsers/
│   │
│   ├── normalizers/
│   │
│   ├── identity/
│   │   └── security-map.*
│   │
│   ├── calculators/
│   │
│   ├── validators/
│   │
│   ├── models/
│   │
│   ├── redis/
│   │
│   ├── ingestion/
│   │
│   ├── services/
│   │
│   ├── routes/
│   │
│   ├── middleware/
│   │
│   └── app.*
│
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── contract/
│   └── fixtures/
│
├── scripts/
│
├── docs/
│
├── .env.example
├── package.json
└── README.md
```

---

# 9. Ingestion Pipeline

The daily pipeline is:

```text
1. Determine target NSE trading/report date
          ↓
2. Discover report availability
          ↓
3. Download source
          ↓
4. Validate response/file
          ↓
5. Parse
          ↓
6. Normalize
          ↓
7. Resolve security identity
          ↓
8. Validate records
          ↓
9. Calculate deterministic derived values
          ↓
10. Build per-security snapshots
          ↓
11. Validate complete dataset
          ↓
12. Write versioned Redis snapshot
          ↓
13. Verify Redis write
          ↓
14. Atomically publish latest dataset pointer
```

No step may publish incomplete data.

---

# 10. Daily Scheduling

Do not assume every NSE report becomes available at the same clock time.

Implement:

```text
Scheduled ingestion window
        ↓
Check source availability
        ↓
Fetch available reports
        ↓
Retry unavailable sources within bounded window
        ↓
Validate
        ↓
Publish
```

The scheduler must derive source availability from the official NSE source surfaces.

Do not hardcode undocumented timing assumptions.

---

# 11. Idempotent Ingestion

Every source ingestion must have an identity:

```text
sourceId + reportDate + contentHash
```

Rules:

```text
same source + same date + same hash
    → NO-OP

same source + same date + different hash
    → reprocess

same date + corrected official report
    → create corrected dataset version
```

---

# 12. Security Identity Resolution

Canonical identity:

```text
ISIN
```

Supporting identity:

```text
NSE symbol
security code
series
company name
```

Create one canonical mapping service:

```text
ISIN
 ↕
NSE Symbol
 ↕
Security Code
 ↕
Series
 ↕
Company Name
```

Do not create ticker-to-company hardcoded dictionaries.

If identity cannot be proven:

```text
UNRESOLVED
```

Do not guess.

---

# 13. Canonical Security Snapshot

Redis value:

```text
nse:eq:snapshot:{isin}
```

Example:

```json
{
  "schemaVersion": "1.0",
  "identity": {
    "isin": "INE...",
    "symbol": "ABC",
    "securityCode": "...",
    "series": "EQ",
    "companyName": "..."
  },

  "dataset": {
    "tradeDate": "YYYY-MM-DD",
    "generatedAt": "ISO-8601",
    "status": "CURRENT"
  },

  "market": {
    "price": {},
    "volume": {},
    "delivery": {},
    "52Week": {},
    "surveillance": {},
    "shortSelling": {},
    "marginTrading": {}
  },

  "corporateActions": [],

  "announcements": [],

  "financialResults": [],

  "integratedFilings": [],

  "xbrl": [],

  "derived": {},

  "provenance": {}
}
```

---

# 14. Provenance Model

Every source record must have a source reference:

```json
{
  "id": "EVD-NSE-000001",
  "source": "NSE",
  "report": "Financial Results",
  "publishedAt": "ISO-8601",
  "reportDate": "YYYY-MM-DD",
  "periodEnd": "YYYY-MM-DD",
  "sourceDocument": "...",
  "sourceReference": "...",
  "contentHash": "..."
}
```

For normalized/calculated values:

```json
{
  "sourceType": "CALCULATED",
  "inputs": [
    "EVD-NSE-000001",
    "EVD-NSE-000004"
  ]
}
```

The AI layer must be able to determine:

```text
what
where from
when
reported/calculated
```

---

# 15. Raw Documents vs Redis

Do not use Redis as a raw document archive.

Redis should contain:

```text
normalized structured data
document metadata
document references
provenance
derived values
```

If an NSE attachment/PDF/XBRL file must be preserved byte-for-byte, use a persistent object/file archive and reference it from Redis.

Redis is the serving layer, not the permanent document archive.

---

# 16. Redis Versioning

Use versioned snapshots:

```text
nse:eq:v:{datasetVersion}:security:{isin}
```

Latest pointer:

```text
nse:eq:latest:{isin}
```

Dataset metadata:

```text
nse:eq:dataset:latest
```

Example:

```json
{
  "datasetVersion": "2026-10-07T19:35:00Z",
  "tradeDate": "2026-10-07",
  "status": "READY"
}
```

---

# 17. Atomic Publication

Never directly overwrite the active snapshot while ingestion is still running.

Use:

```text
BUILD
  ↓
VALIDATE
  ↓
WRITE VERSIONED SNAPSHOT
  ↓
VERIFY
  ↓
SWITCH LATEST POINTER
  ↓
SET TTL
```

If ingestion fails:

```text
latest valid snapshot remains active
status = STALE
```

This prevents a failed daily download from deleting yesterday's valid dataset.

---

# 18. TTL Policy

The TTL must be aligned to the next daily refresh window.

Do not allow the active dataset to expire before the normal next refresh can complete.

Use:

```text
successful publication
        ↓
EXPIREAT = next daily refresh boundary + safety window
```

The TTL is therefore refresh-aligned rather than blindly set to exactly 24 hours from process start.

---

# 19. API Design

The API should expose business-oriented sections.

### Full security snapshot

```http
GET /api/v1/equities/:symbol
```

### Specific data

```http
GET /api/v1/equities/:symbol?sections=market
GET /api/v1/equities/:symbol?sections=financialResults
GET /api/v1/equities/:symbol?sections=corporateActions
GET /api/v1/equities/:symbol?sections=announcements
GET /api/v1/equities/:symbol?sections=xbrl
GET /api/v1/equities/:symbol?sections=derived
```

### Multiple sections

```http
GET /api/v1/equities/:symbol?sections=market,financialResults,corporateActions
```

### Batch

```http
POST /api/v1/equities/batch
```

Body:

```json
{
  "symbols": ["ABC", "XYZ"],
  "sections": ["market", "financialResults"]
}
```

### Dataset status

```http
GET /api/v1/dataset/status
```

### Service health

```http
GET /health
GET /health/redis
GET /health/nse
```

---

# 20. API Response Contract

Every response includes:

```json
{
  "status": "CURRENT",
  "datasetDate": "YYYY-MM-DD",
  "generatedAt": "ISO-8601",
  "symbol": "ABC",
  "data": {},
  "provenance": {}
}
```

Status values:

```text
CURRENT
STALE
PARTIAL
UNAVAILABLE
```

---

# 21. Partial Data Rules

If one NSE source fails:

```text
do not erase unrelated valid sections
```

Example:

```text
market = CURRENT
financialResults = CURRENT
corporateActions = CURRENT
announcements = STALE
```

The response must expose section-level freshness.

Do not mark the entire security unavailable when only one source is unavailable.

---

# 22. Validation Rules

## HTTP

- valid status
- expected content type
- non-empty response
- content hash

## Parser

- required columns
- row count > expected minimum where applicable
- duplicate detection
- numeric parsing
- date parsing

## Identity

- valid ISIN
- valid symbol
- valid series
- no unexplained identity conflicts

## Financial

- no silent unit conversion
- no invalid negative/positive transformations
- no accidental mixing of standalone and consolidated records
- preserve reported period

## Publication

```text
validation passed → publish
validation failed → preserve previous dataset
```

---

# 23. Financial-Result Normalization

Because NSE filings can differ across companies, preserve:

```text
raw record
normalized common fields
reporting classification
period
source reference
```

Common normalized fields may include:

```text
revenue
otherIncome
operatingProfit
profitBeforeTax
profitAfterTax
eps
assets
liabilities
equity
cash
borrowings
```

Only populate a normalized field when the source mapping is deterministic.

---

# 24. Announcements and Documents

Store both:

```text
event metadata
document reference
```

Example:

```json
{
  "eventId": "...",
  "subject": "...",
  "publishedAt": "...",
  "documentType": "...",
  "details": "...",
  "attachment": {
    "url": "...",
    "archiveRef": "..."
  },
  "sourceId": "EVD-NSE-..."
}
```

Do not summarize the document inside ingestion.

---

# 25. Deterministic Calculations

Calculations must be executed by code.

Examples:

```text
price change
delivery percentage
52-week position
volume comparisons
simple market ratios
period-over-period changes
corporate-action adjustments where mathematically supported
```

Every calculated output references its inputs.

Never ask the LLM to perform basic deterministic arithmetic when the backend can calculate it.

---

# 26. Data Freshness Model

Every section must expose:

```text
sourceDate
periodEnd
publishedAt
fetchedAt
freshnessStatus
```

Do not call all data "live".

Use:

```text
INTRADAY
END_OF_DAY
EVENT_TIME
PERIOD_END
LAST_AVAILABLE
STALE
```

---

# 27. Error Handling

The service must distinguish:

```text
SOURCE_UNAVAILABLE
PARSE_FAILED
IDENTITY_UNRESOLVED
VALIDATION_FAILED
REDIS_WRITE_FAILED
DATA_STALE
DATA_NOT_AVAILABLE
```

Never replace a real failure with an empty successful response.

---

# 28. Retry Policy

Use bounded retries:

```text
attempt 1
↓
exponential backoff
↓
attempt 2
↓
attempt 3
↓
mark source failure
```

Respect NSE infrastructure.

Do not continuously poll an unavailable report.

---

# 29. Concurrency Control

Only one ingestion run for the same dataset date may publish.

Use a distributed lock:

```text
lock:nse:eq:ingestion:{tradeDate}
```

Rules:

```text
lock acquired → process
lock exists → do not start duplicate run
```

The lock must have a finite TTL.

---

# 30. Ingestion State Machine

```text
SCHEDULED
   ↓
DISCOVERING
   ↓
FETCHING
   ↓
PARSING
   ↓
NORMALIZING
   ↓
VALIDATING
   ↓
BUILDING_SNAPSHOTS
   ↓
PUBLISHING
   ↓
READY
```

Failure states:

```text
FETCH_FAILED
PARSE_FAILED
VALIDATION_FAILED
PUBLISH_FAILED
```

A previous READY dataset remains active after a failed replacement.

---

# 31. Observability

Track:

```text
runId
tradeDate
startedAt
finishedAt

sourcesAttempted
sourcesSucceeded
sourcesFailed

recordsDownloaded
recordsParsed
recordsRejected
recordsUnresolved

snapshotsBuilt
snapshotsPublished

redisWriteDuration
totalDuration

currentDatasetVersion
currentDatasetStatus
```

Logs must include the source and report, not sensitive credentials.

---

# 32. Metrics

Expose service metrics:

```text
nse_ingestion_duration_seconds
nse_source_fetch_failures_total
nse_parser_failures_total
nse_records_processed_total
nse_records_rejected_total
nse_security_snapshots_published_total
nse_redis_write_failures_total
nse_dataset_age_seconds
nse_api_request_duration_seconds
```

---

# 33. Security

Environment variables:

```text
REDIS_URL
API_PORT
NSE_REQUEST_TIMEOUT
NSE_MAX_RETRIES
INGESTION_SCHEDULE
ARCHIVE_STORAGE_CONFIG
API_AUTH_CONFIG
```

Never hardcode:

```text
credentials
Redis URLs
tokens
API keys
```

All downstream APIs must support authentication before production exposure.

---

# 34. Performance Requirements

The ingestion system must perform work in bulk wherever NSE provides bulk reports.

Prefer:

```text
1 NSE bulk file
→ parse once
→ build all security records
```

over:

```text
1 HTTP request per stock
```

The API layer should perform:

```text
Redis lookup
→ section extraction
→ response
```

without making live NSE requests.

---

# 35. WhyFolio Dependency Reduction

After this service is operational:

```text
WhyFolio
   ↓
NSE Equity Data API
   ↓
Redis
```

For NSE-originated data already available through this service, WhyFolio should not independently make duplicate NSE requests.

This centralizes:

```text
fetching
parsing
normalization
validation
freshness
provenance
```

---

# 36. Copilot Implementation Rules

Before modifying code:

1. Inspect the complete repository.
2. Identify the runtime, HTTP framework, Redis client and scheduler.
3. Do not duplicate existing infrastructure.
4. Identify existing test conventions.
5. Verify every NSE source against the official website at implementation time.
6. Never invent endpoints, filenames, report schemas or fields.
7. Create the source registry first.
8. Implement one end-to-end source pipeline before adding the remaining sources.
9. Add fixtures from actual official NSE files.
10. Build parsers with schema validation.
11. Normalize only deterministic mappings.
12. Build the security identity resolver.
13. Build the canonical snapshot.
14. Add Redis versioning and atomic publication.
15. Add APIs after the data contract stabilizes.
16. Add observability and health endpoints.
17. Test failure and stale-data behavior.
18. Run all tests before completion.

Do not change unrelated behavior.

---

# 37. Definition of Done

The repository is complete when:

- official NSE source registry exists;
- daily source discovery works;
- current official report formats are verified;
- bulk reports are ingested efficiently;
- security identity mapping is deterministic;
- data is normalized into one canonical security object;
- provenance exists;
- calculations are deterministic;
- Redis snapshots are versioned;
- latest pointer publication is atomic;
- TTL is refresh-aligned;
- failed ingestion preserves the previous valid dataset;
- section-level freshness is exposed;
- APIs expose requested sections;
- health endpoints work;
- ingestion is idempotent;
- retries are bounded;
- ingestion locks prevent duplicate publishing;
- raw document references are retained;
- unit tests pass;
- integration tests pass;
- API contract tests pass;
- WhyFolio can consume the service without duplicating NSE ingestion.

---

# 38. Required First Copilot Task

Before implementing the full service, Copilot must produce:

1. Repository architecture.
2. Official NSE source registry based on currently available official NSE pages.
3. Proposed canonical security snapshot schema.
4. Redis key/versioning design.
5. Ingestion state machine.
6. API contract.
7. Test strategy.

Do not write the entire application until this design is inspected for consistency.

