Yes. **An Angular developer portal + a detached control-plane database is the right approach** if you want `whyfolio-market-core` to eventually serve not only WhyFolio but other trusted applications.

The key is to separate **data plane** from **control plane**.

## Recommended architecture

```text
                    ┌─────────────────────────┐
                    │  Market Data Developer  │
                    │       Portal (Angular)  │
                    └────────────┬────────────┘
                                 │
                         WhyFolio Auth
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │ Developer/Auth API       │
                    │ Node.js                  │
                    └────────────┬────────────┘
                                 │
             ┌───────────────────┼───────────────────┐
             │                   │                   │
             ▼                   ▼                   ▼
       App Registration      API Key Mgmt       Usage Analytics
             │                   │                   │
             └───────────────────┼───────────────────┘
                                 ▼
                      CONTROL-PLANE DATABASE
                                 │
                                 │ validates API key
                                 ▼
                    ┌─────────────────────────┐
                    │ NSE Market Data API     │
                    │                         │
                    │ /api/v1/market/...      │
                    └────────────┬────────────┘
                                 │
                              Redis
                                 │
                           NSE dataset
```

### The important separation

**Control plane DB**

Stores:

```text
applications
developers
API credentials
scopes
rate limits
status
subscriptions
usage aggregates
key rotation/revocation
```

**Redis**

Stores:

```text
NSE market/security data
daily snapshots
dataset status
```

Do **not** mix API registration/usage data with the NSE market dataset.

---

# 1. Angular developer portal

Yes, Angular is appropriate.

Example:

```text
market.whyfolio.com
```

Pages:

```text
Login
   ↓
Developer Dashboard
   ├── My Applications
   ├── Create Application
   ├── API Keys
   ├── Usage
   ├── Rate Limits
   └── Documentation
```

### Create Application

```text
Application Name
Description
Environment
    Development
    Production

Requested Scopes
    market:read
    fundamentals:read
    announcements:read
    corporate-actions:read
    results:read

Create
```

The browser should **never generate the secret**.

---

# 2. Registration flow

```text
User logs into WhyFolio
        ↓
Angular Developer Portal
        ↓
POST /developer/v1/apps
        ↓
Market Core Control API
        ↓
Create application
        ↓
Generate clientId
Generate API key
        ↓
Hash API key
        ↓
Store hash in control DB
        ↓
Return plaintext API key ONCE
        ↓
Angular displays:
"Copy this key now"
```

After leaving that screen:

```text
Raw API key cannot be retrieved again.
```

This is important.

---

# 3. Do not store the API key itself

Store:

```text
clientId
apiKeyHash
keyPrefix
createdAt
expiresAt
revokedAt
lastUsedAt
```

Example:

```json
{
  "clientId": "wf_app_8f93...",
  "keyPrefix": "wfmk_live_7a91",
  "apiKeyHash": "$argon2id$...",
  "status": "ACTIVE",
  "scopes": ["market:read", "fundamentals:read"],
  "createdAt": "...",
  "expiresAt": "...",
  "lastUsedAt": "..."
}
```

The actual key is shown only once.

Use a cryptographic hash such as Argon2id rather than reversible encryption when you don't need to recover the secret.

---

# 4. API request

For machine-to-machine access:

```http
GET /api/v1/market/equities/IREDA
Authorization: Bearer wfmk_live_xxxxxxxxx
```

or:

```http
X-API-Key: wfmk_live_xxxxxxxxx
```

I would use:

```http
Authorization: Bearer <api-key>
```

because it fits common HTTP authentication conventions.

---

# 5. API-key middleware

Every business API:

```text
Request
  ↓
Authentication
  ↓
API key lookup/hash verification
  ↓
Application status
  ↓
Key status
  ↓
Expiration
  ↓
Scope
  ↓
Rate limit
  ↓
API handler
```

Example:

```text
API Key
   ↓
Identify application
   ↓
ACTIVE?
   ↓
Not expired?
   ↓
Has market:read?
   ↓
Rate limit OK?
   ↓
Redis data
```

---

# 6. Scopes

Don't make every API key all-powerful.

Example:

```text
market:read
fundamentals:read
results:read
announcements:read
corporate-actions:read
surveillance:read
derived:read
```

An application may receive:

