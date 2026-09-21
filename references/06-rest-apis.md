# REST APIs

Everything on this page **is** a REST API, which makes it the exception on Digimart rather than
the rule. Charging goes through signed URLs; these are ordinary JSON over HTTPS, called from your
server once a subscriber already exists.

Source: <https://digimart.store/docs/rest-api>, transcribed from the OpenAPI 3.0 specification
Digimart published at `digimart.store/API_Documentation/docs/digimart_API.html`.

## Conventions

| | |
|---|---|
| Host | `https://api.digimart.store` — **not** `user.digimart.store` |
| Method | `POST`, including the read-only calls |
| Content type | `application/json;charset=utf-8`, both directions |
| Auth | `applicationId` + `password` (the **App Password**, emailed when the app was created) in the JSON body. No headers, no tokens, **no signature** — that belongs to the SDK. |
| Addressing | Subscribers as `tel:<msisdn>`. When the application uses masked numbers, send the masked value — the `subscriberId` the SDK and notifications gave you — as `tel:<value>`. |
| Outcome | `statusCode` in the body. Branch on it, not on the HTTP status. |
| Samples | The specification's code samples for Java, PHP, JavaScript and .NET all read "coming soon". Every call is a plain HTTPS POST; none is needed. |

## What they are for

| Call | Id | Use it to |
|---|---|---|
| `POST /subscription-info-server/getSubscribers` | `get-subscribers` | Page through everyone registered against the application; catch up on missed notifications |
| `POST /subscription/getSubscriberChargingInfo` | `subscriber-charging-info` | Ask whether specific people are subscribed, and when they last paid |
| `POST /subs/unregistration` | `unregistration` | End a subscription — the call behind your cancel button |
| `POST /subscription/notify` | `subscription-notification` | **Digimart calls this on you.** See [05-callbacks.md](05-callbacks.md). |

There is **no REST call that charges anyone**, and **none that subscribes anyone**. Both happen only
through the SDK, with the subscriber's OTP.

```bash
node tools/digimart.mjs curl get-subscribers requestPage=1
node tools/digimart.mjs curl subscriber-charging-info subscriberId='["tel:NTM3MDgz…"]'
node tools/digimart.mjs curl unregistration subscriberId=tel:NTM3MDgz…
```

---

## Subscriber List

`POST https://api.digimart.store/subscription-info-server/getSubscribers`

Returns the subscribers registered against your application, one page at a time. Digimart describes
it as the way to *retrieve subscription notifications which have been lost*.

```json
{
  "applicationId": "APP_102672",
  "password": "…",
  "version": "2.0",
  "status": "REGISTERED",
  "subscriberRequestId": "124002601656523239",
  "requestPage": 2
}
```

| Field | Required | Notes |
|---|---|---|
| `applicationId` | yes | |
| `password` | yes | App Password |
| `requestPage` | yes | **Integer** — the only number in any Digimart request body |
| `version` | no | `"2.0"` |
| `status` | no | Filter: `REGISTERED`, `TEMPORARY_BLOCKED` or `REG_PENDING` |
| `subscriberRequestId` | no | Filter to the subscriber from one SDK `requestId` |

Response:

```json
{
  "version": "2.0",
  "statusCode": "S1000",
  "statusDetail": "Request was successfully processed",
  "nextPageNumber": 3,
  "moreDataAvailable": true,
  "requestId": "223902031657423338",
  "subscribers": [
    {
      "subscriberId": "tel: NTM3MDgzMWI2ZDAwMzlmZTQ0N2Y1ZGFhMzQwOTM2MDA0YmEzZWRiYTFjYzIzNzhhZDZhYjZjNmI1MzliZWIxYTpiYW5nbGFsaW5r",
      "subscriberRequestId": "124002601656523239",
      "subscriptionStatus": "REGISTERED",
      "lastChargedDate": "2020-01-23 22.03.22",
      "lastChargedAmount": "30.00 BDT"
    }
  ]
}
```

**Paging:** request `requestPage` 1, then keep requesting `nextPageNumber` while
`moreDataAvailable` is `true`. `nextPageNumber` is `-1` when there is nothing more.

**Shape quirks, all from the published sources:**

- `subscribers` is typed as a single object in the specification and shown as an array in the
  example. Normalise to an array before iterating.
- `subscriberId` in the example carries a space after `tel:`. Strip `tel:` and whitespace before
  matching it against the bare value you stored.
- `lastChargedDate` is documented as `YYYY-MM-DD hh:mm:ss` and exampled as `2020-01-23 22.03.22`.
  Accept both separators; keep the raw string.
- `lastChargedAmount` is a string with the currency: `"30.00 BDT"`.

**Status codes.** The specification constrains `statusCode` to `S1000`, `S1001`, `E1100`, `E1102`,
`E1103`, `E1104`, `E1105`, `E1106` and `E1107` — and describes **none** of them except by the
`S1000` example. They are not the SDK error codes. Treat `S1000` as success; treat `S1001` as a
success-family code with no published meaning (do not raise an error; process what the page
carries and log `statusDetail`); treat every `E11xx` as a failure whose only explanation is
`statusDetail`, and quote `requestId` to support. Do not borrow meanings for them from another
platform.

