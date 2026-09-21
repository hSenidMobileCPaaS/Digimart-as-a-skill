---
name: digimart
description: Build and integrate Digimart (hSenid Mobile's Bangladesh platform for charging Grameenphone subscribers' mobile balance) into any application — the Subscription Charging SDK (with and without header enrichment), the One-Time Charging SDK (CaaS), SHA-512 signed authorize URLs, the redirect return, the subscription and charging notifications, and the REST APIs for subscriber list, subscriber charging info and unsubscription. Use this whenever the user mentions Digimart, digimart.store, user.digimart.store, api.digimart.store, Grameenphone carrier billing or direct carrier billing in Bangladesh, BDT mobile-balance charging, caas-authorize, subscription/authorize, requestId/requestTime/signature URL signing, or header enrichment. Covers URL signing, the endpoints you must build, notification handlers, status codes, credential handling and go-live requirements.
---

# Digimart Integration Skill

Digimart lets an application take money from a **Grameenphone** customer's mobile balance in
**Bangladesh** (BDT). It is run by **hSenid Mobile Solutions**. There are two products —
**subscriptions** (recurring, `daily` or `monthly`) and **one-time charging** (CaaS, 1–600 BDT) —
and both work the same way:

> **The charging services are signed URLs, not REST APIs.** Your server builds a URL, signs it with
> SHA-512, and sends the customer's **browser** to it. Digimart renders every screen — number entry,
> OTP, confirmation — then sends the browser back to your `redirectUrl` and POSTs the result to a
> notification URL on your server. There is no request body, no JSON and nothing to POST.

Around those flows sit **three REST APIs** (list subscribers, look them up, unsubscribe) on a
**different host with a different credential**, and **the endpoints you must build yourself**:
the start endpoint that signs URLs, the redirect page, two notification receivers and a cancel
endpoint. That is the whole published surface. Nothing else exists on Digimart — no SMS, USSD, OTP
or balance API, whatever other hSenid platforms offer.

This skill makes you able to build a correct, production-shaped Digimart integration from scratch,
or add Digimart to an existing product, **in any language**. Signing needs SHA-512, the URL needs a
query-string encoder, and the REST calls need an HTTPS client — every stack has all three in its
standard library. Build in whatever the host project already uses.

**Every flow, call and callback comes from one place:
[references/13-integration-reference.md](references/13-integration-reference.md).** It writes each
signed-URL flow as a shell recipe (POSIX shell + openssl), each REST call as a runnable curl, and
each inbound surface with a command that replays it — with every parameter and field defined.
Translate it into the host project's idiom, and that is the integration.

---

## The rules you must never break

1. **Sign on the server, never on a device.** The signature needs the **API Secret**. Browser
   JavaScript, mobile apps, Flutter and React Native call *your* start endpoint, which signs the
   URL and returns it. A secret in a client means anyone can charge your customers.

2. **Never hardcode the API Secret or the App Password.** Environment variables, read through one
   config module validated at startup. Never in source, a client bundle, a log, a URL or git
   history. The App Password arrives **by email** — move it into a secret store and delete the mail.

3. **Deliver on the notification, never on the redirect.** The redirect travels through the
   customer's browser: it may never arrive, and anyone can type
   `?subscriptionStatus=S1000` onto your `redirectUrl`. Only the notification — `statusCode`
   `S1000` on the *Async charging resp URL*, or the subscription notification — means money moved.

4. **Sign the right fields in the right order.** Subscriptions: `apiKey|requestTime|apiSecret`.
   One-time: `apiKey|requestTime|apiSecret|amount`. Pipes, no spaces, SHA-512, **lowercase hex**.
   The secret sits in the middle. `requestTime` and `amount` must be byte-identical in the hash and
   the URL — build each into a variable once.

5. **A fresh 15-digit `requestId` for every URL, persisted before the redirect.** It is how the
   redirect and the notification find the order. Reuse is rejected with `E1005`; a "retry" is a
   new order with a new `requestId`.

6. **Decide the amount on the server.** From your own price list, never from the client. It is
   signed, so Digimart will honour whatever you sign. One-time charges must be 1–600 BDT.

