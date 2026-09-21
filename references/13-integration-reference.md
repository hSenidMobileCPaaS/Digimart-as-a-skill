<!-- Generated from catalog/digimart-api.json by scripts/build-integration-reference.mjs. Do not edit directly. -->

# Every Flow, Call and Callback at the Wire

The whole Digimart contract with nothing between you and the platform: each signed-URL flow as a
recipe you can run in a shell, each REST call as a runnable curl, each thing Digimart sends back
with a command that replays it against your own handler — and every parameter and field defined.

**Write the integration from this page, in whatever language the project already uses.** Signing
is one SHA-512 over a pipe-joined string, the URL is an ordinary query string, and the REST calls
are ordinary JSON POSTs, so every language has everything it needs in its standard library —
`hashlib` and `urllib` in Python, `MessageDigest` and `HttpClient` in Java, `crypto/sha512` and
`net/http` in Go, `hash('sha512', …)` and cURL in PHP, `SHA512` and `HttpClient` in .NET,
`Digest::SHA512` in Ruby, `sha2` + `reqwest` in Rust, `node:crypto` and `fetch` in Node. Translate
the recipe into the project's own idiom; keep everything else exactly as specified.

---

## Two surfaces, two hosts, two credentials

| | Charging SDK flows | REST APIs |
|---|---|---|
| **What it is** | A signed URL you send the subscriber's **browser** to | A JSON **POST** your server makes |
| **Host** | `https://user.digimart.store` | `https://api.digimart.store` |
| **Credential** | `apiKey` in the URL + SHA-512 `signature` from the API Secret | `applicationId` + App Password (`password`) in the body |
| **Answer** | A browser redirect to your `redirectUrl`, then a notification POSTed to you | A JSON body with `statusCode` |
| **Covers** | Subscribing, one-time charging | Listing subscribers, looking them up, unsubscribing |

There is no REST call that charges anyone and no SDK flow that unsubscribes anyone. Digimart
publishes no SMS, USSD, OTP or balance API — see [12-source-discrepancies.md](12-source-discrepancies.md).

## Before you run anything

Export the credentials and the endpoints your application uses. Every command on this page reads
them from the environment, so nothing here contains a credential and nothing you copy can commit
one.

```bash
# Charging SDK — from the approved application in the portal
export DIGIMART_API_KEY='…'
export DIGIMART_API_SECRET='…'        # never in a URL, never in a client, never committed

# REST — from provisioning (the App Password arrives by email)
export DIGIMART_APP_ID='APP_XXXXXX'
export DIGIMART_PASSWORD='…'

export DIGIMART_SUBSCRIPTION_AUTHORIZE_URL='https://user.digimart.store/sdk/subscription/authorize'
export DIGIMART_CAAS_AUTHORIZE_URL='https://user.digimart.store/sdk/subscription/caas-authorize'
export DIGIMART_GET_SUBSCRIBERS_URL='https://api.digimart.store/subscription-info-server/getSubscribers'
export DIGIMART_CHARGING_INFO_URL='https://api.digimart.store/subscription/getSubscriberChargingInfo'
export DIGIMART_UNREGISTRATION_URL='https://api.digimart.store/subs/unregistration'
```

One variable per service, never a shared base URL: the two surfaces live on different hosts, and
an unset variable is how your code knows a service is not in use.

**Check your hashing first.** Before touching the platform, hash Digimart's worked example in your
language and compare:

| Signing string | SHA-512 (lowercase hex) |
|---|---|
| `myApiKey123\|2024-08-08T12:00:00Z\|mySecretKey456` | `f03c8c41e0fec896bc2510e51f46353b8d753512c4892a2c56004bcd2a3aa42ce625c3c92a76fa2b5571b161cff1b1e8a2b5b497e3c89f016561731b69547a8d` |
| `myApiKey123\|2024-08-08T12:00:00Z\|mySecretKey456\|50` | `3badf638ceca499000fd07b899e5fc0cec348d9762886b8430104291126683892845a208caef8e99b53432571e46c5f04162a1a25646443f7935239ea0901b38` |

```bash
printf '%s' 'myApiKey123|2024-08-08T12:00:00Z|mySecretKey456|50' | openssl dgst -sha512
```

A different digest means the bug is in your hashing — encoding, algorithm or hex case — and no
amount of debugging against Digimart will find it.

---

## Index