**Run it on a schedule** — nightly is typical — to reconcile your subscription state: match on
`subscriberRequestId` (your original `requestId`) and `subscriberId`, and correct anything the
notifications missed.

---

## Subscriber Charging Info

`POST https://api.digimart.store/subscription/getSubscriberChargingInfo`

Current subscription state and last charge for a list of subscribers — *is this person still
subscribed, and when did they last pay?*

```json
{
  "applicationId": "APP_102672",
  "password": "…",
  "subscriberId": [
    "tel:NTM3MDgzMWI2ZDAwMzlmZTQ0N2Y1ZGFhMzQwOTM2MDA0YmEzZWRiYTFjYzIzNzhhZDZhYjZjNmI1MzliZWIxYTpiYW5nbGFsaW5r"
  ]
}
```

`subscriberId` is an **array** of `tel:`-prefixed strings, even for one subscriber. (The
specification types it as a string and examples it as an array; send the array.)

Response:

```json
{
  "version": "2.0",
  "statusCode": "S1000",
  "statusDetail": "Success.",
  "requestId": "101901031657410007",
  "destinationResponses": [
    {
      "subscriberId": "tel: 8801740812854",
      "subscriptionStatus": "REGISTERED",
      "subscriberRequestId": "124002601656523239",
      "lastChargedDate": "2020-01-23 22.03.22",
      "lastChargedAmount": "30.00 BDT",
      "numberType": "postpaid",
      "statusCode": "S1000",
      "statusDetail": "Request was successfully processed"
    }
  ]
}
```

A top-level `S1000` means the request was processed — **read `statusCode` on every
`destinationResponses` entry**, because one subscriber can fail while the envelope succeeds.
`numberType` is `prepaid` or `postpaid`.

Use it **on demand** — before starting a new opt-in (which would otherwise fail with `E3001` *User
Already Registered*), or when a user disputes their access. Do not call it on every page load;
mirror state from the notifications.

---

## User Unsubscription

`POST https://api.digimart.store/subs/unregistration`

Ends a subscriber's subscription. **This is the API behind any cancel control you build, and a
working cancellation path is a condition of the developer agreement.**

```json
{
  "applicationId": "APP_999999",
  "password": "…",
  "subscriberId": "tel:NTM3MDgzMWI2ZDAwMzlmZTQ0N2Y1ZGFhMzQwOTM2MDA0YmEzZWRiYTFjYzIzNzhhZDZhYjZjNmI1MzliZWIxYTpiYW5nbGFsaW5r",
  "action": "0"
}
```

| Field | Notes |
|---|---|
| `subscriberId` | **One** subscriber, a single `tel:`-prefixed string (not an array). May be masked depending on the application type. |
| `action` | `"0"` — user unsubscription, the only published value. Send the string `"0"` as the example does. |

Response:

```json
{
  "version": "2.0",
  "statusCode": "S1000",
  "statusDetail": "not registered",
  "requestId": "101901031657410007",
  "subscriptionStatus": "UNREGISTERED"
}
```

Read `subscriptionStatus` as well as `statusCode`: the published example pairs `S1000` with the
detail `not registered` and the status `UNREGISTERED` (the schema's example writes
`UNREGISTERED.` with a period — trim punctuation before comparing). On `UNREGISTERED`, end the
user's access in your own store immediately. **No notification is documented for unsubscription**,
so do not wait for one.

The specification enumerates no status codes for this endpoint beyond `S1000`. On anything else,
keep the user's cancel request (so it can be retried), log `statusDetail` and `requestId`, and
escalate.

### The cancel endpoint you build

```
POST /digimart/unsubscribe            (your route, your user's session)
  → authenticate YOUR user
  → look up their stored subscriberId (bare masked value)
  → POST /subs/unregistration { subscriberId: "tel:" + subscriberId, action: "0" }
  → on UNREGISTERED: end access, record when and by whom
```

Never accept a `subscriberId` from the client — a user could cancel someone else.

---

## Addressing: one helper

The SDK redirect and both notifications give you `subscriberId` as a bare masked value. The REST
calls want `tel:<value>`. Add the prefix in one function at the boundary:

```
toTel(id)   = id starts with "tel:" ? "tel:" + trim(id after "tel:") : "tel:" + trim(id)
fromTel(id) = trim(id after "tel:")        # for matching REST responses to stored values
```

No space after the colon, even though some published examples show one.

## Timeouts and retries

- Explicit client timeout on every call (the templates use 15 seconds).
- Retry transport errors on the read-only calls with capped exponential backoff.
- Retry `unregistration` only if you have kept the cancel request; it is safe to repeat, since the
  end state is the same.
- Never disable TLS verification. See [08-security-best-practices.md](08-security-best-practices.md).
