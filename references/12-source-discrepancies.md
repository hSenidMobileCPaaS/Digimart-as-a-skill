# What Digimart Publishes — and What It Does Not

This skill contains nothing Digimart has not published. This page is the record of the edges: the
things an agent is tempted to assume exist, and the places where Digimart's own sources disagree
with each other, with the reading this skill uses for each.

```bash
node tools/digimart.mjs gaps
```

## Sources

- **Digimart developer documentation** — <https://digimart.store/docs>. The authoritative source: what Digimart is, provisioning, the three signed-URL charging flows, signatures, the REST APIs, SDK error codes and the go-live checklist.
- **Digimart REST API specification (OpenAPI 3.0, rendered with Redoc)** — <https://digimart.store/API_Documentation/docs/digimart_API.html>. The four REST operations under the 'subscription' tag group, their schemas and the permitted subscriber-list status codes. Transcribed from an archived copy; the live URL now redirects into https://digimart.store/docs/rest-api, which carries the same contract.
- **Digimart pricing** — <https://digimart.store/pricing>. The one-time charging band (1 to 600 BDT) and the revenue-share model.
- **Digimart developer terms** — <https://digimart.store/legal/terms>. Developer obligations: 24-hour customer response, content rules, marketing rules, third-party authorisation.

The original tutorial pages (`digimart.store/tutorials/chargingSDKDisabled.php`,
`chargingSDKEnabled.php`, `oneTimeChargingSDK.php`) and the Redoc page at
`digimart.store/API_Documentation/docs/digimart_API.html` now return 404. The documentation at
<https://digimart.store/docs> carries the same contract and is the source of truth; the REST
schemas here were checked against an archived copy of the OpenAPI file.

## The complete published surface

| Kind | Items |
|---|---|
| Signed-URL charging flows | `subscription` (`/sdk/subscription/authorize`), `subscription-he` (`/sdk/subscription/authorize`), `one-time` (`/sdk/subscription/caas-authorize`) |
| REST calls you make | `get-subscribers` (`POST /subscription-info-server/getSubscribers`), `subscriber-charging-info` (`POST /subscription/getSubscriberChargingInfo`), `unregistration` (`POST /subs/unregistration`) |
| Inbound | `subscription-notification`, `charging-notification`, `redirect-return` |
| SDK error codes | 31, with descriptions |
| REST status codes | 9 permitted on the subscriber list; only `S1000` described |

Anything else is not a Digimart API.

## Not published — do not invent these

| | |
|---|---|
| **SMS, USSD, OTP request/verify, caas/queryBalance and caas/directDebit REST operations** | The OpenAPI file behind Digimart's API documentation carries tag descriptions for sms/send, sms/receive, sms/report, ussd/send, ussd/receive, caas/queryBalance, caas/directDebit, otp/request and otp/verify — but no paths, no schemas, and they are not in the rendered tag group. They are leftovers from the platform the document was derived from, not Digimart APIs. Do not call them, and never borrow their paths or payloads from mSpace, Ideamart or Applink. |
| **A server-to-server charge** | There is no REST call that charges a subscriber. Every charge goes through a signed SDK URL, where the subscriber confirms with an OTP. |
| **Subscribing a user by REST** | Registration happens only through the Subscription Charging SDK. The REST surface can list, look up and unsubscribe. |
| **Refunds or reversals** | No API is published. Handle disputes through support@digimart.store. |
| **Authentication of notifications** | Digimart publishes no signature, token or source-IP list for its notifications. Verify applicationId and the requestId against your own records, and reconcile with the REST lookups. |
| **Notification response body and retry policy** | No response body is published, and neither is whether or how often Digimart redelivers. Answer 200 fast, be idempotent, and reconcile with Subscriber List. |
| **A separate sandbox host** | Sandbox is an application state in the same portal (free, 'practice mode'); no separate sandbox base URL is published. E3005 ('not whitelisted') is the documented symptom of testing with a number that is not allowed yet. |
| **Descriptions for the REST status codes** | The specification permits S1001, E1100 and E1102 to E1107 on the subscriber list but describes none of them. Their statusDetail is the only explanation available; do not borrow meanings from another platform. |
| **Per-renewal notifications for subscriptions** | Not documented. Use Subscriber Charging Info (lastChargedDate, lastChargedAmount) and Subscriber List to know when a subscriber was last charged. |
| **Official SDK libraries or code samples for the REST APIs** | The specification's x-code-samples for Java, PHP, JavaScript and .NET all read 'coming soon'. Every call is a plain HTTPS request, so none is needed. |

### Why the SMS/USSD/OTP/CaaS tags matter

