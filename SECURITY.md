# Security Policy

## This repository contains no secrets

Every credential in this repo is a placeholder. `templates/.env.example` holds only `APP_XXXXXX`
and `replace-me`. CI fails the build if a credential-shaped value is committed. The only signing
values in the repo are Digimart's own published worked example (`myApiKey123` /
`mySecretKey456`), which are not real credentials.

If you believe a real credential has been committed here, **do not open a public issue**. Contact
the maintainers privately, and have the credential rotated first — rotation matters more than
disclosure timing.

## If you leak your own Digimart credentials

There are two secrets, and each is dangerous in its own way:

| Secret | What someone can do with it |
|---|---|
| **API Secret** | Build validly signed charging URLs for your application — at any amount in the band — and send your customers to them. |
| **App Password** | Call the REST APIs as you: list your subscribers, look them up, and unsubscribe them. |

Treat exposure as an active incident:

1. **Contact support@digimart.store to have the credential rotated.** Do this before anything else.
2. Deploy the new value.
3. Review charges and subscriber changes since the leak.
4. Purge it from git history with `git filter-repo` — and treat anything pushed to a shared remote
   as permanently public regardless.

A secret is compromised the moment it lands anywhere shared: a commit, a chat message, a
screenshot, a log aggregator, a pasted stack trace, a mobile app binary, a browser bundle, or an AI
prompt.

The App Password is delivered **by email** when the application is created. An inbox is not a
secret store: move it into your secret manager and delete the mail.

## Reporting a problem with this skill

Open an issue for anything that would lead an agent to write insecure code — a missing warning,
guidance that encourages client-side signing or hardcoding, a template that fulfils on the
redirect, a dangerous default.

Report privately instead if the issue is directly exploitable, for example a template that leaks
credentials or a script that transmits them somewhere.

## Scope

This skill is documentation, reference templates, and an offline CLI. It:

- makes **no network calls** — `tools/digimart.mjs` reads a local JSON file and nothing else
- **never prints a credential** — REST request builders emit `$DIGIMART_APP_ID` /
  `$DIGIMART_PASSWORD` placeholders, and signed-URL builders emit `$SIGNATURE` unless a secret is
  available
- reads `DIGIMART_API_SECRET` from the environment in exactly three commands — `sign`, `url` and
  `check-url` — to compute a SHA-512 locally, and only if it is set; it refuses the secret as a
  command-line argument, where it would land in shell history
- has **no runtime dependencies**

`scripts/smoke-test.*` does call Digimart, deliberately, using credentials from your environment.
Read it before running it: `--with-unsubscribe` really unsubscribes the test subscriber, and
`--print-url` prints signed URLs that charge real money if someone completes them.

## Maintenance and licence

Owned and maintained by hSenid Mobile Solutions (Pvt) Ltd. The skill is proprietary and licensed
for use only — see [LICENSE](LICENSE).

The platform evolves, so verify anything security- or billing-critical against
<https://digimart.store/docs> before going live.
