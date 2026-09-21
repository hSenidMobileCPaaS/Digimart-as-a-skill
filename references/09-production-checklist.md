# Production Checklist

Work through every item against the actual project before submitting for approval and again before
going live. For each, record **PASS**, **FAIL** or **CANNOT VERIFY** with the evidence. Most
Digimart rejections are not technical — they are a vague description, an unreachable notification
URL, or an obligation nobody read.

Sources: <https://digimart.store/docs/go-live>, <https://digimart.store/docs/provision-app>,
<https://digimart.store/legal/terms>.

## Application and approval

- [ ] The app description explains, in plain words, exactly what a customer is paying for.
- [ ] The CaaS API is enabled on the application and the charging details are complete.
- [ ] The Subscription Charging SDK is enabled for the application (if subscriptions are sold).
- [ ] Header enrichment is enabled or not, deliberately — and the code handles the variant in use.
- [ ] The notification URL(s) are public, HTTPS, and already live — not placeholders.
- [ ] Both the Subscription Notification URL and the Async charging resp URL are set if both kinds of notification can arrive.
- [ ] The redirect URL points at a real page that handles both success and failure.
- [ ] Content is legal and appropriate, and nothing offends the values, culture or sentiments of Bangladesh.
- [ ] Documented authorisation exists for any third-party service you resell, and can be produced on request.

## Credentials and configuration

- [ ] The API Secret and the App Password exist only on the server — not in client code, a mobile binary, version control or a log.
- [ ] No browser-exposed prefix (`NEXT_PUBLIC_`, `VITE_`, `REACT_APP_`, `PUBLIC_`, `EXPO_PUBLIC_`) on any Digimart variable.
- [ ] Production secrets live in the host's secret manager; the App Password email has been deleted.
- [ ] One config module reads the environment and fails loudly at startup on a missing value.
- [ ] One endpoint variable per service; SDK and REST hosts are never shared through one base URL.
- [ ] Development and production use different applications and credentials.
- [ ] Secret scanning runs in CI.

## Signing and the start endpoint

- [ ] URLs are built and signed on the server, in an endpoint clients call.
- [ ] A fixed-vector test reproduces Digimart's worked-example digest.
- [ ] Subscriptions sign `apiKey|requestTime|apiSecret`; one-time charges sign `apiKey|requestTime|apiSecret|amount`.
- [ ] `requestTime` is the current UTC instant with a `Z`, formatted once and used in both the hash and the URL.
- [ ] Server clocks are synchronised with NTP.
- [ ] Signed URLs are built at the moment of redirect, never cached.
- [ ] Signatures are lowercase hex SHA-512 over the raw (not URL-encoded) values.
- [ ] Every URL gets a fresh, unique 15-digit `requestId`, persisted against the order or user before redirecting.
- [ ] `requestId` generation cannot collide under concurrency (not the millisecond clock alone).
- [ ] The one-time amount comes from a server-side price list, never from client input.
- [ ] The one-time amount is within 1–600 BDT, and is the identical string in the hash and the URL.

## Fulfilment and notifications

- [ ] Fulfilment is driven by the notification, never by the browser redirect.
- [ ] The redirect page grants nothing, looks the `requestId` up, and shows a screen per outcome.
- [ ] Notification handlers answer HTTP 200 immediately and process out of band.
- [ ] Notification handlers are idempotent: a replayed notification cannot grant access or count revenue twice.
- [ ] The charging handler deduplicates on `internalTrxId` + `statusCode`; the subscription handler on `subscriberId` + `status` + `timeStamp`.
- [ ] Handlers check `applicationId` and that the `requestId` is one you issued.
- [ ] A charge settles only when `statusCode` is `S1000`, `paidAmount` equals the amount asked, and `balanceDue` is `0`.
- [ ] Amounts are parsed into a decimal type, accepting both string and number forms.
- [ ] The `requestId` → `subscriberId` mapping is stored, confirmed from the notification.
- [ ] Raw notification payloads are logged (identifiers masked) and retained for reconciliation.
- [ ] Handlers were exercised with `scripts/test-callbacks.sh`, including the duplicate and forged-redirect cases.

