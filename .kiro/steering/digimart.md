<!-- Generated from AGENTS.md by scripts/sync-rules.mjs. Do not edit directly. -->

# Digimart Integration — Agent Instructions

> Portable entry point for Cursor, Windsurf, GitHub Copilot, Codex, Cline, Aider, Zed and any
> other agent that reads `AGENTS.md`. Claude Code and the Agent SDK use [SKILL.md](SKILL.md) —
> same content, skill frontmatter.

Digimart lets an application take money from a **Grameenphone** customer's mobile balance in
**Bangladesh** (BDT). It is run by **hSenid Mobile Solutions**. Two products — **subscriptions**
(recurring, `daily` or `monthly`) and **one-time charging** (CaaS, 1–600 BDT) — and one mechanism:

> **The charging services are signed URLs, not REST APIs.** Your server builds a URL, signs it with
> SHA-512 and sends the customer's **browser** to it. Digimart renders every screen, sends the
> browser back to your `redirectUrl`, and POSTs the result to a notification URL on your server.

Around those sit **three REST APIs** — Subscriber List, Subscriber Charging Info, User
Unsubscription — on a **different host with a different credential**, and the endpoints **you**
must build: a start endpoint that signs URLs, a redirect page, two notification receivers and a
cancel endpoint. Nothing else is published: no SMS, USSD, OTP or balance API.

**Apply these instructions whenever the work involves Digimart, `digimart.store`,
`user.digimart.store`, `api.digimart.store`, Grameenphone carrier billing or direct carrier billing
in Bangladesh, `caas-authorize`, `subscription/authorize`, SHA-512 signed charging URLs, or header
enrichment.**

**Any language builds a complete integration** — signing needs SHA-512, the URL needs a
query-string encoder, and the REST calls need an HTTPS client; every stack has all three in its
standard library. Write it in whatever the host project already uses. Every flow, call and callback
is written out at the wire in
[references/13-integration-reference.md](references/13-integration-reference.md) — each signed URL
as a shell recipe, each REST call as a runnable curl, each inbound surface with a replay command.
[references/10-any-stack.md](references/10-any-stack.md) specifies what surrounds them, and
reference implementations exist for TypeScript/Node, Python, Java, Go, PHP and C# as worked
examples.

---

## Non-negotiable rules

1. **Sign on the server, never on a device.** The signature needs the API Secret. Browsers and
   mobile apps call *your* start endpoint, which signs and returns the URL.
2. **Never hardcode the API Secret or the App Password.** Environment variables only, through one
   config module validated at startup. Not in source, a client bundle, a URL, a log or git history.
   The App Password arrives by email — move it into a secret store.
3. **Deliver on the notification, never on the redirect.** The redirect is forgeable and may never
   arrive. Only `statusCode` `S1000` on the charging notification (or the subscription
   notification) means money moved.
4. **Sign the right fields in the right order.** Subscription: `apiKey|requestTime|apiSecret`.
   One-time: `apiKey|requestTime|apiSecret|amount`. Pipes, no spaces, SHA-512, lowercase hex, raw
   (not URL-encoded) values. `requestTime` and `amount` byte-identical in the hash and the URL.
5. **A fresh 15-digit `requestId` per URL, persisted before redirecting.** Reuse is `E1005`; a retry
   is a new order.
6. **The amount comes from your server's price list**, never the client — 1 to 600 BDT.
7. **Cancellation must work** — a control that calls `POST /subs/unregistration` from the server.
8. **Do not invent endpoints.** SMS, USSD, OTP, balance and direct-debit tags in the OpenAPI file
   have no paths and are not Digimart APIs. Never borrow them from mSpace, Ideamart or Applink.

---

## Query the catalog instead of guessing

This repo ships the complete Digimart contract as structured data
([`catalog/digimart-api.json`](catalog/digimart-api.json)) plus a zero-dependency CLI over it.
**Run these instead of recalling parameter names** — offline, no install, no network calls.

```bash
node tools/digimart.mjs list                          # 3 flows, 3 REST calls, 3 inbound
node tools/digimart.mjs show one-time                 # full contract
node tools/digimart.mjs platform                      # hosts, credentials, endpoints you build
node tools/digimart.mjs gaps                          # not published; where the docs disagree
node tools/digimart.mjs sign --example one-time       # known digest for your hashing test
node tools/digimart.mjs url one-time amount=50 redirectUrl=https://…   # signed URL + shell recipe
node tools/digimart.mjs check-url '<url>'             # check a URL your code built
node tools/digimart.mjs redirect '<url>'              # read the redirect return
node tools/digimart.mjs curl unregistration subscriberId=tel:…         # REST call as curl
node tools/digimart.mjs validate charging-notification '<json>'        # check a payload
node tools/digimart.mjs response get-subscribers '<json>'              # read a REST response
node tools/digimart.mjs code E1002                    # decode a status code + the fix
node tools/digimart.mjs diagnose "one-time fails but subscription works"
node tools/digimart.mjs practices | checklist | reference <doc>
```

`--json` for machine-readable output. No Node? Read `catalog/digimart-api.json` directly, and use
the shell recipes in the integration reference. `sign`, `url` and `check-url` read
`DIGIMART_API_SECRET` from the environment if set, to hash locally; they never print it.

The A-to-Z route — greenfield, mid-build, or retrofitting into a live app — is
[references/11-implementation-playbook.md](references/11-implementation-playbook.md).

---

## The surface

