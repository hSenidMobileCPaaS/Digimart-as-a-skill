# Contributing

This skill is proprietary software owned by hSenid Mobile Solutions (Pvt) Ltd. See
[LICENSE](LICENSE).

**External pull requests and forks are not accepted.** The licence does not permit modifying or
redistributing the skill, so there is no contribution path that would be lawful to merge from
outside hSenid Mobile.

That does not mean feedback is unwelcome — it is the most valuable thing you can send.

## What to report

Open an issue. Accuracy reports are the highest-value contribution, because a wrong parameter name
in this skill becomes a wrong parameter name in someone's production integration.

- **The contract has changed** — a new parameter, a changed signing string, a field that is now
  always present in a notification. Include the documentation page or the observed request/response.
- **A status code** you have seen that is not in the tables, or a meaning for one of the REST codes
  (`S1001`, `E1100`–`E1107`) that Digimart has now published.
- **Bad guidance** — the skill led an agent to write incorrect, insecure or non-compliant code.
- **Agent support** — a platform that should load the skill but does not.
- **Newly published services** — only once Digimart publishes them.

Anything factual needs a source: a link to <https://digimart.store/docs>, or a real
request/response pair with credentials and subscriber identifiers redacted.

## Never include in an issue

- A real API Secret or App Password. If you have already pasted one anywhere, have it rotated
  first — see [SECURITY.md](SECURITY.md).
- A full signed URL from production, or a real subscriber's MSISDN or masked `subscriberId`. Use
  the published samples.
- Anything copied from a production log.

## For hSenid Mobile maintainers

The catalog is the source of truth. `catalog/digimart-api.json` drives the CLI, the integration
reference, the tests and much of the documentation. When the contract changes:

1. Edit `catalog/digimart-api.json`.
2. Run `node scripts/build-integration-reference.mjs` to regenerate
   `references/13-integration-reference.md`.
3. Update the matching `references/*.md` so prose and data agree.
4. Run `npm test` — the suite checks the catalog's integrity, the worked-example digests, that every
   referenced status code exists, that every sample validates against its own contract, that every
   flow, call, parameter and field appears in the integration reference, that the templates agree
   on variable names and signing, and that no credential-shaped string is committed.

`references/13-integration-reference.md` is generated and carries a banner saying so;
`--check` fails the build if it drifts. Never hand-edit it.

**Do not invent anything Digimart does not publish.** In practice:

- The surface is three signed-URL flows, three REST calls and three inbound surfaces. Anything else
  goes under `notPublished` in the catalog, with a sentence saying why — never into `services`.
- The OpenAPI file behind Digimart's docs carries SMS, USSD, OTP and CaaS tag descriptions with no
  paths. They are not Digimart APIs. Never fill them in from mSpace, Ideamart or Applink.
- The REST status codes other than `S1000` have no published meaning. Keep them `undocumented`
  until Digimart describes them.
- Where Digimart's sources disagree, add a `discrepancies` entry and say which reading the skill
  uses. Do not silently pick one.

The facts that must survive any refactor:

- **Signed URLs, not REST, for charging.** Nothing in the skill may describe the SDK flows as API
  calls with a request body.
- **`apiKey|requestTime|apiSecret`**, plus **`|amount`** for one-time only, SHA-512, lowercase hex.
- **Two hosts, two credentials.**
- **Fulfilment on the notification, never on the redirect.**

**This repo ships no code generator, and should not grow one.** The integration reference — shell
recipes for the signed URLs, curl for the REST calls — is the delivery mechanism in every language
equally; `references/10-any-stack.md` specifies the rest.

Agent rule files are generated from `AGENTS.md`:

```bash
node scripts/sync-rules.mjs          # regenerate
node scripts/sync-rules.mjs --check  # CI check
```

Templates are per-language ports of one specification. Adding a language means: a directory under
`templates/` with config, client and handlers; the same `DIGIMART_*` variable names; the
worked-example digest documented in the signer; a row in `templates/README.md`; and an entry in
`TEMPLATE_LANGUAGES` in `tests/packaging.test.js`, which enforces the rest.

Before pushing:

```bash
npm run check                  # both generated-file checks + all tests
bash -n scripts/*.sh           # shell scripts parse
node tools/digimart.mjs list   # CLI still works
```

Commits carry the human author only — no AI co-author trailers (see [CLAUDE.md](CLAUDE.md)).

### Style

- Write for someone integrating at 2am with a failing URL. Lead with what to do.
- State the consequence, not just the rule — "never fulfil on the redirect" lands because the next
  clause says anyone can type `?subscriptionStatus=S1000`.
- When Digimart's documentation is inconsistent, say so and record it.
- No invented endpoints, parameters or status codes.
