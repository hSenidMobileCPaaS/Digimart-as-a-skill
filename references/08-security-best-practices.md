# Security and Best Practices

Digimart takes money from real people's phone balances. Two secrets stand between your users and
anyone who wants to charge them: the **API Secret**, which signs charging URLs, and the **App
Password**, which authenticates REST calls. Nearly everything on this page is about keeping those
two where they belong.

```bash
node tools/digimart.mjs practices            # every rule, by severity
node tools/digimart.mjs practices critical
```

## 1. Credentials

| Credential | Secret? | Where it may exist |
|---|---|---|
| API Key (`DIGIMART_API_KEY`) | No — it is in every URL | Server config. It is harmless alone, but keep it with the secret it pairs with. |
| **API Secret** (`DIGIMART_API_SECRET`) | **Yes** | Your server's secret store. Nowhere else — not a URL, not a client, not a log. |
| applicationId (`DIGIMART_APP_ID`) | No | Server config. It arrives on every notification. |
| **App Password** (`DIGIMART_PASSWORD`) | **Yes** | Your server's secret store. It arrives **by email** when the app is created: move it, then delete the mail. |

### Never hardcode

```
# ❌ in source, in a test fixture, in application.yml / appsettings.json / settings.py
apiSecret = "9f2c…"

# ❌ a "default" is a hardcoded secret with extra steps
secret = env("DIGIMART_API_SECRET") or "9f2c…"

# ❌ client-side, whatever the framework calls it
NEXT_PUBLIC_DIGIMART_API_SECRET / VITE_… / REACT_APP_… / PUBLIC_… / EXPO_PUBLIC_…

# ✅ environment variable, read by one config module, validated at startup, server-side only
```

### The rules

- One config module reads the environment. Nothing else does.
- Validate at startup and fail loudly if a secret is missing.
- `.env` is git-ignored; `.env.example` holds placeholders only.
- Production secrets live in the host's secret manager, not a `.env` file.
- Development and production use different applications and different credentials.
- Secret scanning runs in CI.

### If a secret leaks

Treat it as an active incident: anyone with the API Secret can build valid charging URLs for your
application; anyone with the App Password can list and unsubscribe your subscribers.

1. Contact **support@digimart.store** to have the credential rotated — before anything else.
2. Deploy the new value.
3. Review charges and subscriber changes since the leak.
4. Purge it from git history (`git filter-repo`), and treat anything pushed to a shared remote as
   permanently public regardless.

A secret is compromised the moment it lands in a commit, a chat message, a screenshot, a log
aggregator, a pasted stack trace or an AI prompt.

## 2. Sign on the server — always

The signature requires the API Secret. So:

- **Browsers, mobile apps, Flutter, React Native, desktop apps never build a Digimart URL.** They
  call *your* start endpoint, which builds and signs it and answers with a 302 or the URL.
- A mobile binary is not a secret store. Anything in it can be extracted.
- "Obfuscated" is not "server-side".

The start endpoint is also where the **amount** is decided (from your price list) and the
**requestId** allocated and persisted — none of which a client should control.

## 3. Never trust the way back

- **The redirect is forgeable.** Anyone can open
  `https://your-app.example/digimart/return?subscriptionStatus=S1000&requestId=…`. It must never
  grant access or deliver goods.
- **Notifications are unauthenticated.** Digimart publishes no signature, token or source-IP list.
  Verify `applicationId`, verify the `requestId` is one you issued and have not already settled,
  check `paidAmount` against the amount you asked for, and reconcile value-granting changes against
  the REST lookups (Charging Info, Subscriber List).
- **Deduplicate** every notification on its documented key.
- If you want defence in depth, give the notification routes an unguessable path segment and
  rate-limit them — but do not treat either as authentication.

## 4. TLS verification

Never disable it — for the REST calls or anything else:

```
rejectUnauthorized: false            NODE_TLS_REJECT_UNAUTHORIZED=0
verify=False                         InsecureSkipVerify: true
CURLOPT_SSL_VERIFYPEER => false      a trust-all TrustManager / certificate callback returning true
```

Disabling verification lets anyone on the network path read the App Password out of your REST
calls. If a host presents an incomplete certificate chain, supply the missing intermediate CA to the
client instead.

Your own notification URLs must be HTTPS with a complete chain, or Digimart may not be able to reach
them.

## 5. Subscriber data

- `subscriberId` is a **masked** number. Store it as given; do not try to decode it.
- Mask it in logs anyway (first and last few characters).
- `msisdn`, when you pass one, is a real phone number: do not log it.
- Subscriber List and Charging Info return bulk subscriber data. Do not export it to analytics or
  marketing tools, and define a retention period.
- The developer terms forbid approaching any customer directly without hSenid's written consent.

## 6. Consent and honesty

Digimart collects consent with its own OTP screens, and shows the price before the subscriber
commits. Your side of it:

- Show the price, in taka, **before** sending anyone into the flow — and for subscriptions, the
  frequency (`daily` or `monthly`).
- Never obscure what is being bought. A reviewer checks the description; a subscriber who feels
  tricked complains, and you must answer any complaint within 24 hours.
- **Cancellation must be obvious and must work.** It is a go-live condition.
- Send no unsolicited material.

## 7. Logging

| Log | Never log |
|---|---|
| `requestId`, `internalTrxId`, `statusCode`, `subscriptionStatus` | The API Secret, the App Password |
| The signing string **with the secret replaced by `***`** when debugging `E1002` | A full signed URL in a shared log (the signature is replayable until it expires) |
| A masked `subscriberId` | A raw `msisdn` |
| The notification's field names on first delivery | Full notification bodies into third-party tools |

## 8. Robustness

- An explicit timeout on every REST call.
- Retries with capped backoff on transport errors for the read-only calls; never an automatic
  loop that sends a subscriber back into a charging flow.
- A fresh `requestId` for every URL — a "retry" of a charge is a new order.
- An NTP-synced clock on every server that signs URLs.
- A scheduled reconciliation job over Subscriber List.
- Alerts on configuration-class codes (`E1006`, `E1007`, `E1008`, `E1010`, `E1011`): the
  integration is down, not one request.

## 9. Pre-commit hygiene

- `.env` in `.gitignore` before the first commit.
- A secret scanner (gitleaks, trufflehog, GitHub secret scanning) in CI.
- No real subscriber identifiers in fixtures — use the published samples.
