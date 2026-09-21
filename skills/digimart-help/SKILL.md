---
name: digimart-help
description: Quick reference for the Digimart skill — available commands, the flows and APIs covered, what Digimart does not publish, and which reference document covers what. Use when the user asks what the Digimart skill can do or how to use it.
---

# Digimart skill — quick reference

## Tooling

```bash
node tools/digimart.mjs help       # every command
node tools/digimart.mjs list       # 3 flows, 3 REST calls, 3 inbound
node tools/digimart.mjs platform   # hosts, credentials, the endpoints you build
```

Offline and zero-dependency. `sign`, `url` and `check-url` read `DIGIMART_API_SECRET` from the
environment if it is set, to hash locally, and never print it; nothing else touches a credential.
`--json` on any command.

| Command | Answers |
|---|---|
| `list` / `show <id>` / `search "<q>"` | What exists, and exactly what does it take and return? |
| `platform` | Hosts, credentials, the endpoints I must build |
| `gaps` | What Digimart does **not** publish, and where its docs disagree |
| `sign --example [flow]` | The known digest to test my hashing against |
| `sign <flow> k=v …` | The signing string and signature for my values |
| `url <flow> k=v …` | A complete signed authorize URL, plus the shell recipe |
| `check-url '<url>'` | Is the URL my code built right? (recomputes the signature with the secret) |
| `redirect '<url>'` | What did the redirect return mean? |
| `curl <id> k=v …` | A REST call as runnable curl |
| `validate <id> '<json>'` | Is this REST body or notification payload right? |
| `response <id> '<json>'` | What does this REST response mean? |
| `code <CODE>` / `diagnose "<symptom>"` | What went wrong, and the fix |
| `practices` / `checklist` / `reference <doc>` | Rules, the go-live list, full guides |

## Skills

| Skill | Use it for |
|---|---|
| `digimart` | General work; the rules and the surface |
| `digimart-scaffold` | Starting a new integration |
| `digimart-callbacks` | The redirect page and both notifications |
| `digimart-review` | Auditing existing code |
| `digimart-debug` | A failing URL, notification or REST call |
| `digimart-golive` | The pre-production checklist |

## What Digimart publishes

| | Covered here |
|---|---|
| **Subscription Charging SDK** | Signed URL on `/sdk/subscription/authorize`, with and without header enrichment |
| **One-Time Charging SDK (CaaS)** | Signed URL on `/sdk/subscription/caas-authorize`, amount signed, 1–600 BDT |
| **REST** | Subscriber List, Subscriber Charging Info, User Unsubscription |
| **Inbound** | Charging notification, subscription notification, the redirect return |
| **Codes** | All 31 SDK error codes; the 9 REST codes (only `S1000` described) |

**Not published — do not invent:** SMS, USSD, OTP, balance query, direct debit, server-to-server
charging, subscribing by REST, refunds, notification signatures, a separate sandbox host.

## References

`01-getting-started` · `02-signatures` · `03-subscription-sdk` · `04-one-time-sdk` ·
`05-callbacks` · `06-rest-apis` · `07-status-codes` · `08-security-best-practices` ·
`09-production-checklist` · `10-any-stack` · `11-implementation-playbook` ·
`12-source-discrepancies` · `13-integration-reference`

## Languages

Any. SHA-512, a query-string encoder and an HTTPS client are in every standard library.
`references/13-integration-reference.md` has every flow and call at the wire; `templates/` has
worked implementations in TypeScript/Node, Python, Java, Go, PHP and C#; and
`references/10-any-stack.md` specifies the components for everything else.

## The things to remember

1. **Signed URLs, not REST** — the browser opens them; your server signs them.
2. **`apiKey|requestTime|apiSecret`** (+ `|amount` for one-time), SHA-512, lowercase hex.
3. **Deliver on the notification**, never the redirect.
4. **A fresh 15-digit `requestId`** per URL, persisted first.
5. **Two hosts, two credentials** — SDK: API Key + Secret; REST: applicationId + App Password.
6. **A working cancel** via `/subs/unregistration`.

Docs: <https://digimart.store/docs> · Support: support@digimart.store
