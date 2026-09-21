---
name: digimart-review
description: Review Digimart integration code for the mistakes that cost money, leak the API Secret or App Password, grant goods without payment, or block approval — client-side signing, wrong signing strings, fulfilment on the redirect, a missing cancel path, non-idempotent notification handlers. Use when asked to review, audit or check Digimart code, or before merging a pull request that touches it.
---

# Review a Digimart integration

Run `node tools/digimart.mjs practices` first, then check each item against the code. Report
findings with `file:line`, most severe first. No style opinions — only these.

## Critical — stop the merge

| Check | How it looks in code |
|---|---|
| Secret on a device | `DIGIMART_API_SECRET` or the signing code reachable from browser, mobile, Flutter or React Native code; a browser-exposed prefix (`NEXT_PUBLIC_`/`VITE_`/`REACT_APP_`/`PUBLIC_`/`EXPO_PUBLIC_`); a config endpoint that serves it |
| Hardcoded secrets | An API Secret or App Password literal in source, tests, fixtures, config files or git history |
| Fulfilment on the redirect | Access granted, goods delivered or an order marked paid in the `redirectUrl` handler |
| Amount from the client | The one-time `amount` read from the request instead of a server-side price list |
| Wrong signing string | Secret not in the middle; amount missing on one-time; amount signed on a subscription; spaces around pipes; SHA-256; uppercase hex; URL-encoded values hashed |
| Time or amount formatted twice | `requestTime` or `amount` produced separately for the hash and the URL |
| Notification settles without checks | No `statusCode == S1000`, no `applicationId` check, no `requestId` lookup, no `paidAmount` comparison |
| Disabled TLS verification | `rejectUnauthorized: false`, `verify=False`, `InsecureSkipVerify`, `CURLOPT_SSL_VERIFYPEER => false`, a trust-all `TrustManager` |

## High

- `requestId` not 15 digits, not persisted before the redirect, reused on retry, or derived from
  the millisecond clock alone.
- Dhaka wall-clock time written with a `Z`; a signed URL cached or built long before use.
- A notification handler doing work before answering 200, or answering non-200 on bad input.
- A notification handler with no dedupe key (`internalTrxId` + `statusCode`; `subscriberId` +
  `status` + `timeStamp`), or one that can deliver twice.
- Only one notification receiver when both can arrive.
- No stored `requestId` → `subscriberId` mapping, or the redirect's `subscriberId` treated as
  authoritative.
- **No cancel path**, or one that takes the `subscriberId` from the client.
- REST calls authenticated with the API Key and a signature instead of `applicationId` + App
  Password, or sent to `user.digimart.store`.
- REST success decided on the HTTP status; `destinationResponses[].statusCode` ignored on Charging
  Info.
- A meaning invented for `S1001` or `E1100`–`E1107`.
- A call to an SMS, USSD, OTP, balance or direct-debit endpoint on Digimart.
- Secrets, full signed URLs or raw MSISDNs in logs.

## Medium

- `subscriberId` sent without `tel:`, with `tel: ` (a space), as a string to Charging Info or as an
  array to Unsubscription; `requestPage` as a string; `action` as a number.
- `subscribers` on Subscriber List iterated without normalising to an array.
- `TEMPORARY_BLOCKED` or `REG_PENDING` treated as unsubscribed (deleted) rather than suspended.
- `E3001` treated as an error rather than "already subscribed".
- Raw status codes shown to customers; no dedicated `E3009` screen.
- Money in a binary float; a currency other than `BDT`.
- No explicit timeout on REST calls; no reconciliation job.
- No fixed-vector signing test.
- A new runtime or sidecar introduced purely to reach Digimart.

## Output

For each finding: the rule, the evidence, the specific fix. Finish with a plain verdict — is this
safe to put in front of real Grameenphone subscribers whose balance it will charge?
