---
name: digimart-golive
description: Run the Digimart pre-production checklist before submitting an application for approval or taking it live — application and approval, credentials, signing and the start endpoint, fulfilment and notifications, subscriptions and cancellation, customer experience, security, developer obligations and testing. Use before going live, or when asked whether a Digimart integration is production-ready.
---

# Digimart go-live check

```bash
node tools/digimart.mjs checklist          # the full list
node tools/digimart.mjs checklist --json   # machine-readable
```

Work through every item against the actual project and portal. For each, state **PASS**, **FAIL**
or **CANNOT VERIFY**, with evidence — a file path, a config value, a test run. Never mark PASS on an
assumption; here the cost of a wrong one lands on a real person's phone balance.

## The sections

1. **Application and approval** — a plain-words description of what the customer pays for; the
   CaaS API enabled with complete charging details; the SDK enabled; header enrichment deliberate;
   both notification URLs public HTTPS and live; a real redirect page; legal, appropriate content;
   authorisation for resold third-party services.
2. **Credentials** — API Secret and App Password only on the server and in a secret manager; no
   browser-exposed prefixes; startup validation; one variable per endpoint; separate dev and prod.
3. **Signing and the start endpoint** — server-side signing; a fixed-vector test on the worked
   example; the correct signing strings; one `requestTime` in UTC with `Z`; NTP; URLs built at
   redirect time; a fresh, persisted, collision-free 15-digit `requestId`; a server-side amount
   within 1–600 BDT.
4. **Fulfilment and notifications** — fulfil on the notification only; the redirect grants nothing;
   acknowledge first; dedupe keys; `applicationId` and `requestId` checks; `paidAmount` = amount
   and `balanceDue` = 0; decimal money; raw payloads retained; `test-callbacks.sh` passing
   including duplicates and a forged redirect.
5. **Subscriptions** — an obvious cancel that calls `/subs/unregistration` with the stored id;
   access ends on `UNREGISTERED`; `REG_PENDING` and `TEMPORARY_BLOCKED` suspend; `E3001` handled;
   nightly reconciliation; a `tel:` helper; per-entry status read on Charging Info.
6. **Customer experience** — the price (and frequency) before commitment, in taka; a friendly
   `E3009` screen; no raw codes; a support contact in the app; retries build a new URL.
7. **Security and operations** — TLS verification on; clean logs; alerts on `E1006`, `E1007`,
   `E1008`, `E1010`, `E1011`; timeouts; a named owner; a runbook.
8. **Obligations** — a 24-hour customer response; content rules; marketing approved by
   support@digimart.store; no hSenid logo, and the name only in standard non-bold font; Bangladesh
   regulations.
9. **Testing** — the digest test in CI; `check-url` on a real built URL; an end-to-end subscription
   and one-time charge in sandbox with an allowed number; failure paths (`E1002`, `E1005`,
   `E1329`/`E1330`, `E3009`, a closed tab); the REST smoke test from the production server.

## Verdict

Finish with the FAIL items ordered by risk, and a plain statement: is this safe to submit, and safe
to put in front of real Grameenphone subscribers?

Full list: `references/09-production-checklist.md`.
