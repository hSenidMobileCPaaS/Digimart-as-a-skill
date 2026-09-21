# Templates

Working reference implementations of a Digimart integration. **They are a specification, not a
framework to impose.** Read the one closest to the host project, port the structure, and keep that
project's own conventions.

Digimart needs SHA-512, a query-string encoder and an HTTPS client — every language has all three
in its standard library, so no runtime is privileged. Pick by what the project already uses;
introducing a second runtime because a sample was in another language is a worse outcome than any
template mismatch.

| Stack | Files | Notes |
|---|---|---|
| **Any** | [.env.example](.env.example) | The environment surface, identical everywhere: the application id, the SDK key and secret, the App Password, and one URL per flow or call |
| **TypeScript / Node** | [typescript/](typescript/) — `digimart-config.ts`, `digimart-client.ts`, `digimart-routes-express.ts` | `node:crypto` + `fetch`. Routes on Express; the logic ports to Fastify, Hono, NestJS or Next.js route handlers unchanged. Runs under Node's type stripping. |
| **Python** | [python/](python/) — `digimart_config.py`, `digimart_client.py`, `callbacks_fastapi.py` | Standard library only (`hashlib`, `urllib`); `httpx`/`requests` swap noted inline. Routes on FastAPI with `BackgroundTasks`; Django and Flask notes in the header. |
| **Java** | [java/](java/) — `DigimartConfig.java`, `DigimartClient.java`, `DigimartController.java` | Java 17 `HttpClient`, `MessageDigest`, Jackson. Routes on Spring Boot, notifications processed with `@Async`. |
| **Go** | [go/](go/) — `config.go`, `client.go`, `callbacks.go` | Standard library only. `http.HandlerFunc`s with Go 1.22 method patterns; a worker goroutine drains notifications. |
| **PHP** | [php/](php/) — `DigimartConfig.php`, `DigimartClient.php`, `callbacks.php` | PHP 8.1+, ext-curl and ext-bcmath, no Composer dependency. A framework-neutral front controller with Laravel notes. |
| **C# / .NET** | [csharp/](csharp/) — `DigimartOptions.cs`, `DigimartClient.cs`, `DigimartEndpoints.cs` | .NET 8, `IHttpClientFactory`, `System.Text.Json`. Minimal APIs, a `Channel<T>` and a `BackgroundService`. |

Every port implements the same components with the same environment variable names. The
language-neutral specification — including an acceptance checklist for stacks with no template here
(Ruby, Rust, Kotlin, Elixir, Dart, …) — is [references/10-any-stack.md](../references/10-any-stack.md).

**No template for your stack?** Nothing is missing. Take every flow and call from
[references/13-integration-reference.md](../references/13-integration-reference.md) and build the
components around them.

## What every template does the same way

- **One config module** reads the environment, validates at startup, and refuses to resolve an
  endpoint that is not configured.
- **The signer** joins `apiKey|requestTime|apiSecret` (+ `|amount` for one-time) and hashes it with
  SHA-512 to lowercase hex — and documents the known answer for the worked example, so the first
  test you write proves the hashing.
- **`requestTime` is formatted once** (current UTC instant, milliseconds, `Z`) and **the amount is
  formatted once**, and the same strings go into the hash and the URL.
- **`requestId` is 15 random digits** with a non-zero first digit — never the clock.
- **The one-time amount is validated to 1–600 BDT** before signing, and comes from a server-side
  price list in the start endpoint.
- **The start endpoint** persists the order (or pending subscription) **before** redirecting, and
  answers 302 for a browser or `{ "url": … }` for an SPA or mobile web view.
- **The redirect page grants nothing.** It records `subscriberId` provisionally and returns a
  message chosen from the code — never the raw code.
- **Notifications answer 200 first**, then verify `applicationId`, deduplicate
  (`internalTrxId` + `statusCode`; `subscriberId` + `status` + `timeStamp`), and settle a charge
  only when `statusCode` is `S1000`, `paidAmount` equals the order amount and `balanceDue` is `0` —
  compared as decimals.
- **The REST client** injects `applicationId` + `password` in one place, sets a 15-second timeout,
  decides success on `statusCode` (Subscriber List also accepts `S1001`), normalises
  `subscribers` to a list, sends Charging Info an array and Unsubscription a single string, and
  sends `action` as the string `"0"`.
- **One `toTel()` helper** adds `tel:` with no space; `fromTel()` strips it (and the stray space).
- **Cancel** reads the `subscriberId` from the server's store, never from the client, and ends
  access on `UNREGISTERED`.
- **TLS verification is never disabled.**

## What each template deliberately leaves to you

| Store | Shipped as | Production answer |
|---|---|---|
| Orders (`requestId` → user, item, amount, state, `internalTrxId`) | in-process map (PHP: a temp JSON file) | Your database, written **before** the redirect |
| Subscribers (`userId` → `subscriberId`, status, frequency) | in-process map | Your database |
| Notification dedupe keys | in-process set | A unique constraint or Redis `SET NX` with a TTL |
| The background mechanism | `setImmediate` / `BackgroundTasks` / `@Async` / goroutine / `fastcgi_finish_request` / `BackgroundService` | A real queue if the work is more than trivial |
| Authentication | an `X-User-Id` header | Your session or token auth |

## Testing a port

```bash
node tools/digimart.mjs sign --example one-time                  # the digest your signer must produce
DIGIMART_API_SECRET=… node tools/digimart.mjs check-url '<url>'  # a URL your port built
./scripts/test-callbacks.sh http://localhost:3000                # the inbound routes
./scripts/smoke-test.sh                                          # the REST credentials
```

Then walk the acceptance checklist in
[references/10-any-stack.md](../references/10-any-stack.md#acceptance-checklist-for-a-port).
