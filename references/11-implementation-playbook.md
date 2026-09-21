# Implementation Playbook — A to Z

From nothing to production, in the host project's own stack. Three starting points share one
route: establish the ground truth, then build config → signer → start endpoint → inbound handlers →
REST → reconciliation → go-live.

```bash
node tools/digimart.mjs list          # the whole surface — 3 flows, 3 REST calls, 3 inbound
node tools/digimart.mjs platform      # hosts, credentials, the endpoints you build
node tools/digimart.mjs gaps          # what Digimart does NOT publish
```

## 0. Establish the ground truth (every starting point)

Ask, or find in the code and the portal:

| Question | Why it matters |
|---|---|
| Is there an approved application, with an API Key and API Secret? | Without approval the key does not work for live charging. Build against sandbox meanwhile. |
| Is the **CaaS API** enabled on it, and the **Subscription Charging SDK**? | `E1008` / `E1011` otherwise — configuration, not code. |
| Subscription, one-time, or both? | Decides which authorize URL(s) and which notification handler(s). |
| Is **header enrichment** enabled? | Changes the subscription variant and its notification field. |
| Are the **notification URLs** set, public and HTTPS? | Without them you never learn that a payment happened. |
| Is the **App Password** (emailed at app creation) in hand? | Needed for every REST call, including unsubscription. |
| What do clients look like — server-rendered web, SPA, mobile app? | Decides whether the start endpoint answers 302 or JSON. |

Then read the reference for what you are building: [03-subscription-sdk.md](03-subscription-sdk.md),
[04-one-time-sdk.md](04-one-time-sdk.md).

## 1. Entry point A — greenfield

1. **Config first.** Copy `templates/.env.example`; create the config module (component 1 in
   [10-any-stack.md](10-any-stack.md)). No credential ever touches a source file.
2. **Signer, with a fixed-vector test.** Implement `buildAuthorizeUrl`. Before anything else,
   assert your SHA-512 of `myApiKey123|2024-08-08T12:00:00Z|mySecretKey456|50` equals
   `3badf638…901b38` ([02-signatures.md](02-signatures.md)).
3. **Order store.** A table keyed by `requestId`: user, item, amount, state.
4. **Start endpoint.** Price from the server, fresh `requestId`, order row written, URL signed,
   302 or JSON.
5. **Redirect page.** Reads the query, looks up the order, shows a screen per code, grants nothing.
6. **Notification handlers.** Charging and subscription — acknowledge first, verify, dedupe,
   settle.
7. **REST client.** `post()` + the three wrappers; a cancel endpoint for subscribers.
8. **Reconciliation job.** Pages Subscriber List nightly.
9. **Check it.** `node tools/digimart.mjs check-url '<a URL your code built>'`;
   `./scripts/test-callbacks.sh http://localhost:3000`; an end-to-end run in sandbox.
10. **Go-live checklist.** [09-production-checklist.md](09-production-checklist.md).

## 2. Entry point B — mid-build

Something exists and does not work. Audit in this order, because each step is cheap and the
early ones catch most bugs:

1. Does the signer reproduce the worked-example digest? If not, stop — the hashing is wrong.
2. Run `check-url` on a URL the code actually built, with the secret exported. It names the
   common signing mistakes.
3. Is the signature built on the server? Search the client code for the secret variable name.
4. Where does fulfilment happen? If anywhere near the redirect route, move it to the
   notification.