The OpenAPI document behind Digimart's API documentation was derived from another hSenid
platform's. It still carries **tag descriptions** for `sms/send`, `sms/receive`, `sms/report`,
`ussd/send`, `ussd/receive`, `caas/queryBalance`, `caas/directDebit`, `otp/request` and
`otp/verify` — one of them even says *"mSpace will generate and send an OTP"*. None has a path or a
schema, none is in the rendered `subscription` tag group, and none appears in Digimart's
documentation. An agent that has seen mSpace, Ideamart or Applink will be tempted to fill them in.
**Don't.** On Digimart the OTP is sent by Digimart inside the SDK flow, and charging happens only
through the signed URL.

## Where the published sources disagree

Recorded rather than smoothed over. Each resolution is what the catalog, the tools and the
templates use.

| # | Where | The disagreement | This skill uses |
|---|---|---|---|
| 1 | Subscription SDK (original tutorial prose) | Prose said SHA 256; the parameter table and worked example say SHA-512. | SHA-512. The live documentation uses SHA-512 throughout. |
| 2 | Subscription SDK (original tutorial prose) | Prose gave requestTime as 20240227113053; the table and every sample URL use 2024-07-08T10:33:54.929Z. | ISO 8601 UTC with milliseconds and Z. |
| 3 | Subscription with HE, and one-time (original tutorial prose) | Prose ordered the signing string apiKey|apiSecret|requestTime; the worked example gives apiKey|requestTime|apiSecret. | apiKey|requestTime|apiSecret(|amount), as the worked example and the live documentation state. A wrong order hashes cleanly and fails every time with E1002. |
| 4 | Subscription with HE, and one-time (original tutorials) | A sample URL pointed at dev.sdp.hsenidmobile.com, and the one-time page's first sample used the subscription path. | user.digimart.store, with /sdk/subscription/caas-authorize for one-time. |
| 5 | Subscription SDK sample notification | The sample put the application ID under a key equal to the requestId instead of applicationId. | applicationId, per the REST specification. Tolerate its absence; do not crash. |
| 6 | Subscription with HE | Lists a required amount parameter for a subscription, which the non-HE flow does not, and does not sign it. | Recorded as published. Confirm its effect with support before relying on it. |
| 7 | One-time SDK | The SDK page's error codes refer to amounts too high/low without restating the band. | 1 to 600 BDT, from the pricing page. |
| 8 | https://digimart.store/docs/quickstart step 5 | Shows the redirect outcome as a JSON object with subscriptionStatus "CHARGED" and a separate statusCode. | The flow references and samples show query parameters on a browser redirect, where subscriptionStatus carries a status code such as S1000. Parse query parameters; do not expect JSON or CHARGED. |
| 9 | https://digimart.store/docs/signatures, rules table | Says a clock drifting outside the accepted window can return E1011. | E1011 is 'SDK Is Not Enabled For This Application'. A bad or stale requestTime maps to E1003 (Invalid Time Format) or E1004 (Request Timeout). |
| 10 | All SDK flows | requestTime is described as 'UTC format' and also 'generated in the Asia/Dhaka timezone'. | Every published code sample produces the true current UTC instant with a Z suffix. Do that; keep the clock NTP-synced. |
| 11 | REST examples | The lookup APIs' examples write "tel: 8801740812854" with a space; the unsubscription specification writes tel:8801740812854. | Send tel: with no space. Accept either form when reading responses. |
| 12 | POST /subscription-info-server/getSubscribers | subscribers is typed as a single object in the specification and shown as an array in the example. | Normalise to an array. |
| 13 | Subscriber List and Charging Info | lastChargedDate is documented as YYYY-MM-DD hh:mm:ss; the example is 2020-01-23 22.03.22. | Parse both separators; store the raw string alongside. |
| 14 | POST /subscription/getSubscriberChargingInfo | The request subscriberId is typed string but exampled as an array; the response lists subscriptionStatus as required at the top level but defines it only per destination. | Send an array. Read subscriptionStatus from each destinationResponses entry. |
| 15 | POST /subs/unregistration | The response schema's requestId example is 'not registered' and its subscriptionStatus example is 'UNREGISTERED.' with a trailing period; action's enum is the number 0 while its example is the string "0". | Send action as the string "0". Compare subscriptionStatus after trimming punctuation and whitespace. |
| 16 | OpenAPI file | Tag descriptions exist for sms, ussd, otp and caas operations that have no paths. | Not Digimart APIs. See notPublished. |
| 17 | digimart.store/tutorials/*.php and /API_Documentation | The original tutorial pages and the Redoc page now return 404. | https://digimart.store/docs is the source of truth; it carries the same contract. |

Numbers 3 (signing order) and 10 (Dhaka vs UTC) are the two that cost a day. When in doubt, hash
the worked example and compare digests before blaming your own code.

## Reporting a change

If Digimart's behaviour differs from this page — a field that is always present, a code that
appears, a notification shape — open an *API correction* issue with a redacted request/response, or
tell support@digimart.store. Do not "fix" it locally by guessing.
