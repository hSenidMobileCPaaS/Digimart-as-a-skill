## What changed

<!-- One or two sentences -->

## Source

<!-- For any factual change: link the https://digimart.store/docs page, or paste the observed
     request/response, redirect URL or notification with secrets and subscriber identifiers redacted. -->

## Checklist

- [ ] `npm test` passes
- [ ] `node scripts/sync-rules.mjs --check` passes (edited `AGENTS.md`, not a generated copy)
- [ ] `node scripts/build-integration-reference.mjs --check` passes
- [ ] `catalog/digimart-api.json` and the matching `references/*.md` agree
- [ ] Nothing invented that Digimart does not publish; disagreements recorded under `discrepancies`
- [ ] No real credentials, signed URLs or subscriber identifiers, nothing from a production log
