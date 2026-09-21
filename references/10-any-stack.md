# Implementing in Any Stack

Digimart needs three things from a language: **SHA-512**, a **query-string encoder**, and an
**HTTPS client that can POST JSON**. Every mainstream language has all three in its standard
library, so no runtime is privileged, and a Node sidecar for a Python, Java, Go, PHP or .NET
project — or any other — is the wrong answer.

Build in the host project's language, framework, HTTP client, logger and config loader. This page
specifies what to build; [13-integration-reference.md](13-integration-reference.md) gives every
call at the wire; `templates/` shows it built in TypeScript/Node, Python, Java, Go, PHP and C#.

## The components

| # | Component | What it is |
|---|---|---|
| 1 | **Config** | One module that reads the environment and validates at startup |
| 2 | **URL signer** | Builds and signs the authorize URL for a flow |
| 3 | **The start endpoint** | The route your clients call to begin a subscription or purchase |
| 4 | **REST transport** | One `post()` that injects `applicationId` + `password`, times out, and branches on `statusCode` |
| 5 | **REST wrappers** | `getSubscribers`, `getChargingInfo`, `unsubscribe` |
| 6 | **Inbound handlers** | The redirect page and the two notification routes |
| 7 | **State** | Orders keyed by `requestId`; subscriber mapping; dedupe keys |

## 1. Config

```
DIGIMART_API_KEY                        SDK — required if any flow is used
DIGIMART_API_SECRET                     SDK — secret
DIGIMART_REDIRECT_URL                   SDK — your redirect page, absolute HTTPS
DIGIMART_SUBSCRIPTION_AUTHORIZE_URL     SDK — set only if you sell subscriptions
DIGIMART_CAAS_AUTHORIZE_URL             SDK — set only if you sell one-time charges
DIGIMART_APP_ID                         REST and notification verification
DIGIMART_PASSWORD                       REST — secret
DIGIMART_GET_SUBSCRIBERS_URL            REST — per call
DIGIMART_CHARGING_INFO_URL              REST — per call
DIGIMART_UNREGISTRATION_URL             REST — per call
```

- Only this module reads the environment.
- Validate at startup: a missing secret for an enabled surface fails the boot, not the first
  customer.
- An unset endpoint means that service is off; the code refuses to use it with a message naming
  the variable.
- Offer a redacted `describe()` for startup logs.
- Server-side only; never importable into client bundles.

## 2. URL signer

```
buildAuthorizeUrl(flow, { amount?, msisdn?, redirectUrl? }) -> { url, requestId, requestTime }

  endpoint     = flow == one-time ? CAAS_AUTHORIZE_URL : SUBSCRIPTION_AUTHORIZE_URL   # refuse if unset
  requestId    = newRequestId()                  # 15 digits, first non-zero, crypto-random
  requestTime  = utcNowIso8601Millis()           # e.g. 2024-07-08T10:33:54.929Z
  fields       = [apiKey, requestTime, apiSecret] + (flow == one-time ? [amountString] : [])
  signature    = lowercaseHex(sha512(utf8(join(fields, "|"))))
  query        = encode({ apiKey, requestId, requestTime, signature, redirectUrl, msisdn?, amount? })
  return endpoint + "?" + query
```

- `amountString` is formatted **once** and used in the hash and the query.
- For the header-enrichment subscription the page lists `amount` too — include it if the
  application uses that variant, but **do not sign it**.
- Validate before signing: `requestId` 15 digits; one-time `amount` within 1–600; `redirectUrl`
  absolute.
- Add a fixed-vector unit test: the worked example must hash to the published digest
  ([02-signatures.md](02-signatures.md)).

## 3. The start endpoint

This is the REST endpoint **you** expose, and it exists because the secret cannot leave your server.

```
POST /digimart/checkout      { itemId }            (authenticated as YOUR user)
POST /digimart/subscribe     { planId }

  price        = priceList[itemId]               # never from the request body
  requestId    = newRequestId()
  store order  { requestId, userId, itemId, amount, state: PENDING }     # BEFORE redirecting
  url          = buildAuthorizeUrl(flow, { amount, redirectUrl: DIGIMART_REDIRECT_URL })
  respond      302 Location: url                  # web
           or  200 { "url": url }                 # SPA / mobile web view opens it
```

A mobile or SPA client calls this, opens the returned URL in a browser or web view, and later asks
*your* API for the order status. It never sees the secret, the amount calculation or the
`requestId` generator.

## 4. REST transport

```
post(serviceName, body, successCodes = {"S1000"}) -> response

  url = endpointFor(serviceName)                  # refuse if unset
  send POST url
       Content-Type: application/json;charset=utf-8
       body = { applicationId, password, ...body }  # credentials injected here only
       timeout 15 s, TLS verification ON
  parse JSON
  if response.statusCode not in successCodes:
       raise DigimartError(statusCode, statusDetail, requestId, serviceName)
```

- Decide on `statusCode` in the body, never the HTTP status alone.
- The success set is a parameter: Subscriber List also accepts `S1001`.
- The error carries `statusDetail` and `requestId` — for most REST codes that is the only
  explanation Digimart gives.
- Retry transport errors with capped backoff on the read-only calls.

## 5. REST wrappers

```
getSubscribers(page, { status?, subscriberRequestId? })
    -> post("getSubscribers", { version: "2.0", requestPage: page (integer), ... }, {"S1000","S1001"})
    -> normalise subscribers to a list

getChargingInfo(subscriberIds[])
    -> post("chargingInfo", { subscriberId: subscriberIds.map(toTel) })     # array
    -> return destinationResponses, each with its own statusCode

unsubscribe(subscriberId)
    -> post("unregistration", { subscriberId: toTel(subscriberId), action: "0" })  # string "0"
    -> return subscriptionStatus (trimmed)
```