| Flow | Open | Signs | Variable |
|---|---|---|---|
| [Subscription Charging SDK (without header enrichment)](#subscription-charging-sdk-without-header-enrichment) | `https://user.digimart.store/sdk/subscription/authorize` | `apiKey\|requestTime\|apiSecret` | `DIGIMART_SUBSCRIPTION_AUTHORIZE_URL` |
| [Subscription Charging SDK (with header enrichment)](#subscription-charging-sdk-with-header-enrichment) | `https://user.digimart.store/sdk/subscription/authorize` | `apiKey\|requestTime\|apiSecret` | `DIGIMART_SUBSCRIPTION_AUTHORIZE_URL` |
| [One-Time Charging SDK (CaaS)](#one-time-charging-sdk-caas) | `https://user.digimart.store/sdk/subscription/caas-authorize` | `apiKey\|requestTime\|apiSecret\|amount` | `DIGIMART_CAAS_AUTHORIZE_URL` |

| REST call | Endpoint | Variable |
|---|---|---|
| [Subscriber List](#subscriber-list) | `POST https://api.digimart.store/subscription-info-server/getSubscribers` | `DIGIMART_GET_SUBSCRIBERS_URL` |
| [Subscriber Charging Info](#subscriber-charging-info) | `POST https://api.digimart.store/subscription/getSubscriberChargingInfo` | `DIGIMART_CHARGING_INFO_URL` |
| [User Unsubscription](#user-unsubscription) | `POST https://api.digimart.store/subs/unregistration` | `DIGIMART_UNREGISTRATION_URL` |

| Inbound | Digimart | Configured in |
|---|---|---|
| [Subscription Notification](#subscription-notification) | `POST <your-host>/api/digimart/subscription/notify` | Subscription Notification URL, on the application in the Digimart portal |
| [Charging Notification](#charging-notification) | `POST <your-host>/api/digimart/charging/notify` | Async charging resp URL, on the application in the Digimart portal (the charging notification URL entered with the charging details when provisioning) |
| [Redirect Return (browser)](#redirect-return-browser) | `GET <your-host>/digimart/return` | The redirectUrl query parameter of each SDK URL you build (not a portal setting) |

---

# Signed-URL charging flows — the subscriber's browser opens these

---

## Subscription Charging SDK (without header enrichment)

The default subscription flow. Build a signed URL and open it; Digimart asks the subscriber for their mobile number, sends an OTP, takes consent and starts the recurring charge.

| | |
|---|---|
| **Open** | `https://user.digimart.store/sdk/subscription/authorize` in a browser or web view — an HTTP redirect or a link, never a server-side fetch |
| **Environment variable** | `DIGIMART_SUBSCRIPTION_AUTHORIZE_URL` |
| **Signing string** | `apiKey\|requestTime\|apiSecret` → SHA-512 → lowercase hex |
| **Answer** | Browser redirect to your `redirectUrl` ([Redirect Return](#redirect-return-browser)), then the [Subscription Notification](#subscription-notification) on the *Subscription Notification URL* |
| **Full guide** | [03-subscription-sdk.md](03-subscription-sdk.md) |
| **Source** | <https://digimart.store/docs/subscription-sdk> |

### Query parameters

| Parameter | Type | | Signed | Definition |
|---|---|---|---|---|
| `apiKey` | string | **Required** | **yes** | Displayed on the application you created in the Digimart portal. Copy it after an administrator approves the app. Example: `32c8a59cef446de3b78090d142ddac0e`. |
| `requestId` | string (15 digits) | **Required** | — | A unique 15-digit identifier of your choosing. It correlates this request with the redirect response and the async notification. A requestId that has already been used cannot be reused. Example: `123456789012345`. **Generate a fresh one for every URL and persist it against the order before redirecting. Reuse is rejected with E1005.** |
| `requestTime` | string (ISO 8601 UTC) | **Required** | **yes** | The current time in UTC format. Digimart says to generate it in the Asia/Dhaka timezone (UTC+06:00); if it does not validate, the request is rejected. Example: `2024-07-08T10:33:54.929Z`. **Take the current instant once, into a variable, and use that same string in the hash and in the query string.** |
| `signature` | string (SHA-512 hex) | **Required** | — | SHA-512 hash of the pipe-joined string apiKey\|requestTime\|apiSecret, as lowercase hex. The API Secret is never sent in the URL, only its contribution to this hash. |
| `redirectUrl` | string (URL) | **Required** | — | The page subscribers are returned to after a successful or failed transaction, reached when they press 'Back to Application'. Example: `https://www.mywebsite.com`. |
| `msisdn` | string | Optional | — | The subscriber's mobile number. Optional. If you supply it, the number-entry screen is skipped and the flow goes straight to the OTP screen. Example: `01748277168`. |

### Signing

Join these fields with `|` — no spaces, no trailing separator, in exactly this order — hash the
UTF-8 bytes with SHA-512, and send the lowercase hex digest as `signature`:

```
apiKey|requestTime|apiSecret
```

Worked example: `myApiKey123|2024-08-08T12:00:00Z|mySecretKey456` → `f03c8c41e0fec896bc2510e51f46353b8d753512c4892a2c56004bcd2a3aa42ce625c3c92a76fa2b5571b161cff1b1e8a2b5b497e3c89f016561731b69547a8d`. The signing string is Digimart's worked example. The digest is its SHA-512, computed here so an implementation in any language can be checked against a known answer before it touches the platform.

### Build it

```bash
# Values used in the hash AND the URL — built once, reused.
REQUEST_ID="$(date +%s)$(printf '%05d' $((RANDOM % 100000)))"   # 15 digits, fresh every time
REQUEST_TIME="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"             # current instant, UTC, with Z
REDIRECT_URL='https://www.mywebsite.com'

# apiKey|requestTime|apiSecret  ->  SHA-512  ->  lowercase hex
SIGNATURE="$(printf '%s' "$DIGIMART_API_KEY|$REQUEST_TIME|$DIGIMART_API_SECRET" \
  | openssl dgst -sha512 | awk '{print $NF}')"

URL="$DIGIMART_SUBSCRIPTION_AUTHORIZE_URL?apiKey=$DIGIMART_API_KEY&requestId=$REQUEST_ID&requestTime=$REQUEST_TIME&signature=$SIGNATURE&redirectUrl=$REDIRECT_URL"
echo "$URL"          # open it in a browser — this is a page, not an API
```

The values go into the URL un-encoded here, as in Digimart's own sample URLs. In code, use the
language's query-string encoder — but hash the **raw** values, never the encoded ones. A
`redirectUrl` with its own query string must be percent-encoded.

### The URL you end up with

```
https://user.digimart.store/sdk/subscription/authorize
  ?apiKey=$DIGIMART_API_KEY
  &requestId=123456789012345
  &requestTime=2024-07-08T10:33:54.929Z
  &signature=$SIGNATURE
  &redirectUrl=https://www.mywebsite.com
```

Shown decoded. On the wire each value is percent-encoded by the query-string encoder; the
signature is computed over the raw values.

Digimart's published sample for this flow:

```
https://user.digimart.store/sdk/subscription/authorize?apiKey=32c8a59cef446de3b78090d142ddac0e&requestId=123456789012345&requestTime=2024-07-08T10:33:54.929Z&signature=0185e77e9cd469e0da58c6270eb838dc96af6e5c84f057405f3a62ea6979ac12491c47c69e0a42cab521b77b3b6409188304206c6308efa89c1971d0862ceda2&redirectUrl=https://www.mywebsite.com
```

### What the subscriber sees

Digimart renders every screen. You build none of them.

1. Number entry, with the recurring price shown before subscribing (skipped when msisdn is supplied)
2. OTP entry: an OTP is sent to the Grameenphone number and the subscriber acknowledges the recurring charge
3. Subscription confirmed
4. Error page if anything fails during the journey

### What comes back

1. **The redirect** — the browser lands on your `redirectUrl` with `subscriptionStatus`,
   `subscriberId` and `requestId` appended. Convenient, untrusted, may never arrive.
2. **The notification** — Digimart POSTs to the *Subscription Notification URL* configured on the
   application. Authoritative. Fulfil on this.

Digimart's published redirect sample. Published verbatim. The sample lands on the Digimart host; yours lands on the redirectUrl you sent, with these query parameters appended.

```
https://user.digimart.store?subscriptionStatus=S1000&subscriberId=OGI2OGY1Njk2NjhlNjAyMTM1OWIwMzlhYTIxOGIyMDBlYTZlNmEyYzY5ZTM5MmYzMjRkMDg1MmMzYmIzYzE5YTpncmE&requestId=123456789012347
```

`subscriptionStatus` is a status code from the SDK table — all 31 are in [07-status-codes.md](07-status-codes.md). Decode one with `node tools/digimart.mjs code <CODE>`, and check a URL you built with `node tools/digimart.mjs check-url '<url>'`.

### Rules

- This is not a REST API. There is nothing to POST: build the URL on your server and redirect the browser to it.
- Sign exactly three fields in this order: apiKey|requestTime|apiSecret.
- The redirect back to redirectUrl is a convenience that travels through the subscriber's browser. The notification on the Subscription Notification URL is the authoritative record.
- Store the requestId against your user before redirecting, and the subscriberId Digimart hands back against that requestId. subscriberId is a masked number and is how every later REST call and notification identifies the subscriber.
- Cancellation is not an SDK flow. It is the REST call POST /subs/unregistration, and a working cancel path is a condition of going live.

---

## Subscription Charging SDK (with header enrichment)

The same endpoint and signature as the subscription flow. Because an administrator has enabled 'Allow Capturing Mobile Number via Header Enrichment' on the application, Grameenphone supplies the number from the mobile network and the number-entry screen becomes a price-confirmation screen.

| | |
|---|---|
| **Open** | `https://user.digimart.store/sdk/subscription/authorize` in a browser or web view — an HTTP redirect or a link, never a server-side fetch |
| **Environment variable** | `DIGIMART_SUBSCRIPTION_AUTHORIZE_URL` |
| **Signing string** | `apiKey\|requestTime\|apiSecret` → SHA-512 → lowercase hex |
| **Answer** | Browser redirect to your `redirectUrl` ([Redirect Return](#redirect-return-browser)), then the [Charging Notification](#charging-notification) on the *Async charging resp URL* |
| **Full guide** | [03-subscription-sdk.md](03-subscription-sdk.md) |
| **Source** | <https://digimart.store/docs/subscription-sdk#with-header-enrichment> |

### Query parameters

| Parameter | Type | | Signed | Definition |
|---|---|---|---|---|
| `apiKey` | string | **Required** | **yes** | Displayed on the application you created in the Digimart portal. Copy it after an administrator approves the app. Example: `32c8a59cef446de3b78090d142ddac0e`. |
| `requestId` | string (15 digits) | **Required** | — | A unique 15-digit identifier of your choosing. It correlates this request with the redirect response and the async notification. A requestId that has already been used cannot be reused. Example: `123456789012345`. **Generate a fresh one for every URL and persist it against the order before redirecting. Reuse is rejected with E1005.** |
| `requestTime` | string (ISO 8601 UTC) | **Required** | **yes** | The current time in UTC format. Digimart says to generate it in the Asia/Dhaka timezone (UTC+06:00); if it does not validate, the request is rejected. Example: `2024-07-08T10:33:54.929Z`. **Take the current instant once, into a variable, and use that same string in the hash and in the query string.** |
| `signature` | string (SHA-512 hex) | **Required** | — | SHA-512 hash of the pipe-joined string apiKey\|requestTime\|apiSecret, as lowercase hex. Identical to the flow without header enrichment. |
| `redirectUrl` | string (URL) | **Required** | — | The page subscribers are returned to after a successful or failed transaction, reached when they press 'Back to Application'. Example: `https://www.mywebsite.com`. |
| `msisdn` | string | Optional | — | Optional, and largely redundant here. Whether or not you send it, the MSISDN is captured automatically through header enrichment. Example: `01748277168`. |
| `amount` | number | **Required** | — | The amount to be charged. Listed as a required parameter on this flow only; it is NOT part of the signing string here, and the documentation does not explain its role for a subscription. Example: `10`. *Send it as listed, keep it out of the hash, and confirm its effect with support@digimart.store before relying on it.* |

### Signing

Join these fields with `|` — no spaces, no trailing separator, in exactly this order — hash the
UTF-8 bytes with SHA-512, and send the lowercase hex digest as `signature`:

```
apiKey|requestTime|apiSecret
```

Worked example: `myApiKey123|2024-08-08T12:00:00Z|mySecretKey456` → `f03c8c41e0fec896bc2510e51f46353b8d753512c4892a2c56004bcd2a3aa42ce625c3c92a76fa2b5571b161cff1b1e8a2b5b497e3c89f016561731b69547a8d`. Identical to the flow without header enrichment: the amount is not signed on a subscription.

### Build it

```bash
# Values used in the hash AND the URL — built once, reused.
REQUEST_ID="$(date +%s)$(printf '%05d' $((RANDOM % 100000)))"   # 15 digits, fresh every time
REQUEST_TIME="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"             # current instant, UTC, with Z
REDIRECT_URL='https://www.mywebsite.com'

# apiKey|requestTime|apiSecret  ->  SHA-512  ->  lowercase hex
SIGNATURE="$(printf '%s' "$DIGIMART_API_KEY|$REQUEST_TIME|$DIGIMART_API_SECRET" \
  | openssl dgst -sha512 | awk '{print $NF}')"

URL="$DIGIMART_SUBSCRIPTION_AUTHORIZE_URL?apiKey=$DIGIMART_API_KEY&requestId=$REQUEST_ID&requestTime=$REQUEST_TIME&signature=$SIGNATURE&redirectUrl=$REDIRECT_URL&amount=10"
echo "$URL"          # open it in a browser — this is a page, not an API
```

The values go into the URL un-encoded here, as in Digimart's own sample URLs. In code, use the
language's query-string encoder — but hash the **raw** values, never the encoded ones. A
`redirectUrl` with its own query string must be percent-encoded.

### The URL you end up with

```
https://user.digimart.store/sdk/subscription/authorize
  ?apiKey=$DIGIMART_API_KEY
  &requestId=123456789012345
  &requestTime=2024-07-08T10:33:54.929Z
  &signature=$SIGNATURE
  &redirectUrl=https://www.mywebsite.com
  &amount=10
```

Shown decoded. On the wire each value is percent-encoded by the query-string encoder; the
signature is computed over the raw values.

Digimart's published sample for this flow:

```
https://user.digimart.store/sdk/subscription/authorize?apiKey=32c8a59cef446de3b78090d142ddac0e&requestId=123456789012345&requestTime=2024-07-08T10:33:54.929Z&signature=0185e77e9cd469e0da58c6270eb838dc96af6e5c84f057405f3a62ea6979ac12491c47c69e0a42cab521b77b3b6409188304206c6308efa89c1971d0862ceda2&redirectUrl=https://www.mywebsite.com
```

### What the subscriber sees

Digimart renders every screen. You build none of them.

1. Price confirmation with the number already known; the subscriber presses Get OTP
2. OTP entry
3. Payment success, with an SMS to the subscriber's masked number
4. Error page if anything fails during the journey

### What comes back

1. **The redirect** — the browser lands on your `redirectUrl` with `subscriptionStatus`,
   `subscriberId` and `requestId` appended. Convenient, untrusted, may never arrive.
2. **The notification** — Digimart POSTs to the *Async charging resp URL* configured on the
   application. Authoritative. Fulfil on this.

Digimart's published redirect sample. Published verbatim. The sample lands on the Digimart host; yours lands on the redirectUrl you sent, with these query parameters appended.

```
http://user.digimart.store?subscriptionStatus=S1000&subscriberId=ZjUyMTM1MjlhYmU0ZmJmY2FkYjRkYWI3NzE2ZDg0MjE0NjNjYTM5MGFhZTczOWZlZDUxMTcxN2U3YTVlZTRiNTpncmFtZWVucGhvbmU=&requestId=123456789012346
```

`subscriptionStatus` is a status code from the SDK table — all 31 are in [07-status-codes.md](07-status-codes.md). Decode one with `node tools/digimart.mjs code <CODE>`, and check a URL you built with `node tools/digimart.mjs check-url '<url>'`.

### Rules

- Header enrichment is switched on by a Digimart administrator on the application ('Allow Capturing Mobile Number via Header Enrichment'). You cannot turn it on from code.
- It only works when the subscriber is browsing on Grameenphone mobile data; the network is what supplies the number.
- Signing is identical to the flow without header enrichment: apiKey|requestTime|apiSecret. The amount listed on this flow is not signed.
- Digimart's documentation names the Async charging resp URL as this flow's notification field. Implement both notification handlers if the application might run either subscription variant.
- The notification is the authoritative record. The redirect only travels through the browser.

---

## One-Time Charging SDK (CaaS)

A single payment of a specific amount from the subscriber's Grameenphone mobile account. Same shape as a subscription, with a different path and an amount that is sent as a parameter AND folded into the signature.

| | |
|---|---|
| **Open** | `https://user.digimart.store/sdk/subscription/caas-authorize` in a browser or web view — an HTTP redirect or a link, never a server-side fetch |
| **Environment variable** | `DIGIMART_CAAS_AUTHORIZE_URL` |
| **Signing string** | `apiKey\|requestTime\|apiSecret\|amount` → SHA-512 → lowercase hex |
| **Answer** | Browser redirect to your `redirectUrl` ([Redirect Return](#redirect-return-browser)), then the [Charging Notification](#charging-notification) on the *Async charging resp URL* |
| **Full guide** | [04-one-time-sdk.md](04-one-time-sdk.md) |
| **Source** | <https://digimart.store/docs/one-time-sdk> |

> **This flow moves real money.** Decide the amount on the server, sign it, and deliver only when the
> charging notification arrives with `statusCode` `S1000` for this `requestId`.

### Query parameters

| Parameter | Type | | Signed | Definition |
|---|---|---|---|---|
| `apiKey` | string | **Required** | **yes** | Displayed on the application you created in the Digimart portal. Copy it after an administrator approves the app. Example: `32c8a59cef446de3b78090d142ddac0e`. |
| `requestId` | string (15 digits) | **Required** | — | A unique 15-digit identifier of your choosing. It correlates this request with the redirect response and the async notification. Reuse is rejected with E1005. Example: `123456789012345`. **Generate a fresh one for every URL and persist it against the order before redirecting. It is how the notification is matched to the purchase.** |
| `requestTime` | string (ISO 8601 UTC) | **Required** | **yes** | The current time in UTC format. Digimart says to generate it in the Asia/Dhaka timezone (UTC+06:00); if it does not validate, the request is rejected. Example: `2024-07-08T10:33:54.929Z`. **Take the current instant once, into a variable, and use that same string in the hash and in the query string.** |
| `signature` | string (SHA-512 hex) | **Required** | — | SHA-512 hash of the pipe-joined string apiKey\|requestTime\|apiSecret\|amount, as lowercase hex. The amount must be encrypted under the signature. |
| `redirectUrl` | string (URL) | **Required** | — | The page subscribers are returned to after a successful or failed transaction, reached when they press 'Back to Application'. Example: `https://www.mywebsite.com`. |
| `msisdn` | string | Optional | — | The subscriber's mobile number. Optional. If supplied, the number-entry screen is skipped and the flow goes straight to the OTP screen. Example: `01748277168`. |
| `amount` | number | **Required** | **yes** | The amount to be charged, in BDT. Sent as a query parameter AND appended to the signing string. The published band is 1 to 600 BDT. Example: `10`. **Decide it on the server from your own price list, never from client input, and use the identical string in the hash and in the query string.** |

### Signing

Join these fields with `|` — no spaces, no trailing separator, in exactly this order — hash the
UTF-8 bytes with SHA-512, and send the lowercase hex digest as `signature`:

```
apiKey|requestTime|apiSecret|amount
```

Worked example: `myApiKey123|2024-08-08T12:00:00Z|mySecretKey456|50` → `3badf638ceca499000fd07b899e5fc0cec348d9762886b8430104291126683892845a208caef8e99b53432571e46c5f04162a1a25646443f7935239ea0901b38`. The signing string is Digimart's worked example for a one-time charge of BDT 50. The digest is its SHA-512, computed here as a known answer for testing an implementation.

### Build it

```bash
# Values used in the hash AND the URL — built once, reused.
REQUEST_ID="$(date +%s)$(printf '%05d' $((RANDOM % 100000)))"   # 15 digits, fresh every time
REQUEST_TIME="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"             # current instant, UTC, with Z
AMOUNT='10'
REDIRECT_URL='https://www.mywebsite.com'

# apiKey|requestTime|apiSecret|amount  ->  SHA-512  ->  lowercase hex
SIGNATURE="$(printf '%s' "$DIGIMART_API_KEY|$REQUEST_TIME|$DIGIMART_API_SECRET|$AMOUNT" \
  | openssl dgst -sha512 | awk '{print $NF}')"

URL="$DIGIMART_CAAS_AUTHORIZE_URL?apiKey=$DIGIMART_API_KEY&requestId=$REQUEST_ID&requestTime=$REQUEST_TIME&signature=$SIGNATURE&redirectUrl=$REDIRECT_URL&amount=$AMOUNT"
echo "$URL"          # open it in a browser — this is a page, not an API
```

The values go into the URL un-encoded here, as in Digimart's own sample URLs. In code, use the
language's query-string encoder — but hash the **raw** values, never the encoded ones. A
`redirectUrl` with its own query string must be percent-encoded.

### The URL you end up with

```
https://user.digimart.store/sdk/subscription/caas-authorize
  ?apiKey=$DIGIMART_API_KEY
  &requestId=123456789012345
  &requestTime=2024-07-08T10:33:54.929Z
  &signature=$SIGNATURE
  &redirectUrl=https://www.mywebsite.com
  &amount=10
```

Shown decoded. On the wire each value is percent-encoded by the query-string encoder; the
signature is computed over the raw values.

Digimart's published sample for this flow:

```
https://user.digimart.store/sdk/subscription/caas-authorize?apiKey=32c8a59cef446de3b78090d142ddac0e&requestId=123456789012345&requestTime=2024-07-08T10:33:54.929Z&signature=0185e77e9cd469e0da58c6270eb838dc96af6e5c84f057405f3a62ea6979ac12491c47c69e0a42cab521b77b3b6409188304206c6308efa89c1971d0862ceda2&redirectUrl=https://www.mywebsite.com&amount=10
```

### What the subscriber sees

Digimart renders every screen. You build none of them.

1. Number entry, with the exact amount shown before paying (skipped when msisdn is supplied)
2. OTP entry: Grameenphone generates and sends the OTP, with the charge restated
3. Payment success, with an SMS to the subscriber's masked number
4. Error page if anything fails during the journey

### What comes back

1. **The redirect** — the browser lands on your `redirectUrl` with `subscriptionStatus`,
   `subscriberId` and `requestId` appended. Convenient, untrusted, may never arrive.
2. **The notification** — Digimart POSTs to the *Async charging resp URL* configured on the
   application. Authoritative. Fulfil on this.

Digimart's published redirect sample. Published verbatim. The sample lands on the Digimart host; yours lands on the redirectUrl you sent, with these query parameters appended.

```
http://user.digimart.store?subscriptionStatus=S1000&subscriberId=ZjUyMTM1MjlhYmU0ZmJmY2FkYjRkYWI3NzE2ZDg0MjE0NjNjYTM5MGFhZTczOWZlZDUxMTcxN2U3YTVlZTRiNTpncmFtZWVucGhvbmU=&requestId=123456789012346
```

`subscriptionStatus` is a status code from the SDK table — all 31 are in [07-status-codes.md](07-status-codes.md). Decode one with `node tools/digimart.mjs code <CODE>`, and check a URL you built with `node tools/digimart.mjs check-url '<url>'`.

### Rules

- Sign FOUR fields: apiKey|requestTime|apiSecret|amount. Signing only the first three is the single most common reason a working subscription integration fails when copied to one-time charging — every request comes back E1002.
- Send amount as a query parameter as well as signing it, and use the byte-identical string in both places.
- The amount must fall between 1 and 600 BDT, or the platform returns E1330 (too low) or E1329 (too high).
- Take the amount from your own server-side price list. An amount taken from the client lets a user set their own price.
- Deliver the goods only when the charging notification arrives with statusCode S1000 for this requestId. Compare paidAmount with what you asked for rather than assuming they match.

---

# REST APIs — your server calls Digimart

---

## Subscriber List

Returns the subscribers registered against your application, one page at a time. It exists so you can retrieve subscription notifications you missed and reconcile your records against the platform's.

| | |
|---|---|
| **Endpoint** | `POST https://api.digimart.store/subscription-info-server/getSubscribers` |
| **Environment variable** | `DIGIMART_GET_SUBSCRIBERS_URL` |
| **Content type** | `application/json;charset=utf-8` |
| **Full guide** | [06-rest-apis.md](06-rest-apis.md) |
| **Source** | <https://digimart.store/docs/rest-api#endpoints> |

### Request parameters

| Parameter | Type | | Definition |
|---|---|---|---|
| `applicationId` | string | **Required** | Unique identification of the application within the platform. |
| `password` | string | **Required** | Password given when provisioning the application (the App Password). |
| `version` | string | Optional | The version of the API being invoked. |
| `status` | enum | Optional | Filter by subscription entry status. One of `REGISTERED`, `TEMPORARY_BLOCKED`, `REG_PENDING`. |
| `subscriberRequestId` | string | Optional | The initial request ID allocated when the Charging SDK transaction was triggered for a particular user. |
| `requestPage` | integer | **Required** | The page number to fetch from the list of pages containing subscription notifications. A JSON number, not a string. |

### Request

```bash
curl -sS -X POST "$DIGIMART_GET_SUBSCRIBERS_URL" \
  -H 'Content-Type: application/json;charset=utf-8' \
  --max-time 15 \
  -d @- <<REQUEST
{
  "applicationId": "$DIGIMART_APP_ID",
  "password": "$DIGIMART_PASSWORD",
  "version": "2.0",
  "status": "REGISTERED",
  "subscriberRequestId": "124002601656523239",
  "requestPage": 2
}
REQUEST
```

### Response

Success is `statusCode` `S1000` or `S1001` in the body — branch on that, not on the HTTP status. The message is in `statusDetail`.

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

### Response fields

| Field | Type | Meaning |
|---|---|---|
| `version` | string | API version. |
| `statusCode` | string | Success or error code for the entire request. The specification permits S1000, S1001, E1100, E1102, E1103, E1104, E1105, E1106 and E1107. |
| `statusDetail` | string | Description corresponding to the status code. For every code except S1000 this is the only explanation Digimart gives — log it. |
| `nextPageNumber` | integer | The next available page number. -1 when no further page exists. |
| `moreDataAvailable` | boolean | Whether more data is available beyond this page. |
| `requestId` | string | Unique identifier of this response. Quote it when raising a support ticket. |
| `subscribers` | object[] | One entry per subscriber. Typed as a single object in the specification and shown as an array in the example — normalise to an array. |
| `subscribers[].subscriberId` | string | The subscriber, as tel:&lt;masked number&gt;. The specification notes the application only accepts masked numbers here. |
| `subscribers[].subscriberRequestId` | string | The initial request ID allocated when the Charging SDK transaction was triggered for this user — your requestId. |
| `subscribers[].subscriptionStatus` | string | Status of the subscription, e.g. INITIAL, REG_PENDING, REGISTERED or TEMPORARY_BLOCKED. |
| `subscribers[].lastChargedDate` | string | The last successful charge date, documented as YYYY-MM-DD hh:mm:ss (the example uses dots: 2020-01-23 22.03.22). |
| `subscribers[].lastChargedAmount` | string | The last successful charge amount with the currency code, e.g. 30.00 BDT. |

### Reading the response

- Page while moreDataAvailable is true, requesting nextPageNumber each time. nextPageNumber is -1 when there is no further page.
- Normalise subscribers to an array before iterating: the specification types it as one object, the example shows an array.
- Match each entry to your records by subscriberRequestId (your original requestId) and subscriberId; update your local subscription state from subscriptionStatus.
- S1001 is permitted by the specification with no published meaning. It is S-prefixed, the success family, so do not raise an error on it — process whatever the page carries and log statusDetail.

Check a real response with `node tools/digimart.mjs response get-subscribers '<the body you got>'`.

### Status codes for this endpoint

| Code | Class | Meaning |
|---|---|---|
| `S1000` | success | Success → The request completed. For a charge, still wait for the async notification before you deliver anything. |
| `S1001` | undocumented-success | Permitted on the Subscriber List response. Digimart publishes no description. **Accepted as a success for this call.** |
| `E1100` | undocumented | Permitted on the Subscriber List response. Digimart publishes no description. |
| `E1102` | undocumented | Permitted on the Subscriber List response. Digimart publishes no description. |
| `E1103` | undocumented | Permitted on the Subscriber List response. Digimart publishes no description. |
| `E1104` | undocumented | Permitted on the Subscriber List response. Digimart publishes no description. |
| `E1105` | undocumented | Permitted on the Subscriber List response. Digimart publishes no description. |
| `E1106` | undocumented | Permitted on the Subscriber List response. Digimart publishes no description. |
| `E1107` | undocumented | Permitted on the Subscriber List response. Digimart publishes no description. |

`success` proceed · `undocumented-success` S-prefixed with no published meaning — do not raise an error · `configuration` fix the application in the portal, not the code · `client` fix what you built · `user-state` tell the subscriber what to do; do not loop · `transient` start again / back off · `undocumented` permitted with no published meaning — log statusDetail and escalate. Full table: [07-status-codes.md](07-status-codes.md).

### Rules

- A catch-up and reconciliation mechanism for missed notifications, not a substitute for handling the Subscription Notification URL.
- requestPage is the only integer in any Digimart request body. Everything else is a string.
- Apart from S1000, Digimart publishes no description for these status codes. Log statusCode, statusDetail and requestId, and escalate to support@digimart.store rather than guessing.

---

## Subscriber Charging Info

Current subscription state and last charge for a list of subscribers. Answers 'is this person still subscribed, and when did they last pay'.

| | |
|---|---|
| **Endpoint** | `POST https://api.digimart.store/subscription/getSubscriberChargingInfo` |
| **Environment variable** | `DIGIMART_CHARGING_INFO_URL` |
| **Content type** | `application/json;charset=utf-8` |
| **Full guide** | [06-rest-apis.md](06-rest-apis.md) |
| **Source** | <https://digimart.store/docs/rest-api#endpoints> |

### Request parameters

| Parameter | Type | | Definition |
|---|---|---|---|
| `applicationId` | string | **Required** | Unique identification of the application within the platform. |
| `password` | string | **Required** | Password given when provisioning the application (the App Password). |
| `subscriberId` | string[] | Optional | The subscribers to look up, each as tel:&lt;msisdn&gt;. If the application uses masked numbers, send the masked values. An array even for one subscriber. |

### Request

```bash
curl -sS -X POST "$DIGIMART_CHARGING_INFO_URL" \
  -H 'Content-Type: application/json;charset=utf-8' \
  --max-time 15 \
  -d @- <<REQUEST
{
  "applicationId": "$DIGIMART_APP_ID",
  "password": "$DIGIMART_PASSWORD",
  "subscriberId": [
    "tel:NTM3MDgzMWI2ZDAwMzlmZTQ0N2Y1ZGFhMzQwOTM2MDA0YmEzZWRiYTFjYzIzNzhhZDZhYjZjNmI1MzliZWIxYTpiYW5nbGFsaW5r"
  ]
}
REQUEST
```

### Response

Success is `statusCode` `S1000` in the body — branch on that, not on the HTTP status. The message is in `statusDetail`.

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

### Response fields

| Field | Type | Meaning |
|---|---|---|
| `version` | string | API version. |
| `statusCode` | string | The status code for the entire request. |
| `statusDetail` | string | Description of the status for the entire request. |
| `requestId` | string | Unique identifier of this response. Quote it when raising a support ticket. |
| `destinationResponses` | object[] | One entry per subscriber looked up, each with its own status. |
| `destinationResponses[].subscriberId` | string | The subscriber this entry is about. |
| `destinationResponses[].subscriptionStatus` | string | Status of the subscription, e.g. INITIAL, REG_PENDING, REGISTERED or TEMPORARY_BLOCKED. |
| `destinationResponses[].subscriberRequestId` | string | The initial request ID allocated when the Charging SDK transaction was triggered for this user. |
| `destinationResponses[].lastChargedDate` | string | The last successful charge date. |
| `destinationResponses[].lastChargedAmount` | string | The last successful charge amount with the currency code. |
| `destinationResponses[].numberType` | string | prepaid or postpaid. |
| `destinationResponses[].statusCode` | string | Outcome for this subscriber. Can fail while the top-level statusCode is S1000. |
| `destinationResponses[].statusDetail` | string | Description of this subscriber's outcome. |

### Reading the response

- A top-level S1000 means the request was processed, not that every subscriber was found. Read the statusCode on every entry in destinationResponses.
- Use it for an on-demand check (before starting a new opt-in, which would otherwise fail with E3001 'User Already Registered') — not on every page load. Mirror state from the notifications instead.

Check a real response with `node tools/digimart.mjs response subscriber-charging-info '<the body you got>'`.

### Status codes for this endpoint

| Code | Class | Meaning |
|---|---|---|
| `S1000` | success | Success → The request completed. For a charge, still wait for the async notification before you deliver anything. |

The specification enumerates no further codes for this endpoint. Treat any other code as a
failure, log `statusDetail` and `requestId`, and escalate — do not borrow a meaning from another
platform.

`success` proceed · `undocumented-success` S-prefixed with no published meaning — do not raise an error · `configuration` fix the application in the portal, not the code · `client` fix what you built · `user-state` tell the subscriber what to do; do not loop · `transient` start again / back off · `undocumented` permitted with no published meaning — log statusDetail and escalate. Full table: [07-status-codes.md](07-status-codes.md).

### Rules

- subscriberId is an ARRAY of tel:-prefixed strings, even for one subscriber.
- Send the masked value Digimart gave you, prefixed with tel:. The subscriberId on the redirect and on notifications has no prefix.
- The specification enumerates no status codes for this endpoint beyond the S1000 example. Treat any other code as a failure and log statusDetail.

---

## User Unsubscription

Ends a subscriber's subscription to your application. This is the API behind any 'cancel my subscription' control you build — and a working cancellation path is a condition of the developer agreement.

| | |
|---|---|
| **Endpoint** | `POST https://api.digimart.store/subs/unregistration` |
| **Environment variable** | `DIGIMART_UNREGISTRATION_URL` |
| **Content type** | `application/json;charset=utf-8` |
| **Full guide** | [06-rest-apis.md](06-rest-apis.md) |
| **Source** | <https://digimart.store/docs/rest-api#endpoints> |

### Request parameters

| Parameter | Type | | Definition |
|---|---|---|---|
| `applicationId` | string | **Required** | Identifies the application. A unique identifier generated while provisioning. Only a single value per request. |
| `password` | string | **Required** | Authenticates the application-originated message against the credentials of the service provider (the App Password). |
| `subscriberId` | string | **Required** | The subscriber to unsubscribe, as tel:&lt;msisdn&gt;. May be a masked number depending on the application type. Only a single value per request. |
| `action` | enum | **Required** | The operation to perform. 0 means user unsubscription. Sent as the string "0", as the published example does. One of `0`. |

### Request

```bash
curl -sS -X POST "$DIGIMART_UNREGISTRATION_URL" \
  -H 'Content-Type: application/json;charset=utf-8' \
  --max-time 15 \
  -d @- <<REQUEST
{
  "applicationId": "$DIGIMART_APP_ID",
  "password": "$DIGIMART_PASSWORD",
  "subscriberId": "tel:NTM3MDgzMWI2ZDAwMzlmZTQ0N2Y1ZGFhMzQwOTM2MDA0YmEzZWRiYTFjYzIzNzhhZDZhYjZjNmI1MzliZWIxYTpiYW5nbGFsaW5r",
  "action": "0"
}
REQUEST
```

### Response

Success is `statusCode` `S1000` in the body — branch on that, not on the HTTP status. The message is in `statusDetail`.

```json
{
  "version": "2.0",
  "statusCode": "S1000",
  "statusDetail": "not registered",
  "requestId": "101901031657410007",
  "subscriptionStatus": "UNREGISTERED"
}
```

### Response fields

| Field | Type | Meaning |
|---|---|---|
| `version` | string | API version. |
| `statusCode` | string | The status code for the entire request. |
| `statusDetail` | string | Description of the status for the entire request. |
| `requestId` | string | Unique identifier of this response. Quote it when raising a support ticket. |
| `subscriptionStatus` | string | The resulting subscription status, e.g. UNREGISTERED. |

### Reading the response

- Read subscriptionStatus, not only statusCode. The published example pairs S1000 with the statusDetail 'not registered' and subscriptionStatus UNREGISTERED — the subscriber ends up unsubscribed either way.
- Mark the subscription ended in your own store immediately, and stop any access tied to it. Do not wait for a notification: none is documented for unsubscription.

Check a real response with `node tools/digimart.mjs response unregistration '<the body you got>'`.

### Status codes for this endpoint

| Code | Class | Meaning |
|---|---|---|
| `S1000` | success | Success → The request completed. For a charge, still wait for the async notification before you deliver anything. |

The specification enumerates no further codes for this endpoint. Treat any other code as a
failure, log `statusDetail` and `requestId`, and escalate — do not borrow a meaning from another
platform.

`success` proceed · `undocumented-success` S-prefixed with no published meaning — do not raise an error · `configuration` fix the application in the portal, not the code · `client` fix what you built · `user-state` tell the subscriber what to do; do not loop · `transient` start again / back off · `undocumented` permitted with no published meaning — log statusDetail and escalate. Full table: [07-status-codes.md](07-status-codes.md).

### Rules

- One subscriber per request. subscriberId is a single tel:-prefixed string here, not an array.
- action is "0" (user unsubscription) — the only published value.
- The specification enumerates no status codes for this endpoint beyond the S1000 example. Treat any other code as a failure, log statusDetail, and keep the user's cancel request so it can be retried.
- Make cancellation obvious in your product. It is on Digimart's go-live checklist.

---

# Inbound — Digimart calls you

---

## Subscription Notification

Digimart calls this on you. It posts subscription lifecycle changes — the registration from the subscription SDK, and status changes — to the URL configured on your application. The specification describes it as the callback to the initial Subscription Charging SDK request, denoting subscriber status.

| | |
|---|---|
| **Direction** | Digimart → you. There is nothing to call. |
| **Your route** | `POST <your-host>/api/digimart/subscription/notify` (the path is yours) |
| **Configured in** | Subscription Notification URL, on the application in the Digimart portal |
| **Deduplicate on** | `subscriberId + status + timeStamp` |
| **Full guide** | [05-callbacks.md](05-callbacks.md) |
| **Source** | <https://digimart.store/docs/rest-api#endpoints> |

### Payload fields

| Field | Type | | Definition |
|---|---|---|---|
| `timeStamp` | string | **Always sent** | The time the notification was sent, e.g. 20240801044105 (yyyyMMddHHmmss in every published sample). |
| `subscriberId` | string | **Always sent** | The subscriber the notification concerns — the masked value, with no tel: prefix. |
| `applicationId` | string | **Always sent** | Your application. Verify it equals DIGIMART_APP_ID and ignore the notification if it does not. |
| `version` | string | **Always sent** | API version, e.g. 2.0. |
| `frequency` | enum | **Always sent** | How often the subscription is billed. One of `daily`, `monthly`. |
| `status` | enum | **Always sent** | Status of the subscription entry. The specification limits it to these three. One of `REGISTERED`, `TEMPORARY_BLOCKED`, `REG_PENDING`. |
| `subscriberRequestId` | string | Optional | The requestId you allocated when you built the SDK URL for this user. The key that ties the notification to your user. |

### What arrives

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

### What you must respond

HTTP 200, immediately, before doing any work. Digimart publishes no response body for its notifications. Answer HTTP 200 quickly, then process asynchronously. Do not claim or depend on Digimart parsing anything you return.

### Replay it against your own handler

```bash
curl -sS -i -X POST "http://localhost:3000/api/digimart/subscription/notify" \
  -H 'Content-Type: application/json' \
  -d @- <<'PAYLOAD'
{
  "timeStamp": "20240801044105",
  "subscriberId": "ZmQ5YmRmMDA5NzdlZTzM5NjJjNjRkNWNiMjkzOWYxMzk4MzI3ZjYyM2UwMmJmYzY3YzpncmFtZWVucGhvbmU=",
  "applicationId": "APP_000186",
  "subscriberRequestId": "123456789012100",
  "version": "2.0",
  "frequency": "daily",
  "status": "REGISTERED"
}
PAYLOAD
```

### Rules

- Respond HTTP 200 promptly and do the work asynchronously. Digimart publishes no response body, so do not depend on anything you return being read.
- Match it to your user by subscriberRequestId (your original requestId), then record subscriberId against that user. This, not the browser redirect, is the authoritative subscriber mapping.
- Deduplicate on subscriberId + status + timeStamp. A replayed notification must not grant access twice.
- Verify applicationId against your own. Digimart publishes no signature or authentication for notifications, so reconcile anything that grants value against Subscriber List or Subscriber Charging Info.
- TEMPORARY_BLOCKED and REG_PENDING are live subscribers in trouble, not absent ones — suspend access, do not delete the record.
- Missed one? POST /subscription-info-server/getSubscribers exists to retrieve subscription notifications you did not receive.
- An earlier tutorial sample put the applicationId under a key equal to the requestId. The specification and the documentation use applicationId; accept that, and log any body where it is missing rather than failing.

---

## Charging Notification

Digimart posts the charging result here after a one-time charge, and after a subscription with header enrichment. This is the fact that money moved: deliver goods on this, never on the redirect.

| | |
|---|---|
| **Direction** | Digimart → you. There is nothing to call. |
| **Your route** | `POST <your-host>/api/digimart/charging/notify` (the path is yours) |
| **Configured in** | Async charging resp URL, on the application in the Digimart portal (the charging notification URL entered with the charging details when provisioning) |
| **Deduplicate on** | `internalTrxId + statusCode` |
| **Full guide** | [05-callbacks.md](05-callbacks.md) |
| **Source** | <https://digimart.store/docs/one-time-sdk#after-the-charge> |

> Digimart publishes a sample of this payload but no schema. The fields below are exactly the ones in the sample; treat every one as possibly absent and log the raw body on the first deliveries in sandbox. Do not invent fields.

### Payload fields

| Field | Type | | Definition |
|---|---|---|---|
| `requestId` | string | Optional | The requestId you put in the SDK URL. The key that ties this charge to your order. |
| `statusCode` | string | Optional | S1000 means the charge succeeded. Anything else is a failure; decode it with the SDK error codes. |
| `statusDetail` | string | Optional | Human-readable outcome, e.g. 'Request was Successfully processed, Due amount fully paid.' |
| `applicationId` | string | Optional | Your application. Verify it equals DIGIMART_APP_ID. |
| `subscriberId` | string | Optional | The masked subscriber, no tel: prefix. |
| `internalTrxId` | string | Optional | Digimart's transaction identifier. Store it; quote it to support. |
| `totalAmount` | string | Optional | The amount of the charge, as a decimal string, e.g. 50.95. |
| `paidAmount` | string | Optional | The amount actually paid, as a decimal string. Compare it with what you asked for. |
| `balanceDue` | number | Optional | Amount still due; 0 when fully paid. A JSON number in the sample, unlike the other amounts. |
| `currency` | string | Optional | Currency of the amounts, BDT. |
| `timeStamp` | string | Optional | When the notification was sent, e.g. 20240703090835. |
| `version` | string | Optional | API version, e.g. 2.0. |

### What arrives

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

### What you must respond

HTTP 200, immediately, before doing any work. Digimart publishes no response body for its notifications. Answer HTTP 200 quickly, then process asynchronously. Do not claim or depend on Digimart parsing anything you return.

### Replay it against your own handler

```bash
curl -sS -i -X POST "http://localhost:3000/api/digimart/charging/notify" \
  -H 'Content-Type: application/json' \
  -d @- <<'PAYLOAD'
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
PAYLOAD
```

### Status codes documented on this payload

| Code | Class | Meaning |
|---|---|---|
| `S1000` | success | Success → The request completed. For a charge, still wait for the async notification before you deliver anything. |

### Rules

- This is your settlement channel. Fulfil an order only when this arrives with statusCode S1000 for its requestId.
- Read totalAmount, paidAmount and balanceDue together, as decimals — never as binary floats. Fulfil when paidAmount equals the amount you asked for and balanceDue is 0.
- Deduplicate on internalTrxId + statusCode (fall back to requestId + statusCode if internalTrxId is absent). A repeat must not double-count revenue or deliver twice.
- Verify applicationId against your own and the requestId against an order you created. Digimart publishes no signature for notifications.
- Respond HTTP 200 promptly, then process asynchronously. Digimart publishes no response body.
- The amounts mix types in the sample: totalAmount and paidAmount are strings, balanceDue is a number. Parse both forms.
- Only S1000 is documented on this payload. Treat any other statusCode as a failed charge and decode it against the SDK error codes, which share the same code scheme.

---

## Redirect Return (browser)

When the subscriber presses 'Back to Application', Digimart sends their browser to your redirectUrl with the outcome appended as query parameters. It is a convenience for the user interface, not a record of payment.

| | |
|---|---|
| **Direction** | Digimart → you. There is nothing to call. |
| **Your route** | `GET <your-host>/digimart/return` (the path is yours) |
| **Configured in** | The redirectUrl query parameter of each SDK URL you build (not a portal setting) |
| **Deduplicate on** | `requestId` |
| **Full guide** | [05-callbacks.md](05-callbacks.md) |
| **Source** | <https://digimart.store/docs/subscription-sdk#after-the-charge> |

### Query parameters

| Field | Type | | Definition |
|---|---|---|---|
| `subscriptionStatus` | string | **Always** | A status code — S1000 on success or one of the SDK error codes. Not a word like REGISTERED or CHARGED. |
| `subscriberId` | string | **Always** | Masked number corresponding to the subscriber. |
| `requestId` | string | **Always** | The requestId you allocated when you built the URL. |

### What arrives

```
GET <your redirectUrl>?subscriptionStatus=S1000&subscriberId=OGI2OGY1Njk2NjhlNjAyMTM1OWIwMzlhYTIxOGIyMDBlYTZlNmEyYzY5ZTM5MmYzMjRkMDg1MmMzYmIzYzE5YTpncmE&requestId=123456789012347
```

### What you must respond

A page for the subscriber, chosen by `subscriptionStatus`. Never grant anything here.

### Replay it against your own handler

```bash
curl -sS -i "http://localhost:3000/digimart/return?subscriptionStatus=S1000&subscriberId=OGI2OGY1Njk2NjhlNjAyMTM1OWIwMzlhYTIxOGIyMDBlYTZlNmEyYzY5ZTM5MmYzMjRkMDg1MmMzYmIzYzE5YTpncmE&requestId=123456789012347"
```

### Rules

- Query parameters on a GET, not a JSON body. Parse them from the URL.
- It travels through the subscriber's browser: it may never arrive (they close the tab) and anyone can forge it by typing a URL. Never grant access or deliver goods on it.
- Use it to show the right screen: on S1000 'payment received, confirming…' until the notification lands; on E3009 a friendly recharge prompt; on E1xxx a generic apology (it is your bug) — never the raw code.
- Look the requestId up in your own store. Ignore a requestId you never issued.
- Record subscriberId against the requestId as provisional, and confirm it from the notification, which is authoritative.
- If the redirectUrl is a mobile deep link or a web view, intercept it there and hand the query string to your backend; the rules are the same.

---

## What a recipe does not show

Every recipe above is a hash and a query string, or one HTTPS POST, and that part ports to any
language in a few lines. The difference between a working call and a production integration is
what surrounds it:

| | Why the recipe hides it |
|---|---|
| **The secret stays on the server** | A shell has the secret in its environment. A browser or a phone must never: clients call *your* start endpoint, and your server signs. |
| **The amount comes from your price list** | Typed by hand here. In code it is looked up on the server by what the user is buying — never taken from the client. |
| **One `requestTime`, one `amount`, used twice** | The recipe builds each into a variable once. Code that formats them again for the URL produces `E1002`. |
| **`requestId` persisted first** | Allocate, store against the order, then redirect. The notification is matched on it. |
| **Fulfil on the notification** | The replay commands show both signals. Only the notification grants anything. |
| **Acknowledge first, idempotently** | Answer 200 and queue; deduplicate on the documented key. |
| **`statusCode` branching on REST** | You read the JSON yourself here. Code that trusts the HTTP status is wrong. |
| **`tel:` in one helper** | The notification gives a bare masked `subscriberId`; the REST calls want `tel:<value>`. |

Those are specified language-neutrally in [10-any-stack.md](10-any-stack.md), and built in
TypeScript/Node, Python, Java, Go, PHP and C# in [templates/](../templates/README.md).

## Related

| | |
|---|---|
| Machine-readable form of this page | [`catalog/digimart-api.json`](../catalog/digimart-api.json) |
| Build a signed URL with your own values | `node tools/digimart.mjs url <flow> key=value …` |
| Check a URL you built | `node tools/digimart.mjs check-url '<url>'` |
| Build a REST call | `node tools/digimart.mjs curl <id> key=value …` |
| Decode a status code | `node tools/digimart.mjs code <statusCode>` |
| Smoke-test the REST calls | [`scripts/smoke-test.sh`](../scripts/smoke-test.sh) (or `smoke-test.ps1`) |
| Test your inbound handlers | [`scripts/test-callbacks.sh`](../scripts/test-callbacks.sh) |