7. **Cancellation must work.** Build a cancel control that calls `POST /subs/unregistration` from
   the server. It is on Digimart's go-live checklist.

8. **Do not invent endpoints.** The OpenAPI file behind Digimart's docs carries leftover tag
   descriptions for SMS, USSD, OTP, balance and direct-debit operations with **no paths**. They are
   not Digimart APIs. Never borrow them from mSpace, Ideamart or Applink.

---

## Query the contract, do not recall it

The complete Digimart contract ships as structured data
([`catalog/digimart-api.json`](catalog/digimart-api.json)) with a zero-dependency CLI over it. Run
it instead of reconstructing parameter names from memory — it is offline, needs no install, and
makes no network call.

```bash
node tools/digimart.mjs list                        # 3 flows, 3 REST calls, 3 inbound
node tools/digimart.mjs show <id>                   # full contract for one
node tools/digimart.mjs platform                    # hosts, credentials, the endpoints you build
node tools/digimart.mjs gaps                        # what is NOT published; where the docs disagree

node tools/digimart.mjs sign --example one-time     # the known digest to test your hashing against
node tools/digimart.mjs url <flow> [k=v …]          # a signed authorize URL + the shell recipe
node tools/digimart.mjs check-url '<url>'           # check a URL your code built
node tools/digimart.mjs redirect '<url>'            # read what came back on the redirect

node tools/digimart.mjs curl <id> [k=v …]           # a REST call as runnable curl
node tools/digimart.mjs validate <id> '<json>'      # check a REST body or a notification
node tools/digimart.mjs response <id> '<json>'      # read a REST response against the contract

node tools/digimart.mjs code <statusCode>           # decode a code + the fix
node tools/digimart.mjs diagnose "<symptom>"        # cause and fix from a symptom
node tools/digimart.mjs practices | checklist | reference <doc>
```

`--json` on any command for machine-readable output. If you cannot run commands, read
`catalog/digimart-api.json` directly — same data, plain JSON.

`sign`, `url` and `check-url` read `DIGIMART_API_SECRET` from the environment **if it is set**, to
compute a SHA-512 locally; they never print it and never send it anywhere. Without it they print the
signing string and an `openssl` recipe. Every other command never touches a credential.

**Working order:** `list` / `show` for the contract → the integration reference for the call →
`sign --example` to prove your hashing → `check-url` on a URL your code built → `validate` a
notification → `code` / `diagnose` when something fails.

**Whole-integration order:**
[references/11-implementation-playbook.md](references/11-implementation-playbook.md) — greenfield,
mid-build, and retrofitting into a live application.

---

## The surface

| | What | Where | Reference |
|---|---|---|---|
| ⇢ | **Subscription** (`subscription`) | Open `https://user.digimart.store/sdk/subscription/authorize` | [03-subscription-sdk](references/03-subscription-sdk.md) |
| ⇢ | **Subscription with header enrichment** (`subscription-he`) | Same URL and signature; admin-enabled; Grameenphone supplies the number | [03-subscription-sdk](references/03-subscription-sdk.md) |
| ⇢ | **One-time charge / CaaS** (`one-time`) | Open `https://user.digimart.store/sdk/subscription/caas-authorize` with a signed `amount` | [04-one-time-sdk](references/04-one-time-sdk.md) |
| → | **Subscriber List** (`get-subscribers`) | `POST https://api.digimart.store/subscription-info-server/getSubscribers` | [06-rest-apis](references/06-rest-apis.md) |
| → | **Subscriber Charging Info** (`subscriber-charging-info`) | `POST https://api.digimart.store/subscription/getSubscriberChargingInfo` | [06-rest-apis](references/06-rest-apis.md) |
| → | **User Unsubscription** (`unregistration`) | `POST https://api.digimart.store/subs/unregistration` | [06-rest-apis](references/06-rest-apis.md) |
| ← | **Charging Notification** (`charging-notification`) | Digimart POSTs to your *Async charging resp URL* | [05-callbacks](references/05-callbacks.md) |
| ← | **Subscription Notification** (`subscription-notification`) | Digimart POSTs to your *Subscription Notification URL* (spec: `/subscription/notify`) | [05-callbacks](references/05-callbacks.md) |
| ← | **Redirect Return** (`redirect-return`) | The browser GETs your `redirectUrl` with `subscriptionStatus`, `subscriberId`, `requestId` | [05-callbacks](references/05-callbacks.md) |