`toTel(id)` adds `tel:` with no space, once, at the boundary.

## 6. Inbound handlers

| Route | Method | Must |
|---|---|---|
| Redirect page (`DIGIMART_REDIRECT_URL`) | GET | Read `subscriptionStatus`, `subscriberId`, `requestId` from the query; look the order up; record `subscriberId` provisionally; show a screen per code; **grant nothing** |
| Charging notification | POST | 200 first; parse leniently; verify `applicationId` and `requestId`; dedupe on `internalTrxId` + `statusCode`; settle only on `S1000` with `paidAmount` = amount and `balanceDue` = 0 |
| Subscription notification | POST | 200 first; verify `applicationId`; dedupe on `subscriberId` + `status` + `timeStamp`; map `subscriberRequestId` → user; set access from `status` |

"200 first" means: acknowledge, then hand the payload to the stack's real background mechanism.

| Stack | Acknowledge-first mechanism |
|---|---|
| Node (Express, Fastify, Next.js) | Queue (BullMQ, SQS) or `setImmediate` for trivial work; never `await` the processing |
| Python (FastAPI / Django / Flask) | `BackgroundTasks`, Celery, RQ |
| Java (Spring) | `@Async`, a message queue |
| Go | Send to a buffered channel drained by workers |
| PHP (Laravel / Symfony) | A queued job; `fastcgi_finish_request()` for trivial work |
| .NET | `Channel<T>` + `BackgroundService` |
| Ruby (Rails) | ActiveJob / Sidekiq |

Exempt the notification routes from CSRF and session authentication.

## 7. State

| Store | Key | Holds |
|---|---|---|
| Orders | `requestId` | user, item, **amount**, state (`PENDING` → `PAID` → `FULFILLED`, or `FAILED`), `internalTrxId` |
| Subscribers | your user id | `subscriberId` (bare masked value), `subscriberRequestId`, `status`, `frequency`, last notified |
| Notification dedupe | the dedupe key | seen-at timestamp — a unique DB constraint or Redis `SET NX` with a TTL |

In-process maps are fine for a demo and wrong the moment a second instance runs.

## Per-language notes

| Language | SHA-512 hex | UTC `…Z` time | Query encoder | HTTP client |
|---|---|---|---|---|
| TypeScript / Node | `node:crypto` `createHash` | `toISOString()` | `URLSearchParams` | `fetch` / `undici` |
| Python | `hashlib.sha512` | `datetime.now(timezone.utc)` | `urllib.parse.urlencode` | `urllib.request`, `httpx`, `requests` |
| Java | `MessageDigest` + `HexFormat` | `Instant` + `DateTimeFormatter` | `URLEncoder` | `java.net.http.HttpClient` |
| Kotlin | same as Java | same as Java | same as Java | Ktor client / OkHttp |
| Go | `crypto/sha512` + `encoding/hex` | `time.Now().UTC().Format(...)` | `net/url.Values` | `net/http` |
| PHP | `hash('sha512', …)` | `DateTimeImmutable` in UTC | `http_build_query` | cURL / Guzzle |
| C# / .NET | `SHA512.HashData` | `DateTime.UtcNow` | `QueryHelpers` / `Uri.EscapeDataString` | `HttpClient` via `IHttpClientFactory` |
| Ruby | `Digest::SHA512.hexdigest` | `Time.now.utc.strftime` | `URI.encode_www_form` | `Net::HTTP` / Faraday |
| Rust | `sha2` + `hex` | `chrono::Utc` | `url::form_urlencoded` | `reqwest` |
| Elixir | `:crypto.hash(:sha512, s) \|> Base.encode16(case: :lower)` | `DateTime.utc_now` | `URI.encode_query` | `Req` / `Finch` |
| Dart (server) | `package:crypto` `sha512` | `DateTime.now().toUtc().toIso8601String()` (micro→milli) | `Uri(queryParameters:)` | `package:http` |

**Flutter, React Native, Swift, Kotlin Android:** these are clients. They call your start endpoint
and open the URL they get back; they never sign.

**Serverless:** fine for all of it — the start endpoint, the notification handlers and the REST
calls are all stateless requests. Put the order store and dedupe keys in a real database.

## Acceptance checklist for a port

- [ ] The worked example hashes to the published digest in a unit test.
- [ ] `node tools/digimart.mjs check-url '<url>'` passes, with the secret exported, on a URL the port built.
- [ ] `requestTime` appears byte-identically in the signing string and the URL.
- [ ] The one-time amount appears byte-identically in the signing string and the URL, and comes from the server's price list.
- [ ] `requestId` is 15 digits, unique, persisted before redirect.
- [ ] The secret is never in a URL, a response, a log or a client.
- [ ] REST calls inject credentials in one place and branch on `statusCode`.
- [ ] `subscriberId` gets `tel:` in one helper; Charging Info sends an array, Unsubscription a string.
- [ ] `requestPage` is a JSON integer; `action` is the string `"0"`.
- [ ] Handlers pass `scripts/test-callbacks.sh`, including duplicates and a forged redirect.
- [ ] Nothing is fulfilled on the redirect.
- [ ] No endpoint is called that Digimart does not publish.

## Tooling versus stack

`tools/digimart.mjs` needs Node 18+, but it is a documentation reader and a checker — it is not
part of the integration and puts no constraint on the language you build in. Without Node, read
`catalog/digimart-api.json` directly, and use the shell recipes in
[13-integration-reference.md](13-integration-reference.md).
