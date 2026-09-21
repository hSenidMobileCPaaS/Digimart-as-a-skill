# Status Codes

Digimart has **two separate code sets**, and mixing them up is the fastest way to write wrong error
handling:

| | SDK error codes | REST status codes |
|---|---|---|
| Where they appear | `subscriptionStatus` on the redirect; `statusCode` on the charging notification | `statusCode` in a REST response body |
| How many | 31, each with Digimart's own wording | 9 permitted on the subscriber list; only `S1000` described |
| Source | The identical table on all three SDK flows, <https://digimart.store/docs/error-codes> | The REST specification, <https://digimart.store/docs/rest-api#status-codes> |

The SDK codes **do not apply** to the REST endpoints, and the REST codes `E1100`–`E1107` do not mean
anything Digimart has published. Some of those numbers exist with published meanings on other
hSenid platforms; **do not borrow them** — nothing says Digimart uses them the same way.

## The rules

1. **`S1000` is the only documented success.** Everything beginning with `E` is a failure.
2. **On the SDK, success on the redirect is not payment.** Deliver only when the notification
   arrives with `S1000`.
3. **On REST, branch on `statusCode` in the body**, and on Charging Info check each
   `destinationResponses[].statusCode` too.
4. **Never show a raw code to a customer.** Map it to what they should do next.
5. **An SDK "retry" is a new URL with a new `requestId`.** Reusing one is `E1005`.

```bash
node tools/digimart.mjs code E1002
node tools/digimart.mjs diagnose "E3009"
```

## Handling classes

| Class | Retry | What to do |
|---|---|---|
| `success` | no | Proceed. On the SDK, still deliver only when the async notification confirms it. |
| `undocumented-success` | no | S-prefixed, which is the success family in Digimart's code scheme, but Digimart publishes no meaning for it. Do not raise an error: process whatever the body carries, and log statusCode and statusDetail. |
| `configuration` | no | The application, its key or its entitlements are wrong. Fix it in the portal or with support@digimart.store — code changes will not help. Alert on these: the integration is down, not one request. |
| `client` | no | What you built is wrong. Fix the URL, the signature or the body. On the SDK, retrying means a NEW URL with a fresh requestId. |
| `user-state` | after the subscriber acts | The subscriber cannot complete this right now. Tell them what to do in plain words; do not re-prompt in a loop, and never show the raw code. |
| `transient` | yes | Platform-side. On the SDK, let the subscriber start again with a fresh requestId; on REST, retry with capped exponential backoff. If it persists, send the requestId to support@digimart.store. |
| `undocumented` | no | Permitted by Digimart's specification with no published meaning. Treat the request as failed, log statusCode, statusDetail and requestId, and escalate to support@digimart.store rather than guessing. |

## A sane handling strategy

Do not write a branch for all thirty-one codes. Group them by what should happen next:

| Group | Codes | Do |
|---|---|---|
| Deliver — once the notification confirms | `S1000` | Show "confirming", grant on the notification |
| A money problem | `E3009` | A friendly "please recharge and try again" screen with a retry (a new URL). Your most common failure by far. |
| The subscriber mistyped the OTP | `E4001` | Digimart lets them re-enter it within the same flow |
| Too many attempts | `E1014`, `E2002`, `E3003`, `E3007` | "Try again later". Do not re-prompt in a loop. |
| This number can't | `E3002`, `E3004`, `E3005`, `E3006` | Return them somewhere pleasant; do not automatically re-prompt |
| Already done | `E3001` | "You're already subscribed" |
| A platform hiccup | `E1001`, `E1013`, `E2001`, `E2003`, `E2004` | Offer to start again — a new URL with a new `requestId`. Report with the `requestId` if it repeats. |
| Your bug | `E1002`, `E1003`, `E1004`, `E1005`, `E1009`, `E1012`, `E1329`, `E1330`, `E3008` | Log with the `requestId`, alert yourself, show a generic apology |
| Your configuration | `E1006`, `E1007`, `E1008`, `E1010`, `E1011` | The integration is down. Portal or support, not code. Alert. |