⇢ you build a URL the browser opens · → your server calls Digimart · ← Digimart calls you

### Two surfaces, two hosts, two credentials

| | Charging SDK | REST |
|---|---|---|
| Host | `user.digimart.store` | `api.digimart.store` |
| Credential | `apiKey` in the URL + SHA-512 `signature` from the **API Secret** | `applicationId` + **App Password** in the JSON body |
| Env | `DIGIMART_API_KEY`, `DIGIMART_API_SECRET` | `DIGIMART_APP_ID`, `DIGIMART_PASSWORD` |

**One environment variable per endpoint** — `DIGIMART_CAAS_AUTHORIZE_URL`,
`DIGIMART_UNREGISTRATION_URL`, and so on — never one shared base URL. See
[templates/.env.example](templates/.env.example).

### The endpoints you build

The services are few; the endpoints *you* must expose are what make the integration work:

| Your endpoint | Why |
|---|---|
| **Start endpoint** (`POST /digimart/checkout`, `/digimart/subscribe`) | Prices the item, allocates and persists the `requestId`, signs the URL, answers 302 or `{ "url": … }`. Clients call this; they never sign. |
| **Redirect page** (`GET` your `redirectUrl`) | Shows the right screen from `subscriptionStatus`. Grants nothing. |
| **Charging notification receiver** (`POST`, public HTTPS) | Settles orders. 200 first, verify, dedupe on `internalTrxId` + `statusCode`. |
| **Subscription notification receiver** (`POST`, public HTTPS) | Maps `subscriberRequestId` → user, stores `subscriberId`, sets access from `status`. |
| **Cancel endpoint** (`POST /digimart/unsubscribe`) | Calls `/subs/unregistration` with the subscriber's stored id. |
| **Reconciliation job** | Pages Subscriber List to catch missed notifications. |

---

## How to approach a Digimart task

**Step 1 — Establish what exists.** An approved application with API Key + Secret? The CaaS API and
the Subscription Charging SDK enabled on it? Header enrichment on or off? Notification URLs set and
reachable? The App Password in hand? Subscriptions, one-time charges, or both? If there is no
approved app yet, build and test everything against the worked example and the replay scripts —
see [references/01-getting-started.md](references/01-getting-started.md).

**Step 2 — Pick the stack: the host project's.** A Django codebase gets Python, a Spring service
gets Java, a Laravel app gets PHP. Never add a runtime to reach Digimart.

**Step 3 — Config before code.** Copy [templates/.env.example](templates/.env.example) — the
variable names are identical in every language — and the config file from the matching directory
in [templates/](templates/README.md).

**Step 4 — Signer with a fixed-vector test**, then the start endpoint, then the inbound handlers,
then the REST client. [references/10-any-stack.md](references/10-any-stack.md) specifies each
component language-neutrally.

**Step 5 — Status codes by what the user should do next**, never raw.
[references/07-status-codes.md](references/07-status-codes.md). The SDK codes and the REST codes
are separate sets; most REST codes have **no published meaning** — log `statusDetail` and
escalate, never borrow a meaning.

**Step 6 — Go-live checklist**:
[references/09-production-checklist.md](references/09-production-checklist.md).

---

## Non-obvious things that will bite you

- **The secret is in the middle.** `apiKey|requestTime|apiSecret`. `apiKey|apiSecret|requestTime`
  hashes cleanly and fails every time with `E1002`.
- **One-time signs the amount; subscriptions do not.** The header-enrichment subscription even
  lists an `amount` parameter — it is not signed there.
- **`requestTime` is the current instant in UTC with a `Z`** — `2024-07-08T10:33:54.929Z`. The
  docs say "generate it in Asia/Dhaka"; every published code sample produces true UTC. Dhaka
  wall-clock time with a `Z` is six hours wrong (`E1004`).