| | What | Where |
|---|---|---|
| ⇢ | Subscription (`subscription`, and `subscription-he` with header enrichment) | Open `https://user.digimart.store/sdk/subscription/authorize` |
| ⇢ | One-time charge / CaaS (`one-time`) | Open `https://user.digimart.store/sdk/subscription/caas-authorize` |
| → | Subscriber List | `POST https://api.digimart.store/subscription-info-server/getSubscribers` |
| → | Subscriber Charging Info | `POST https://api.digimart.store/subscription/getSubscriberChargingInfo` |
| → | User Unsubscription | `POST https://api.digimart.store/subs/unregistration` |
| ← | Charging Notification | Digimart POSTs to your *Async charging resp URL* |
| ← | Subscription Notification | Digimart POSTs to your *Subscription Notification URL* |
| ← | Redirect Return | The browser GETs your `redirectUrl` with `subscriptionStatus`, `subscriberId`, `requestId` |

| | Charging SDK | REST |
|---|---|---|
| Host | `user.digimart.store` | `api.digimart.store` |
| Credential | `apiKey` + SHA-512 `signature` from the API Secret | `applicationId` + App Password in the JSON body |
| Env | `DIGIMART_API_KEY`, `DIGIMART_API_SECRET` | `DIGIMART_APP_ID`, `DIGIMART_PASSWORD` |

One environment variable per endpoint, never a shared base URL — see
[templates/.env.example](templates/.env.example).

### The endpoints you build

| Your endpoint | Does |
|---|---|
| Start endpoint (`POST /digimart/checkout`, `/digimart/subscribe`) | Price from the server, fresh `requestId` persisted, URL signed, 302 or `{ "url": … }` |
| Redirect page (your `redirectUrl`) | Screen per `subscriptionStatus`; grants nothing |
| Charging notification receiver | 200 first; verify `applicationId` + `requestId`; dedupe `internalTrxId` + `statusCode`; settle on `S1000` with `paidAmount` = amount |
| Subscription notification receiver | 200 first; map `subscriberRequestId` → user; store `subscriberId`; access from `status` |
| Cancel endpoint | `POST /subs/unregistration` with the stored `subscriberId` as `tel:<id>`, `action` `"0"` |
| Reconciliation job | Pages Subscriber List for missed notifications |

---

## Common mistakes

- ❌ Building or signing the URL in browser or mobile code — the secret ships to every device.
- ❌ `apiKey|apiSecret|requestTime` — the secret goes in the **middle**: `apiKey|requestTime|apiSecret`.
- ❌ Signing three fields on a one-time charge — `E1002` every time. The amount is the fourth field.
- ❌ Signing the amount on a subscription (the header-enrichment variant lists it, unsigned).
- ❌ Formatting `requestTime` or `amount` once for the hash and again for the URL.
- ❌ Dhaka wall-clock time with a `Z` suffix — six hours wrong. Use the true UTC instant.
- ❌ SHA-256, uppercase hex, or hashing URL-encoded values.
- ❌ `requestId` from the millisecond clock — collides under load (`E1005`); reusing one on retry.
- ❌ Taking the amount from the client.
- ❌ Granting access or delivering goods on the redirect — anyone can type `?subscriptionStatus=S1000`.
- ❌ Expecting JSON or the word `CHARGED` on the redirect — it is query parameters with a status code.
- ❌ Implementing only one notification receiver — the flows post to different fields.
- ❌ Doing work before answering 200; not deduplicating; trusting an unauthenticated body.
- ❌ Calling the REST APIs with the API Key and a signature — REST uses `applicationId` + App Password.
- ❌ One base URL for both hosts.
- ❌ `subscriberId` without `tel:` on REST calls; a bare string on Charging Info (it is an array);
  an array on Unsubscription (it is one string); `requestPage` as a string; `action` as a number.
- ❌ Reading only the top-level `statusCode` on Charging Info — check each `destinationResponses` entry.
- ❌ Giving `E1100`–`E1107` a meaning from another platform — Digimart publishes none.
- ❌ No cancel path, or a cancel endpoint that accepts a `subscriberId` from the client.
- ❌ A raw error code shown to a customer; no friendly screen for `E3009`.
- ❌ Calling an SMS, USSD, OTP, balance or direct-debit endpoint on Digimart.
- ❌ Disabled TLS verification in shipped code.
- ❌ `NEXT_PUBLIC_` / `VITE_` / `REACT_APP_` / `PUBLIC_` / `EXPO_PUBLIC_` on any Digimart variable.
- ❌ A Node sidecar (or any second runtime) to reach Digimart from a non-JS project.
- ❌ Logging the API Secret, the App Password, a full signed URL, or an unmasked MSISDN.

---

## When you generate code, always

- Put credentials in `.env` (git-ignored) with a placeholder-only `.env.example`.
- Validate config at startup and fail loudly on missing variables.
- Add a unit test that hashes Digimart's worked example to the published digest.
- Persist the order (`requestId`, user, item, amount, state) before redirecting.
- Make notification handlers acknowledge first, validate, verify `applicationId` and `requestId`,
  and deduplicate.
- Set an explicit timeout on every REST call and branch on `statusCode` in the body.
- Store `subscriberId` against your user; add `tel:` in one helper.
- Use a decimal type for money. The currency is `BDT`.
- Log `requestId` / `internalTrxId` / `statusCode`; mask `subscriberId`.
- Match the host project's existing stack, structure and conventions.

## Reference

`references/01-getting-started.md` · `02-signatures.md` · `03-subscription-sdk.md` ·
`04-one-time-sdk.md` · `05-callbacks.md` · `06-rest-apis.md` · `07-status-codes.md` ·
`08-security-best-practices.md` · `09-production-checklist.md` · `10-any-stack.md` ·
`11-implementation-playbook.md` · `12-source-discrepancies.md` · `13-integration-reference.md`

Worked implementations in TypeScript/Node, Python, Java, Go, PHP and C#: `templates/`.

Documentation: <https://digimart.store/docs> · Support: support@digimart.store
