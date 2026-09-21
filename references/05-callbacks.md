# What Digimart Sends Back

Every charging flow reports its outcome in two ways, and one of them is worth nothing on its own:

| | Redirect return | Notification |
|---|---|---|
| Arrives at | Your `redirectUrl` (a query parameter of the URL you built) | A URL configured on the application in the portal |
| How | The subscriber's **browser** — `GET` with query parameters | Digimart's **server** — `POST` with a JSON body |
| Reliable | No — a closed tab means it never arrives | Yes — this is the record |
| Forgeable | Yes — anyone can type `?subscriptionStatus=S1000` | Not by a subscriber; still verify it |
| Use it for | Choosing which screen to show | Granting access, delivering goods, counting revenue |

And there are two notification URLs on the application:

| Field on the application | Catalog id | Digimart posts | For |
|---|---|---|---|
| **Subscription Notification URL** | `subscription-notification` | Subscription lifecycle (`status`, `frequency`) | The subscription flow without header enrichment |
| **Async charging resp URL** | `charging-notification` | Charging results (`statusCode`, amounts, `internalTrxId`) | One-time charges, and subscriptions with header enrichment |

```bash
node tools/digimart.mjs list --direction=inbound
node tools/digimart.mjs show charging-notification
node tools/digimart.mjs curl subscription-notification    # fields + a replay command
```

## The rules — for both notifications

1. **Acknowledge first, work second.** Answer HTTP 200 immediately, queue the payload, process it
   out of band — through the stack's real background mechanism (a job queue, `BackgroundTasks`,
   `@Async`, a goroutine with a worker, a hosted service), not an inline `await`.
2. **No response body is published.** Digimart documents no acknowledgement payload, so do not
   depend on it reading anything you return. An empty 200 or a small JSON body are both fine.
3. **Always 200** — even for a payload you reject. Digimart publishes no redelivery policy, so do not
   rely on a 4xx or 5xx to get a second chance; log it and reconcile instead.
4. **Be idempotent.** Deduplicate on the documented key. A replayed notification must never grant
   access twice or count revenue twice.
5. **Never trust the body.** Digimart publishes no signature, token or IP list for notifications.
   Validate the schema, check `applicationId` equals yours, check the `requestId` is one *you*
   issued, and reconcile value-granting changes against the REST lookups.
6. **Public HTTPS, complete certificate chain, no auth in front.** Exempt the routes from CSRF,
   session auth and bot challenges.
7. **Log identifiers, not people.** `requestId`, `internalTrxId`, `statusCode`, and a masked
   `subscriberId` — never the raw body into an analytics tool.

---

## Charging Notification — *Async charging resp URL*

The fact that money moved. Sent after a one-time charge, and after a subscription with header
enrichment.

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

| Field | Meaning |
|---|---|
| `requestId` | The `requestId` from your URL. **Match the order on this.** |
| `statusCode` | `S1000` means the charge succeeded. Anything else is a failure — decode it with the SDK table. |
| `statusDetail` | Human-readable outcome. |
| `applicationId` | Must equal `DIGIMART_APP_ID`. |
| `subscriberId` | Masked subscriber, no `tel:` prefix. |
| `internalTrxId` | Digimart's transaction id. Store it; quote it to support. |
| `totalAmount` | Amount of the charge, decimal **string**. |
| `paidAmount` | Amount actually paid, decimal **string**. |
| `balanceDue` | Amount still due — a JSON **number** in the sample. `0` when fully paid. |
| `currency` | `BDT`. |
| `timeStamp` | When it was sent, `yyyyMMddHHmmss`. |
| `version` | `2.0`. |

**Digimart publishes this as a sample, not a schema.** Treat every field as possibly absent, parse
both string and number forms of the amounts, and log the raw body on your first sandbox
deliveries. Do not invent fields.

**Deduplicate on** `internalTrxId` + `statusCode` (fall back to `requestId` + `statusCode`).

**Settle the order when all of these hold:**

- `statusCode` is `S1000`
- `applicationId` is yours
- `requestId` is an order you created and have not already fulfilled
- `paidAmount` equals the amount on that order, and `balanceDue` is `0`