- **`subscriptionStatus` on the redirect is a status code** (`S1000`, `E3009`…), not `REGISTERED`
  or `CHARGED`, and it arrives as query parameters, not JSON.
- **Different flows notify different fields.** The subscription flow posts to the *Subscription
  Notification URL*; one-time charges and header-enrichment subscriptions post to the *Async
  charging resp URL*. Implement both receivers.
- **`subscriberId` is a masked number** with no `tel:` prefix on the redirect and notifications;
  the REST calls want `tel:<value>`. Store it; add the prefix in one helper.
- **`E3009` (balance too low) is the most common production failure.** Design a kind recharge
  screen for it.
- **Most REST status codes have no published meaning.** `S1001` and `E1100`–`E1107` are permitted
  on the subscriber list and described nowhere. `statusDetail` is all you get.
- **The notifications are unauthenticated** — no signature, no token, no published IP list.
  Verify `applicationId` and the `requestId`, and reconcile with the REST lookups.
- **No response body is published for notifications.** Answer HTTP 200 fast and do the work
  asynchronously.
- **Digimart's docs disagree with themselves in places.** The register, with the reading this skill
  uses: [references/12-source-discrepancies.md](references/12-source-discrepancies.md).

---

## Reference files

| File | Contents |
|---|---|
| [01-getting-started.md](references/01-getting-started.md) | What Digimart is, account, provisioning, credentials, hosts, sandbox, first checks, obligations |
| [02-signatures.md](references/02-signatures.md) | SHA-512 signing, known-answer digests, per-language notes, debugging `E1002` |
| [03-subscription-sdk.md](references/03-subscription-sdk.md) | Subscription flow, both variants, states, the `subscriberId` mapping |
| [04-one-time-sdk.md](references/04-one-time-sdk.md) | One-time charging, the signed amount, the 1–600 BDT band, the order state machine |
| [05-callbacks.md](references/05-callbacks.md) | The redirect return and both notifications, field by field, and how to handle them |
| [06-rest-apis.md](references/06-rest-apis.md) | Subscriber List, Subscriber Charging Info, User Unsubscription |
| [07-status-codes.md](references/07-status-codes.md) | All 31 SDK codes, the REST codes, classes and a handling strategy |
| [08-security-best-practices.md](references/08-security-best-practices.md) | Secrets, server-side signing, untrusted returns, TLS, data, consent |
| [09-production-checklist.md](references/09-production-checklist.md) | Pre-go-live verification |
| [10-any-stack.md](references/10-any-stack.md) | The components, language-neutrally, with per-language notes and a port acceptance checklist |
| [11-implementation-playbook.md](references/11-implementation-playbook.md) | A to Z: greenfield / mid-build / retrofit, flow recipes, testing |
| [12-source-discrepancies.md](references/12-source-discrepancies.md) | What is not published, and where Digimart's sources disagree |
| [13-integration-reference.md](references/13-integration-reference.md) | **Every flow as a signed-URL recipe, every REST call as curl, every inbound surface with a replay command** |

Templates in [templates/](templates/README.md) are working implementations — config, URL signer,
REST client and inbound handlers — in **TypeScript/Node, Python, Java, Go, PHP and C#**, plus a
shared `.env.example`. Scripts in [scripts/](scripts/) are plain curl, so they exercise handlers
written in any language.

---

## When generating code

- **Write it in the host project's language and idiom.** Never introduce a runtime, a sidecar or a
  second service to reach Digimart.
- Put the signer and every REST call behind one service module. No URLs or credentials in
  controllers.
- Add a fixed-vector test for the signer from Digimart's worked example.
- Validate inbound payloads with whatever the stack uses — they come from outside your trust
  boundary.
- Log `requestId`, `internalTrxId` and `statusCode` on every operation. **Never** log the API
  Secret, the App Password, a full signed URL or an unmasked MSISDN; mask `subscriberId`.
- Mirror subscription state from the notifications and reconcile with Subscriber List; call
  Charging Info on demand, not per request.
- Match the host project's stack and conventions. The templates are a specification, not a
  framework to impose.
