---
name: digimart-callbacks
description: Implement what Digimart sends back — the browser redirect to your redirectUrl (subscriptionStatus, subscriberId, requestId), the charging notification on the Async charging resp URL, and the subscription notification on the Subscription Notification URL. Use when building or debugging Digimart notification handlers, webhooks, the redirect or return page, or fulfilment.
---

# Digimart callbacks

Every charging flow reports its outcome twice, and only one of them counts:

| | Redirect return | Notifications |
|---|---|---|
| Arrives | Browser `GET` on your `redirectUrl`, query parameters | Digimart's server `POST`s JSON to a URL on the application |
| Trust | None — forgeable, and may never arrive | The record — still verify it |
| Use for | Which screen to show | Granting access, delivering goods |

```bash
node tools/digimart.mjs list --direction=inbound
node tools/digimart.mjs show charging-notification
node tools/digimart.mjs curl subscription-notification     # fields + replay command
node tools/digimart.mjs validate charging-notification '<json>'
node tools/digimart.mjs redirect '<the URL the browser landed on>'
```

| Inbound | Configured in | Sent after | Dedupe on |
|---|---|---|---|
| Charging Notification | *Async charging resp URL* | one-time charges; subscriptions with header enrichment | `internalTrxId` + `statusCode` |
| Subscription Notification | *Subscription Notification URL* (spec: `/subscription/notify`) | the subscription flow | `subscriberId` + `status` + `timeStamp` |
| Redirect Return | the `redirectUrl` in each URL you build | every flow | `requestId` |

Implement both notification receivers if the app could receive both.

## Rules for the notifications

1. **200 first, work second** — through the stack's real background mechanism.
2. **No response body is published.** Do not depend on Digimart reading one.
3. **Always 200**, even when rejecting. No redelivery policy is published; reconcile instead.
4. **Idempotent** on the dedupe key above.
5. **Unauthenticated** — no signature, token or IP list is published. Check `applicationId`,
   check the `requestId` is one you issued, reconcile with the REST lookups.
6. **Public HTTPS**, complete chain, exempt from CSRF and session auth.

## The charging notification settles money

Settle an order only when `statusCode` is `S1000`, `applicationId` is yours, `requestId` is an
unfulfilled order of yours, `paidAmount` equals the order amount and `balanceDue` is `0`. Parse
amounts as decimals — the sample has `totalAmount` and `paidAmount` as strings and `balanceDue` as
a number. It is published as a **sample, not a schema**: tolerate missing fields; invent none.

## The subscription notification maps the subscriber

Find the user by `subscriberRequestId` (your original `requestId`), store `subscriberId` — the
masked id every REST call needs — and set access from `status`: `REGISTERED` grant, `REG_PENDING`
hold, `TEMPORARY_BLOCKED` suspend. Missed some? Page
`POST /subscription-info-server/getSubscribers`.

## The redirect picks a screen

`subscriptionStatus` is a **code** (`S1000`, `E3009`…), not `REGISTERED` or `CHARGED`. Look the
`requestId` up; record `subscriberId` provisionally; on `S1000` show "confirming" and poll your own
order; on `E3009` a recharge screen; on `E1xxx` a generic apology and an alert. **Grant nothing.**

## Test without Digimart

```bash
./scripts/test-callbacks.sh http://localhost:3000
```

Valid, failed, malformed, wrong-application, **duplicate** and **forged-redirect** cases, in plain
curl, against any language. Working handlers: the callbacks file in each `templates/` language.
Full contract: `references/05-callbacks.md`.