Then deliver, exactly once. A mismatch is not a success: flag it for review.

---

## Subscription Notification — *Subscription Notification URL*

Subscription lifecycle changes, starting with the registration from the subscription flow. The
REST specification documents it as `POST /subscription/notify` — *"Digimart calls this one, not
you"* — with this payload:

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

| Field | Required | Meaning |
|---|---|---|
| `timeStamp` | yes | When it was sent. |
| `subscriberId` | yes | Masked subscriber, no `tel:` prefix. |
| `applicationId` | yes | Must equal `DIGIMART_APP_ID`. |
| `version` | yes | `2.0`. |
| `frequency` | yes | `daily` or `monthly`. |
| `status` | yes | `REGISTERED`, `TEMPORARY_BLOCKED` or `REG_PENDING`. |
| `subscriberRequestId` | no | The `requestId` from your subscription URL. **Match the user on this.** |

**Deduplicate on** `subscriberId` + `status` + `timeStamp`.

**On arrival:** find your user by `subscriberRequestId`, record `subscriberId` against them (this
is the authoritative mapping), and set access from `status`:

| `status` | Access |
|---|---|
| `REGISTERED` | Grant |
| `REG_PENDING` | Hold |
| `TEMPORARY_BLOCKED` | Suspend — keep the record; it is a live subscriber in trouble |

One older tutorial sample carried the application id under a key equal to the `requestId`
(`"123456789012100": "APP_000186"`). The specification says `applicationId`; accept that, and log
rather than crash if it is missing.

**Missed some?** `POST /subscription-info-server/getSubscribers` exists precisely to retrieve
subscription notifications you did not receive. Run it on a schedule — see
[06-rest-apis.md](06-rest-apis.md).

---

## Redirect Return — your `redirectUrl`

Not a notification: the subscriber's browser, arriving at the URL you put in `redirectUrl`, with the
outcome appended.

```
GET https://your-app.example/digimart/return?subscriptionStatus=S1000&subscriberId=OGI2OGY1…&requestId=123456789012347
```

| Parameter | Meaning |
|---|---|
| `subscriptionStatus` | A status code — `S1000` or an SDK error code. (One quickstart sample shows a JSON object with `"CHARGED"`; the flow references and every sample URL use query parameters and codes.) |
| `subscriberId` | Masked number for the subscriber. |
| `requestId` | The `requestId` you allocated. |

**What the page does:**

1. Look up `requestId` in your store. If you never issued it, show a neutral page and stop.
2. Record `subscriberId` against it **provisionally**.
3. Show the screen for the code — never the raw code:

| `subscriptionStatus` | Screen |
|---|---|
| `S1000` | "Payment received — confirming." Poll *your own* order status until the notification settles it. |
| `E3009` | "Your balance is too low — recharge and try again", with a retry that builds a **new** URL. |
| `E2xxx`, `E4001` | "The code didn't go through — try again." |
| `E1014`, `E3003`, `E3007` | "Too many attempts — try again later." |
| `E3001` | "You're already subscribed." |
| `E3004`, `E3005`, `E3006` | "This number can't use this service." Do not auto-retry. |
| `E1xxx` | A generic apology. It is your bug: log it with the `requestId` and alert. |

4. **Grant nothing.** The notification does that.

If `redirectUrl` is a mobile deep link or a web view, intercept the navigation there and hand the
query string to your backend; the rules are the same.

```bash
node tools/digimart.mjs redirect 'https://your-app.example/digimart/return?subscriptionStatus=E3009&subscriberId=…&requestId=…'
```

---

## Testing the inbound half without Digimart

The payloads are published, so replay them yourself:

```bash
./scripts/test-callbacks.sh http://localhost:3000
```

It posts valid, failed, malformed, wrong-application and **duplicate** notifications, and a forged
redirect, at the suggested routes (`/api/digimart/charging/notify`,
`/api/digimart/subscription/notify`, `/digimart/return`). It is plain curl, so it tests a handler
in any language. Override the routes with environment variables if yours differ.

Every payload with its replay command: [13-integration-reference.md](13-integration-reference.md).
Working handlers: `templates/*/` — callbacks file in each language.
