# One-Time Charging SDK (CaaS)

A single payment of a specific amount from a subscriber's Grameenphone mobile account. Digimart also
calls it **CaaS** (Charging as a Service) or **on-demand charging**. Use it to unlock a feature,
sell a ticket, or top up in-app credits.

Source: <https://digimart.store/docs/one-time-sdk>.

> **This is not a REST API.** You build a signed URL on your server and send the subscriber's
> browser to it. Digimart owns every screen until it returns the subscriber to your `redirectUrl`,
> then posts you the result server-to-server.

## How it differs from a subscription

Two things change, and nothing else:

1. The path is **`/sdk/subscription/caas-authorize`** rather than `/sdk/subscription/authorize`.
2. There is an **`amount`**, and it is **part of the signing string**.

> **The amount is signed.** The signing string is `apiKey|requestTime|apiSecret|amount`. Sign only
> the first three and every request comes back `E1002` (Invalid Signature). This is the single most
> common reason a working subscription integration fails when it is copied across to one-time
> charging.

## What you can charge

A single transaction must be between **1 and 600 BDT** (<https://digimart.store/pricing>).

| Outside the band | Code |
|---|---|
| Below 1 BDT | `E1330` — Charging amount too low |
| Above 600 BDT | `E1329` — Charging amount too high |

In practice your real ceiling is whatever credit subscribers keep on their phones, so **`E3009`
(insufficient balance) is the failure you will see most**. A 50 BDT charge that succeeds is worth
more than a 500 BDT charge that is declined; if you price near the top of the band, offer a smaller
tier alongside it.

## The endpoint

```
https://user.digimart.store/sdk/subscription/caas-authorize
```

## Parameters

| Parameter | Required | Signed | Notes |
|---|---|---|---|
| `apiKey` | yes | yes | From the approved application. |
| `requestId` | yes | — | **15 digits**, unique per URL. Your order's key: the notification is matched on it. |
| `requestTime` | yes | yes | Current instant, ISO 8601 UTC with a Z. |
| `signature` | yes | — | SHA-512 of `apiKey\|requestTime\|apiSecret\|amount`, lowercase hex. |
| `redirectUrl` | yes | — | Where the subscriber lands after pressing *Back to Application*. |
| `msisdn` | no | — | Skips the number-entry screen. |
| `amount` | yes | **yes** | The amount in BDT. Sent in the query string **and** signed — the identical string in both places. |

Full definitions: `node tools/digimart.mjs show one-time`.

## The amount, precisely

- **Decide it on the server**, from your own price list, keyed by what the user is buying. Never
  take it from the client: it is signed, so Digimart will honour whatever you sign.
- **One string, used twice.** `50` and `50.00` hash differently. Format it once and use that string
  in the hash and in the query string.
- **Whole taka in the published examples.** Every published example amount is a whole number
  (`10`, `50`), while the notification reports amounts as decimal strings (`50.95`). Digimart does
  not document whether fractional amounts are accepted in the URL; if you need them, confirm with
  support first.
- Keep money in a decimal type in your own code, never a binary float.

## Building the URL

1. Look up the price on the server.
2. Generate a fresh 15-digit `requestId`; **persist an order row** with the `requestId`, the item,
   the amount and state `PENDING` — *before* redirecting.
3. Take the current UTC instant once.
4. Sign `apiKey|requestTime|apiSecret|amount` with SHA-512, lowercase hex.
5. Assemble the query string — including `amount` — and redirect the browser.

```bash
node tools/digimart.mjs url one-time amount=50 redirectUrl=https://your-app.example/digimart/return
node tools/digimart.mjs check-url '<the URL your code built>'
```

## What the subscriber sees

1. Number entry, with the **exact amount** shown before paying (skipped with `msisdn`).
2. OTP entry — Grameenphone generates and sends the OTP; the charge is restated.
3. Payment success; an SMS goes to the subscriber's masked number.
4. The error page if anything fails.

## After the charge

As with subscriptions, the redirect is a convenience and the notification is the record.

**The redirect** lands on your `redirectUrl` with `subscriptionStatus` (yes, the same name on a
one-time charge), `subscriberId` and `requestId`. Show the right screen; grant nothing.

**The charging notification** is posted to the **Async charging resp URL** on your application:

```json
{
  "balanceDue": 0,
  "subscriberId": "ZjUyMTM1MjlhYmU0ZmJmY2FkYjRkYWI3NzE2ZDg0MjE0NjNjYTM5MGFhZTczOWZlZDUxMTcxN2U3YTVlZTRiNmU=",
  "statusDetail": "Request was Successfully processed, Due amount fully paid.",
  "version": "2.0",
  "timeStamp": "20240703090835",
  "totalAmount": "50.95",
  "requestId": "123456789012346",
  "currency": "BDT",
  "applicationId": "APP_000040",
  "internalTrxId": "924070309080000043",
  "paidAmount": "50.95",
  "statusCode": "S1000"
}
```

Wait for `statusCode: "S1000"` on the notification before you hand over whatever the subscriber
paid for, and reconcile it by `requestId`. Compare `paidAmount` against what you asked for rather
than assuming they match, and check `balanceDue` is `0`.

## The order state machine

```
PENDING      ← order row written with requestId + amount, before redirect
  │  browser → Digimart → OTP → browser back to redirectUrl
  │    (redirect S1000: show "confirming…";  redirect E…: show the right message, order → FAILED
  │     only if no notification follows — the redirect is not authoritative)
  ▼
PAID         ← charging notification: statusCode S1000, requestId matches,
               applicationId matches, paidAmount == amount, balanceDue == 0
  │
FULFILLED    ← goods delivered, exactly once (dedupe on internalTrxId + statusCode)

FAILED       ← charging notification with any other statusCode
```

A retry after `FAILED` is a **new** order with a **new** `requestId` — never the old one (`E1005`).

## Common failures on this flow

| Code | Meaning | Do |
|---|---|---|
| `E1002` | Invalid Signature | Almost always: amount not signed, or signed as a different string than sent |
| `E1329` / `E1330` | Amount too high / too low | 1–600 BDT |
| `E1008` | Service not allowed for the application | Enable the CaaS API on the app and resubmit |
| `E3009` | Balance too low | Your most common failure — a kind recharge screen, maybe a cheaper tier |
| `E3004` | Service not allowed for the operator | Not a Grameenphone number |
| `E2002` / `E3003` / `E3007` | Resend / OTP request / OTP attempt limits | Tell them to wait; do not loop |

All 31: [07-status-codes.md](07-status-codes.md).
