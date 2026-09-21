# Subscription Charging SDK

Recurring billing against a Grameenphone mobile account. You send the subscriber into the flow
once; they consent with an OTP; Digimart maintains the billing relationship from then on, charging
`daily` or `monthly`.

Source: <https://digimart.store/docs/subscription-sdk>.

> **This is not a REST API.** There is nothing to POST. You build a signed URL inside your own
> application and open it in a browser or web view. Digimart owns every screen from that point until
> it returns the subscriber to your `redirectUrl`. The only server-to-server traffic is the
> notification Digimart sends you afterwards.

## Before you start

- An **approved** application, with its **API Key** and **API Secret** — both shown on the
  application in the portal once an administrator approves it.
- The **Subscription Charging SDK enabled** on the application (otherwise `E1011`).
- A **notification URL** configured on the application — see [Which notification](#which-notification).
- A server clock synced with NTP. `requestTime` is validated at Digimart's end.
- Somewhere to persist `requestId` → your user, and later `subscriberId` → your user.

## Two variants of the same flow

Both use **the same endpoint, the same parameters and the same signature**. The difference is
whether the subscriber types their own number:

| | Without header enrichment (default) | With header enrichment |
|---|---|---|
| Catalog id | `subscription` | `subscription-he` |
| Enabled by | — | A Digimart administrator enabling *Allow Capturing Mobile Number via Header Enrichment* on the application |
| First screen | Number entry, with the recurring price | Price confirmation, number already known; subscriber presses *Get OTP* |
| Needs | Any Grameenphone number | The subscriber browsing on Grameenphone mobile data |
| Extra parameter | — | `amount`, listed as required, **not** signed |
| Notification field | **Subscription Notification URL** | **Async charging resp URL** |

In either variant, passing `msisdn` in the URL skips the first screen and goes straight to the OTP.
Header enrichment removes the biggest drop-off point — the subscriber never types their number.

## The endpoint

```
https://user.digimart.store/sdk/subscription/authorize
```

Opened in the subscriber's browser — with an HTTP 302 from your server, a link, or a web view
navigating to it. **Never** fetched by your server.

## Parameters

| Parameter | Required | Signed | Notes |
|---|---|---|---|
| `apiKey` | yes | yes | From the approved application. |
| `requestId` | yes | — | **15 digits**, unique per URL, your choice. Correlates the redirect and the notification. A used value is rejected with `E1005`. |
| `requestTime` | yes | yes | Current instant, ISO 8601 UTC with a Z: `2024-07-08T10:33:54.929Z`. |
| `signature` | yes | — | SHA-512 of `apiKey\|requestTime\|apiSecret`, lowercase hex. |
| `redirectUrl` | yes | — | Where the subscriber lands after pressing *Back to Application*, on success or failure. |
| `msisdn` | no | — | Skips the number-entry screen. Documented sample: `01748277168`. Redundant with header enrichment. |
| `amount` | HE only | **no** | Listed as required on the header-enrichment page only, and not part of the signature. The documentation does not explain its role for a subscription — confirm with support before relying on it. |

Full definitions: `node tools/digimart.mjs show subscription` (or `subscription-he`).

## Building the URL

1. **Collect your credentials.** API Key and API Secret from the approved application. The secret
   is never put in the URL.
2. **Generate a unique 15-digit `requestId`** and persist it against the user who is subscribing.
3. **Take the current time in UTC**, once, into a variable.
4. **Build and hash the signing string** — `apiKey|requestTime|apiSecret`, pipes, no spaces,
   SHA-512, lowercase hex. See [02-signatures.md](02-signatures.md).
5. **Assemble the query string and open it.** Use your language's query-string encoder.

```bash
node tools/digimart.mjs url subscription redirectUrl=https://your-app.example/digimart/return
```

prints a real signed URL (if `DIGIMART_API_SECRET` is exported) and the same thing as a shell
recipe. Every language's version is in [13-integration-reference.md](13-integration-reference.md)
and `templates/`.

**Where the URL is built:** on your server, in an endpoint your clients call — see
[10-any-stack.md](10-any-stack.md#3-the-start-endpoint). A mobile app asks your backend for the
URL and opens what it gets back in a web view; it never holds the secret.

## What the subscriber sees

Digimart renders all of these:

| Step | Without HE | With HE |
|---|---|---|
| 1 | Number entry, recurring price shown (skipped with `msisdn`) | Price confirmation, number pre-filled, *Get OTP* |
| 2 | OTP sent to the Grameenphone number; subscriber enters it and acknowledges the recurring charge | OTP entry |
| 3 | Subscription confirmed | Payment success; an SMS goes to the masked number |
| — | Error page if anything fails | Error page if anything fails |

## After the charge

You are told the outcome **twice**, and the two are not equivalent.

### 1. The redirect — convenience

The subscriber's browser lands on your `redirectUrl` with three query parameters:

| Parameter | Meaning |
|---|---|
| `subscriptionStatus` | A status code: `S1000` on success, or an SDK error code. **Not** a word like `REGISTERED`. |
| `subscriberId` | The subscriber's **masked** number. |
| `requestId` | The ID you allocated. |

```
https://your-app.example/digimart/return?subscriptionStatus=S1000&subscriberId=OGI2OGY1…&requestId=123456789012347
```

It travels through the subscriber's browser. If they close the tab it never arrives, and anyone can
type it. Use it to decide which screen to show — never to grant access.

### 2. The notification — authoritative

Digimart POSTs JSON to the notification URL on your application. Deliver on this.

Without header enrichment, on the **Subscription Notification URL**:

```json
{
  "timeStamp": "20240801044105",
  "subscriberId": "ZmQ5YmRmMDA5NzdlZTzM5NjJjNjRkNWNiMjkzOWYxMzk4MzI3ZjYyM2UwMmJmYzY3YzpncmFtZWVucGhvbmU=",
  "applicationId": "APP_000186",
  "subscriberRequestId": "123456789012100",
  "version": "2.0",
  "frequency": "daily",
  "status": "REGISTERED"
}
```

With header enrichment, on the **Async charging resp URL** — the charging result shape, with
`statusCode`, `requestId`, `totalAmount`, `paidAmount`, `balanceDue`, `internalTrxId`. Both are
defined field by field in [05-callbacks.md](05-callbacks.md).

### Which notification

Digimart's documentation names a different notification field for each variant. An application
whose header-enrichment setting could change — or that also sells one-time charges — should
implement **both** handlers. They are cheap, and a missing one means a paying subscriber you never
hear about.

## Store the `subscriberId` mapping

`subscriberId` is a masked number, not the real MSISDN. Every later REST call and every
notification identifies the subscriber by that masked value, so without a mapping you cannot tell
who a notification is about or unsubscribe anyone.

- Record `subscriberId` against the `requestId` when the redirect arrives — **provisionally**,
  since the redirect is forgeable.
- **Confirm** it from the notification, which carries both `subscriberId` and your
  `subscriberRequestId` / `requestId`.
- Store it exactly as given. When you call the REST APIs, send it as `tel:<subscriberId>`.

## Subscription states

| Status | Where you see it | What it means for access |
|---|---|---|
| `REGISTERED` | Notification, Subscriber List, Charging Info | Active. Grant access. |
| `REG_PENDING` | Notification, Subscriber List, Charging Info | Registration not complete. Hold access. |
| `TEMPORARY_BLOCKED` | Notification, Subscriber List, Charging Info | A live subscriber in trouble (often a failed renewal). Suspend access; do not delete. |
| `INITIAL` | Subscriber List, Charging Info (descriptions) | Not yet active. No access. |
| `UNREGISTERED` | Unsubscription response | Ended. Remove access. |

The notification's `status` is limited to the first three by the specification.

## Managing subscribers afterwards

Everything after the opt-in is REST, on a different host with a different credential
([06-rest-apis.md](06-rest-apis.md)):

| Need | Call |
|---|---|
| Cancel a subscription (your "unsubscribe" button) | `POST /subs/unregistration` |
| Is this person still subscribed, and when did they last pay? | `POST /subscription/getSubscriberChargingInfo` |
| Catch up on notifications you missed; reconcile | `POST /subscription-info-server/getSubscribers` |

**A working, obvious cancel path is on Digimart's go-live checklist.** There is no SDK flow for
unsubscribing; it is always the REST call from your server.

## Common failures on this flow

| Code | Meaning | Do |
|---|---|---|
| `E1002` | Invalid Signature | [02-signatures.md](02-signatures.md) — order, time, hex, SHA-512 |
| `E1005` | requestId already used | Fresh 15-digit id per URL |
| `E1003` / `E1004` | Invalid time format / request timeout | UTC with Z; NTP; build at redirect time |
| `E1011` | SDK not enabled for this application | Portal / support — not code |
| `E3001` | User Already Registered | Treat as "already subscribed"; check Charging Info first |
| `E3005` | Number not whitelisted | Sandbox: use an allowed test number |
| `E3009` | Balance too low | Friendly recharge screen with a retry |
| `E4001` | Invalid OTP | Digimart lets them re-enter in the same flow |

All 31: [07-status-codes.md](07-status-codes.md).