```json
{
  "scopes": ["market:read", "fundamentals:read", "results:read"]
}
```

Then:

```http
GET /corporate-actions
```

returns `403` if the application lacks that scope.

---

# 7. Your detached database

Yes, this is a good idea.

I would make it the **control-plane database for the microservice**.

### Applications

```text
applications
```

```json
{
  "appId": "...",
  "name": "WhyFolio",
  "ownerUserId": "...",
  "environment": "PRODUCTION",
  "status": "ACTIVE",
  "scopes": [],
  "rateLimit": {},
  "createdAt": "...",
  "updatedAt": "..."
}
```

### API Keys

```text
api_keys
```

```json
{
  "keyId": "...",
  "appId": "...",
  "keyPrefix": "...",
  "secretHash": "...",
  "status": "ACTIVE",
  "createdAt": "...",
  "expiresAt": null,
  "lastUsedAt": null,
  "revokedAt": null
}
```

### Usage

Do **not** write a heavy analytics record synchronously for every API request into the main application record.

Use an event/usage collection:

```text
api_usage_events
```

or an aggregation pipeline:

```text
API request
   ↓
Redis counter / lightweight event
   ↓
periodic aggregation
   ↓
usage_daily
```

Example:

```json
{
  "appId": "whyfolio",
  "date": "2026-10-07",
  "endpoint": "/equities/:symbol",
  "requests": 18432,
  "success": 18102,
  "errors": 330,
  "avgLatencyMs": 42
}
```

That gives you:

```text
Today
7 days
30 days
endpoint usage
error rate
latency
quota
```

without making the database a bottleneck.

---

# 8. Key rotation

The dashboard should provide:

```text
Create new key
Revoke key
View key metadata
```

Never replace a key instantly.

Support:

```text
Key A → ACTIVE
Key B → ACTIVE
      ↓
deploy new key
      ↓
revoke Key A
```

This allows zero-downtime rotation.

---

# 9. WhyFolio's own registration

Since WhyFolio is your first consumer, I would **pre-register WhyFolio as a production application** rather than making the production backend depend on a manually created developer account.

Example:

```text
Application:
WhyFolio Production

Client ID:
wf_app_prod_...

API Key:
wfmk_live_...

Scopes:
market:read
fundamentals:read
results:read
announcements:read
corporate-actions:read
derived:read
```

Store the secret in your production secret manager/environment, **not Angular and not Git**.

---

# 10. Important distinction: authentication vs authorization

Your service should perform both:

```text
Authentication
"Who is calling me?"
        ↓
clientId / API key

Authorization
"What is this application allowed to access?"
        ↓
scopes
```

And then:

```text
Rate limiting
"How much may it call?"
```

---

# 11. Recommended API structure

```text
/api/v1/
    market/
        equities/:symbol
        equities/:symbol/market
        equities/:symbol/fundamentals
        equities/:symbol/results
        equities/:symbol/announcements
        equities/:symbol/corporate-actions
        equities/:symbol/derived

/developer/v1/
    applications
    applications/:appId
    applications/:appId/keys
    applications/:appId/usage

/internal/v1/
    ingestion
    dataset
    admin

/health
/ready
```

`/developer` is authenticated with **WhyFolio user authentication**.

`/market` uses **API-key authentication**.

`/internal` uses **service-to-service authentication**, not public API keys.

---

## Final architecture

```text
                     WHYFOLIO USER
                          │
                          ▼
                ┌───────────────────┐
                │ Angular Developer │
                │ Portal             │
                └─────────┬─────────┘
                          │
                     WhyFolio JWT
                          │
                          ▼
                ┌───────────────────┐
                │ Control Plane API │
                └─────────┬─────────┘
                          │
              ┌───────────┼───────────┐
              ▼           ▼           ▼
           Apps        API Keys     Usage
              │           │           │
              └───────────┼───────────┘
                          ▼
                CONTROL-PLANE DB
                          │
                          │ API key validation
                          ▼
                MARKET DATA API
                          │
                    scope + rate
                          │
                          ▼
                       REDIS
                          │
                          ▼
                     NSE DATA
```

So yes: **Angular developer portal + detached control-plane DB + API-key management + usage analytics is a sound production design.** The one thing I would explicitly avoid is storing the actual API secret in the database or making the Angular application responsible for secret generation/validation.