5. Are the notification handlers acknowledging first, deduplicating and verifying `applicationId`?
6. Is there a cancel path that calls `/subs/unregistration`?
7. Then [the review skill's checklist](../skills/digimart-review/SKILL.md).

## 3. Entry point C — retrofit into a live application

Adding Digimart to an app that already has users and maybe another payment method:

1. **Model Digimart as one more payment provider** behind your existing checkout abstraction —
   an order with a provider, a provider reference (`requestId`) and a provider transaction id
   (`internalTrxId`).
2. **Map identities once.** Your user id ↔ `requestId` (at checkout) ↔ `subscriberId` (from the
   notification). Existing users who subscribe through Digimart get a `subscriberId` column, not a
   new account.
3. **Entitlements.** If the app already grants access from a subscription table, have the
   Digimart subscription notification write to the same table, with `provider = digimart`.
4. **Feature-flag the start endpoint** so it can be turned off without a deploy.
5. **Backfill nothing.** Digimart subscribers only exist after they go through the SDK.
6. **Reconcile from day one** — the nightly Subscriber List job is how you find drift before a
   customer does.

## 4. Flow recipes

### A. One-time purchase (web)

```
user clicks Buy(itemId)
  → POST /digimart/checkout {itemId}
      price = priceList[itemId]; requestId = new; order PENDING
      302 → https://user.digimart.store/sdk/subscription/caas-authorize?…&amount=price
  → Digimart: number → OTP → charge
  → browser → GET /digimart/return?subscriptionStatus=S1000&subscriberId=…&requestId=…
      page: "Payment received — confirming…" (polls GET /orders/{requestId})
  → Digimart → POST /api/digimart/charging/notify {statusCode:S1000, requestId, paidAmount…}
      200; queue → verify → order PAID → fulfil once → FULFILLED
  → polling page sees FULFILLED → "Done"
```

### B. One-time purchase (mobile app)

Same, except the app calls `POST /digimart/checkout` and gets `{ "url": … }` back, opens it in a
browser tab or web view, and watches for navigation to the redirect URL (or a deep link you set as
`redirectUrl`). When it lands, the app asks your API for the order status. The app never builds or
signs anything.

### C. Subscription

```
user clicks Subscribe(planId)
  → POST /digimart/subscribe {planId}
      requestId = new; pending subscription row for this user
      302 → https://user.digimart.store/sdk/subscription/authorize?…
  → Digimart: number (or HE confirmation) → OTP → first charge → confirmed
  → browser → /digimart/return?subscriptionStatus=S1000&subscriberId=…&requestId=…
      record subscriberId provisionally; "Subscription starting — confirming…"
  → Digimart → POST /api/digimart/subscription/notify {status:REGISTERED, subscriberRequestId, subscriberId, frequency}
      (with header enrichment: the charging notification on the Async charging resp URL instead)
      200; queue → find user by subscriberRequestId → store subscriberId → grant access
```

Before sending a user into the flow again, check them with Subscriber Charging Info — a second
opt-in fails with `E3001` *User Already Registered*.

### D. Cancel

```
user clicks Cancel
  → POST /digimart/unsubscribe (their session)
      subscriberId = subscribers[user].subscriberId
      POST https://api.digimart.store/subs/unregistration {subscriberId:"tel:"+id, action:"0"}
      on UNREGISTERED: end access now
```

### E. Nightly reconciliation

```
page = 1
loop:
  r = getSubscribers(page)                     # S1000 or S1001
  for s in normalise(r.subscribers):
      match by subscriberRequestId / subscriberId → correct local status
  if not r.moreDataAvailable or r.nextPageNumber == -1: break
  page = r.nextPageNumber
report drift
```

## 5. Error handling that survives production

- Map codes to screens, never to raw text ([07-status-codes.md](07-status-codes.md)).
- `E3009` gets the most design effort — it is the most common failure.
- Configuration codes (`E1006`, `E1007`, `E1008`, `E1010`, `E1011`) page a human.
- A "retry" is always a new order with a new `requestId`.
- A REST failure keeps enough state to try again (a pending cancel, a page number).

## 6. Testing — before and after approval

| Stage | How |
|---|---|
| No account yet | Fixed-vector signing test; `url` + `check-url` with a dummy secret; `test-callbacks.sh` against your handlers. The whole inbound half is testable offline. |
| Sandbox | Allowed test numbers only (`E3005` otherwise). Run a subscription and a one-time charge end to end, including a closed tab (notification only) and insufficient balance. |
| Production server | `scripts/smoke-test.sh` for the REST credentials; one real low-value purchase. |

## 7. Go live

[09-production-checklist.md](09-production-checklist.md) — then submit, and chase the review at
support@digimart.store.

## Quick command map

| I need to… | Run |
|---|---|
| See everything | `node tools/digimart.mjs list` |
| Check my hashing | `node tools/digimart.mjs sign --example one-time` |
| Build a URL | `node tools/digimart.mjs url one-time amount=50 redirectUrl=…` |
| Check a URL my code built | `node tools/digimart.mjs check-url '<url>'` |
| Read a redirect | `node tools/digimart.mjs redirect '<url>'` |
| Build a REST call | `node tools/digimart.mjs curl unregistration subscriberId=tel:…` |
| Check a notification | `node tools/digimart.mjs validate charging-notification @body.json` |
| Decode a code | `node tools/digimart.mjs code E3009` |
| Get unstuck | `node tools/digimart.mjs diagnose "<symptom>"` |
