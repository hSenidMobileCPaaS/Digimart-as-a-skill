---
name: digimart-scaffold
description: Scaffold a new Digimart integration from scratch — environment config, credential handling, the SHA-512 URL signer with a fixed-vector test, the start endpoint that clients call, the REST client, and the order store. Use when adding Digimart to a project for the first time, or when asked to set up, bootstrap or start a Digimart integration.
---

# Scaffold a Digimart integration

Build in this order. Config first means no secret ever has a chance to land in a source file; the
signer's fixed-vector test first means you never debug hashing against the platform.

## 1. Establish what exists

- An **approved application** with an API Key and API Secret? (Shown on the app in the portal once
  approved.) Without one, build everything against the worked example and the replay scripts.
- **CaaS API** and **Subscription Charging SDK** enabled on it? (`E1008` / `E1011` otherwise.)
- **Subscriptions, one-time charges, or both?** Header enrichment on or off?
- **Notification URLs** — *Subscription Notification URL* and *Async charging resp URL* — public
  HTTPS and set on the application?
- The **App Password** (emailed at app creation) for the REST calls?
- What are the clients — server-rendered web, SPA, mobile app? Decides 302 or JSON from the start
  endpoint.

## 2. Pick the stack — the host project's

`templates/` has config + client + handlers for **TypeScript/Node, Python, Java, Go, PHP and C#**.
For anything else, `references/10-any-stack.md` and `references/13-integration-reference.md`.
Never add a second runtime.

## 3. Config before code

Copy `templates/.env.example` (identical variable names in every language) and your language's
config file. One module reads the environment, validates at startup and fails loudly; one endpoint
variable per service; secrets never reachable from a client bundle.

## 4. The signer, with a fixed-vector test

```
signingString = join([apiKey, requestTime, apiSecret] (+ [amount] for one-time), "|")
signature     = lowercase_hex(sha512(utf8(signingString)))
```

First test, before anything else:

```
sha512("myApiKey123|2024-08-08T12:00:00Z|mySecretKey456|50")
  == "3badf638ceca499000fd07b899e5fc0cec348d9762886b8430104291126683892845a208caef8e99b53432571e46c5f04162a1a25646443f7935239ea0901b38"
```

`requestTime` is the current UTC instant with a `Z`, formatted **once**. `requestId` is 15 random
digits, first non-zero. See `references/02-signatures.md`.

## 5. The start endpoint — the REST API you expose

```
POST /digimart/checkout {itemId}     (your authenticated user)
  price = priceList[itemId]                          # never from the request
  requestId = newRequestId(); save order PENDING     # BEFORE redirecting
  url = buildAuthorizeUrl("one-time", {amount: price, redirectUrl})
  302 → url      (or 200 {"url": url} for an SPA or a mobile web view)
```

And `POST /digimart/subscribe {planId}` for subscriptions. Check the output with
`node tools/digimart.mjs check-url '<url your code built>'` and `DIGIMART_API_SECRET` exported.

## 6. REST client

One `post()` that injects `applicationId` + `password`, sets a 15 s timeout and branches on
`statusCode` (Subscriber List also accepts `S1001`), plus `getSubscribers`, `getChargingInfo`,
`unsubscribe` and a `toTel()` helper. Take each call from
`references/13-integration-reference.md`, and run the curl first.

## 7. Inbound

The redirect page and both notification receivers — use the `digimart-callbacks` skill.

## 8. Verify

```bash
node tools/digimart.mjs sign --example one-time
node tools/digimart.mjs check-url '<url>'
./scripts/test-callbacks.sh http://localhost:3000
./scripts/smoke-test.sh           # REST credentials; or .\scripts\smoke-test.ps1
```

For a port into a stack with no template, finish with the acceptance checklist in
`references/10-any-stack.md`. Match the host project's conventions; the templates are a
specification, not a framework to impose.