This grouping follows Digimart's own "sane handling strategy" on the error-codes page, split a
little further so configuration problems page someone.

## SDK error codes — all 31

The *Meaning* column is Digimart's wording, verbatim. The *What to do* column is guidance — Digimart
labels its own fixes as its guidance rather than the operator's, and so does this skill.

| Code | Family | Class | Meaning (Digimart's wording) | What to do |
|---|---|---|---|---|
| `S1000` | Success | success | Success | The request completed. For a charge, still wait for the async notification before you deliver anything. |
| `E1001` | Request validation | transient | Error Occurred. Please Try Again. | A general failure with no specific cause reported. Retry with a fresh requestId; if it persists, send your requestId to support. |
| `E1002` | Request validation | client | Invalid Signature | The most common integration error. Check the field order (apiKey|requestTime|apiSecret, plus |amount for one-time), that separators are pipes with no spaces, that requestTime (and amount) in the hash are byte-identical to the ones in the URL, that you hashed with SHA-512 and emitted lowercase hex, and that you hashed raw rather than URL-encoded values. Check your hashing against the worked example: node tools/digimart.mjs sign --example. |
| `E1003` | Request validation | client | Invalid Time Format | Send requestTime as ISO 8601 UTC with milliseconds and a Z, for example 2024-07-08T10:33:54.929Z. |
| `E1004` | Request validation | client | Request Timeout | The request took too long or requestTime was too far from server time. Sync your clock with NTP and build the URL immediately before redirecting — never cache a signed URL. |
| `E1005` | Request validation | client | A record with this requestId already exists. Please enter a unique requestId to proceed. | Generate a fresh 15-digit requestId for every URL. Never retry with one you have already used. |
| `E1006` | Request validation | configuration | Invalid Api Key | Copy the API Key again from your application in the Digimart portal, and check the deployment is loading the right environment's key. |
| `E1007` | Request validation | configuration | Unauthorized | The credentials are recognised but not permitted for this call. Confirm the application is approved and the key belongs to it. |
| `E1008` | Request validation | configuration | This Service Is Not Allowed For The Application. Please Contact Administrator. | The application is not entitled to the service you called. Enable the relevant API (CaaS) on the app and resubmit it for approval. |
| `E1009` | Request validation | client | Invalid Request | A parameter is missing or malformed. Compare your query string against the flow's parameter table: node tools/digimart.mjs check-url '<your url>'. |
| `E1010` | Request validation | configuration | This Service Is Not Allowed For The SP. Please Contact Administrator | The restriction is on the service provider account rather than the app. Only an administrator can lift it. |
| `E1011` | Request validation | configuration | SDK Is Not Enabled For This Application. Please Contact Administrator | Turn on the Subscription Charging SDK for the application in the portal, then have it approved. |
| `E1012` | Request validation | client | Please Start From The Beginning | The session state was lost, usually because a step was skipped or a page was reloaded. Build a new URL with a new requestId. |
| `E1013` | Request validation | transient | Internal Error Occurred. Please Try Again. | A platform-side failure. Retry with a new requestId; report it with the requestId if it repeats. |
| `E1014` | Request validation | user-state | Sorry, your number of verification attempts exceeded. Please try again in (xx) minutes. | The subscriber is rate limited. Show the wait time rather than letting them retry immediately. |
| `E1329` | Request validation | client | Charging amount too high | The amount exceeds the permitted ceiling. The published one-time band is 1 to 600 BDT. |
| `E1330` | Request validation | client | Charging amount too low | The amount is below the permitted floor. The published one-time band starts at 1 BDT. |
| `E2001` | OTP delivery | transient | Request OTP Failed Due to an Internal Error | The OTP could not be issued. Usually transient at the operator, so let the subscriber retry. |
| `E2002` | OTP delivery | user-state | You Have Exceeded Resend Attempts | The subscriber pressed resend too many times. They must start a new flow. |
| `E2003` | OTP delivery | transient | OTP Verification Failed Due to an Internal Error | Verification could not complete on the platform side. Restart with a new requestId. |
| `E2004` | OTP delivery | transient | Subscriber MSISDN validation Failed Due to an Internal Error | The number could not be validated. Confirm it is a Grameenphone number in the expected format, then let the subscriber retry. |
| `E3001` | Subscriber account | user-state | User Already Registered | The subscriber already has an active subscription. Check with Subscriber Charging Info before starting a new opt-in, and treat this as 'already subscribed', not as an error. |
| `E3002` | Subscriber account | user-state | Authentication Failure. | The subscriber could not be authenticated by the operator. |
| `E3003` | Subscriber account | user-state | Maximum Number of OTP Requests Reached | The subscriber has requested too many OTPs. They must wait before trying again. |
| `E3004` | Subscriber account | user-state | This Service Is Not Allowed for Your Operator | The number is not on an operator this service covers. Digimart charges Grameenphone subscribers. |
| `E3005` | Subscriber account | user-state | Your Mobile Number Is Not Whitelisted to Use This Application | Common in sandbox: only whitelisted test numbers can transact until the app is approved for production. |
| `E3006` | Subscriber account | user-state | Your Mobile Number Is Blacklisted to Use This Application | The number is blocked for this application. Do not retry automatically. |
| `E3007` | Subscriber account | user-state | Your Mobile Number Has Reached Maximum Number of OTP Attempts | Too many wrong entries from this number. The subscriber is locked out temporarily. |
| `E3008` | Subscriber account | client | Invalid Mobile Number Format | The msisdn is malformed. The documented sample uses the local form 01748277168. If you passed msisdn in the URL, fix what you sent; otherwise the subscriber mistyped. |
| `E3009` | Subscriber account | user-state | Your account balance is too low, recharge and try again | The single most common real-world failure. Give it its own friendly recharge screen with a retry, and consider offering a cheaper tier. |
| `E4001` | Verification | user-state | Invalid OTP, please try again | The subscriber typed the wrong code. Digimart lets them re-enter it within the same flow. |

The source table lists `E3009` before `E3008` and `E1330` before `E1329`; they are in numeric order
here.

## REST status codes

| Code | Class | Meaning |
|---|---|---|
| `S1000` | success | Success |
| `S1001` | undocumented-success | *No description published.* |
| `E1100` | undocumented | *No description published.* |
| `E1102` | undocumented | *No description published.* |
| `E1103` | undocumented | *No description published.* |
| `E1104` | undocumented | *No description published.* |
| `E1105` | undocumented | *No description published.* |
| `E1106` | undocumented | *No description published.* |
| `E1107` | undocumented | *No description published.* |

The specification permits these on **Subscriber List** only. For Subscriber Charging Info and User
Unsubscription it shows `S1000` in the example and enumerates nothing else. On any code other than
`S1000`:

- treat the request as failed (`S1001` excepted — see below),
- log `statusCode`, `statusDetail` and `requestId` — `statusDetail` is the platform's own
  explanation and the only one you will get,
- escalate to **support@digimart.store** with the `requestId`.

`S1001` is S-prefixed — the success family in Digimart's scheme — so on Subscriber List it is not
raised as an error: process whatever the page carries and log it.

## Reference implementation

Language-neutral:

```
# SDK: redirect and charging notification
SUCCESS        = { "S1000" }
CONFIGURATION  = { E1006, E1007, E1008, E1010, E1011 }          -> alert, integration down
USER_STATE     = { E1014, E2002, E3001..E3007, E3009, E4001 }    -> tell the subscriber
                 (E3008 is CLIENT: a malformed msisdn — yours if you sent it)
TRANSIENT      = { E1001, E1013, E2001, E2003, E2004 }           -> new flow, new requestId
CLIENT         = everything else beginning with E                -> your bug: fix what you built

# REST
success(call)  = get-subscribers: { S1000, S1001 }   otherwise: { S1000 }
failure        -> log statusCode + statusDetail + requestId, escalate
```

The same sets, built, are in every client under `templates/`.