## Subscriptions

- [ ] Cancelling is obvious in the product and works: it calls `POST /subs/unregistration` from the server.
- [ ] The cancel endpoint takes the `subscriberId` from your own store, never from the client.
- [ ] Access ends immediately on `UNREGISTERED`, without waiting for a notification.
- [ ] `REG_PENDING` and `TEMPORARY_BLOCKED` suspend access without deleting the subscriber.
- [ ] `E3001` (already registered) is handled as "already subscribed".
- [ ] A scheduled job pages `POST /subscription-info-server/getSubscribers` to reconcile missed notifications.
- [ ] REST calls send `subscriberId` as `tel:<masked value>` through one helper, with no space after the colon.
- [ ] Charging Info reads every `destinationResponses[].statusCode`, not just the top level.

## Customer experience

- [ ] The price is shown before the customer commits, in taka (and the frequency, for a subscription).
- [ ] Insufficient balance (`E3009`) has its own friendly screen with a retry option — your most common failure.
- [ ] No raw error code is ever displayed to a customer.
- [ ] A support contact is visible inside the app.
- [ ] A retry after a failure builds a new URL with a new `requestId`.

## Security and operations

- [ ] TLS verification is on everywhere; no trust-all client exists outside a gated development path.
- [ ] Logs carry `requestId`, `internalTrxId` and `statusCode`, and never a secret, a full signed URL or a raw MSISDN.
- [ ] Configuration-class codes (`E1006`, `E1007`, `E1008`, `E1010`, `E1011`) raise an alert.
- [ ] REST calls have explicit timeouts and backoff on transport errors.
- [ ] A named owner can log in to the portal and get credentials rotated.
- [ ] A runbook covers: signature failures, missing notifications, a leaked secret, and a disputed charge.

## Obligations

- [ ] You can respond to any customer query or claim within 24 hours — a binding term, not an aspiration.
- [ ] Your content does not breach the prohibited-content rules in the developer terms.
- [ ] Marketing material has been sent to support@digimart.store for approval before publication.
- [ ] You are not using the hSenid logo, and use the hSenid name only in standard, non-bold font.
- [ ] You comply with Bangladesh government regulations and the telecommunication authority's rules.

## Testing

- [ ] The worked-example digest test passes in CI.
- [ ] `node tools/digimart.mjs check-url` passes on a URL your code built, with the secret exported.
- [ ] A subscription and a one-time charge completed end to end in sandbox with an allowed test number.
- [ ] Failure paths were exercised: wrong signature (`E1002`), reused `requestId` (`E1005`), amount out of band (`E1329`/`E1330`), insufficient balance (`E3009`), a closed tab (no redirect, notification only).
- [ ] The REST calls were run with `scripts/smoke-test.sh` from the production server.

## Before going live

- [ ] Every FAIL above is fixed or has a written, accepted reason.
- [ ] Chase the review, if needed, at support@digimart.store.

## Common failure signatures

| Symptom | Almost always |
|---|---|
| Every URL returns `E1002` | Field order, amount missing from a one-time hash, time formatted twice, uppercase hex, SHA-256 |
| One-time fails, subscription works | The amount is not in the signing string |
| `E1005` under load | `requestId` from the millisecond clock |
| `E1004` | Clock drift, or a URL built long before it was opened |
| Customers pay but get nothing | The notification URL is wrong or unreachable, or fulfilment waits on the redirect |
| Customers get things without paying | Fulfilment on the redirect |
| Subscription state drifts | No reconciliation job; `TEMPORARY_BLOCKED` ignored |
| Cancel button does nothing | It never calls `/subs/unregistration`, or sends the id without `tel:` |
