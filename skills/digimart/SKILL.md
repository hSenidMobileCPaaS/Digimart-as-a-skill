---
name: digimart
description: Build and integrate Digimart (hSenid Mobile's Bangladesh platform for charging Grameenphone subscribers' mobile balance) — the Subscription Charging SDK with and without header enrichment, the One-Time Charging SDK (CaaS), SHA-512 signed authorize URLs, the redirect return, subscription and charging notifications, and the REST APIs for subscriber list, charging info and unsubscription. Use whenever the user mentions Digimart, digimart.store, user.digimart.store, api.digimart.store, Grameenphone carrier billing in Bangladesh, caas-authorize, subscription/authorize, or header enrichment.
---

# Digimart

Digimart charges a **Grameenphone** customer's mobile balance in **Bangladesh** (BDT), run by
**hSenid Mobile Solutions**. Two products — subscriptions (`daily`/`monthly`) and one-time charges
(CaaS, 1–600 BDT) — and one mechanism:

**The charging services are signed URLs, not REST APIs.** Your server signs a URL with SHA-512 and
sends the customer's browser to it; Digimart renders every screen, redirects the browser back to
your `redirectUrl`, and POSTs the result to a notification URL on your server.

## The whole surface

| | What | Where | Reference |
|---|---|---|---|
| ⇢ | Subscription (`subscription`, `subscription-he`) | open `user.digimart.store/sdk/subscription/authorize` | `references/03-subscription-sdk.md` |
| ⇢ | One-time / CaaS (`one-time`) | open `user.digimart.store/sdk/subscription/caas-authorize` | `references/04-one-time-sdk.md` |
| → | Subscriber List, Charging Info, Unsubscription | `POST api.digimart.store/…` | `references/06-rest-apis.md` |
| ← | Charging + Subscription notifications, Redirect return | your URLs | `references/05-callbacks.md` |

Two hosts, two credentials: the SDK uses `apiKey` + a signature made with the **API Secret**; REST
uses `applicationId` + the **App Password** in the JSON body. Nothing else is published — no SMS,
USSD, OTP or balance API. Do not invent endpoints, and never borrow them from mSpace, Ideamart or
Applink.

## Do this first — query, do not recall

```bash
node tools/digimart.mjs list
node tools/digimart.mjs show <id>
node tools/digimart.mjs sign --example one-time        # known digest for your hashing test
node tools/digimart.mjs url <flow> [k=v …]             # signed URL + shell recipe
node tools/digimart.mjs check-url '<url>'              # check a URL your code built
node tools/digimart.mjs curl <rest-id> [k=v …]         # REST call as curl
node tools/digimart.mjs validate <id> '<json>'         # check a REST body or a notification
node tools/digimart.mjs code <statusCode>
node tools/digimart.mjs gaps                           # not published; where docs disagree
```

**`references/13-integration-reference.md` is where every call comes from** — each flow as a
signed-URL shell recipe, each REST call as curl, each inbound surface with a replay command.
Translate it into the host project's language; that is the integration.

## Eight rules that are never negotiable

1. **Sign on the server.** Clients call your start endpoint; they never hold the secret.
2. **Secrets from the environment** — never hardcoded, logged, in a URL or in a client bundle.
3. **Deliver on the notification, never the redirect.**
4. **`apiKey|requestTime|apiSecret`** (+ `|amount` for one-time) → SHA-512 → lowercase hex, with
   `requestTime` and `amount` byte-identical in the hash and the URL.
5. **Fresh 15-digit `requestId` per URL**, persisted before redirecting (`E1005` on reuse).
6. **Amount from your server's price list**, 1–600 BDT.
7. **A working cancel** via `POST /subs/unregistration`.
8. **No invented endpoints.**

## Build it in the project's own stack

SHA-512, a query-string encoder and an HTTPS client are in every standard library. Worked
implementations for TypeScript/Node, Python, Java, Go, PHP and C# are in `templates/`;
`references/10-any-stack.md` specifies the components for any other stack. Never add a runtime to
reach Digimart.

A to Z: `references/11-implementation-playbook.md`. Related skills: `digimart-scaffold`,
`digimart-callbacks`, `digimart-review`, `digimart-debug`, `digimart-golive`, `digimart-help`.
