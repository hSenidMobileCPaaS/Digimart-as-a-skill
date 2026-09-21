---
name: digimart-debug
description: Diagnose a failing Digimart integration from a status code or a symptom — E1002 invalid signature, E1005 duplicate requestId, E1003/E1004 time problems, E1011 SDK not enabled, E3009 balance, one-time charges failing while subscriptions work, notifications never arriving, customers paying but getting nothing, undocumented REST codes. Use when a Digimart URL, notification or REST call is not behaving.
---

# Debug a Digimart integration

Start with the tool. Every Digimart bug lives in one of four places — the URL you built, what came
back on the redirect, the notification, or a REST body — and there is a command for each:

```bash
node tools/digimart.mjs check-url '<the URL your code built>'     # signing, params, band, time
node tools/digimart.mjs redirect '<the URL the browser landed on>'
node tools/digimart.mjs validate charging-notification '<the body you received>'
node tools/digimart.mjs response get-subscribers '<the REST body you got>'
node tools/digimart.mjs code E1002
node tools/digimart.mjs diagnose "one-time charge fails but subscription works"
```

Inputs accept `@file` or `-` (stdin).

## Signature problems first

`E1002` is the most reported problem. In order:

1. `node tools/digimart.mjs sign --example one-time` — does your code produce `3badf638…901b38`
   from `myApiKey123|2024-08-08T12:00:00Z|mySecretKey456|50`? If not, the hashing itself is wrong
   (SHA-512? UTF-8? lowercase hex?).
2. Export `DIGIMART_API_SECRET` and run `check-url` on a URL your code actually built. It recomputes
   the signature and names the common mistakes: amount missing on one-time, amount signed on a
   subscription, secret and time swapped.
3. Print the signing string with the secret redacted: two pipes for a subscription, three for
   one-time, no spaces, the same `requestTime` and `amount` as the URL.

## Failure signatures

| Symptom | Almost always |
|---|---|
| Every URL → `E1002` | Field order (secret in the middle), SHA-256, uppercase hex, spaces, URL-encoded values hashed, time formatted twice |
| One-time → `E1002`, subscription works | The amount is missing from the signing string |
| `E1005` | `requestId` reused on retry, or millisecond-clock ids colliding |
| `E1003` | `requestTime` not `YYYY-MM-DDTHH:mm:ss.sssZ` |
| `E1004` | Clock drift, Dhaka wall-clock written with `Z` (six hours), or a URL built long before use |
| `E1006` / `E1007` | Wrong key, a key from another app or environment, app not approved |
| `E1008` / `E1011` | CaaS API or Subscription SDK not enabled on the app — portal, not code |
| `E1329` / `E1330` | Amount outside 1–600 BDT |
| `E3005` | Sandbox — the number is not allowed yet |
| `E3009` | The customer has no balance. Not a bug; the most common failure. |
| `E3001` | Already subscribed — check Charging Info before opting in |
| Customers pay, get nothing | Notification URL wrong, unreachable or behind auth; handler not answering 200; only one of the two receivers built; fulfilment waiting on the redirect |
| Customers get things without paying | Fulfilment on the redirect |
| The redirect "has no status" | Expecting JSON or `CHARGED`; it is query parameters with a code |
| Cancel does nothing | Not calling `/subs/unregistration`; `subscriberId` without `tel:`; REST sent to the SDK host; the API Key used instead of the App Password |
| REST `E1100`–`E1107` | No published meaning — log `statusDetail` and `requestId`, escalate |
| Certificate errors | Incomplete chain — supply the intermediate CA; never disable verification |

## Narrowing it down

1. **URL, redirect, notification or REST?** They fail differently, and only the notification is
   authoritative for money.
2. **Every request or one?** Every request → configuration (`E1006`–`E1011`) or signing. One → that
   request's values.
3. **Take the code out of it.** Build the same URL with `node tools/digimart.mjs url …` or the shell
   recipe in `references/13-integration-reference.md`, and the REST call with `curl`. If that works,
   the bug is in your code.
4. **The inbound half:** `./scripts/test-callbacks.sh http://localhost:3000` — valid, duplicate,
   malformed and forged cases.

## Escalating

support@digimart.store · +8801764987009. Quote the `requestId`, the `internalTrxId` for a charge,
the status code and `statusDetail`. Details: `references/07-status-codes.md`,
`references/12-source-discrepancies.md`.
