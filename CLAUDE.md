# Project rules

## Commit attribution

**Never add a `Co-Authored-By` trailer naming Claude, Anthropic, or any AI assistant to a
commit** — not in this repository, not in any branch of it, and not in a pull request body.
Commits carry the human author only. If such a trailer is already present in a commit that has
not been shared, amend it out before pushing.

## Nothing invented

Every endpoint, parameter, field and status code in this repository comes from Digimart's
published documentation (<https://digimart.store/docs>). If something is not published, record it
as not published (`catalog/digimart-api.json` → `notPublished`) rather than borrowing it from
mSpace, Ideamart or Applink. Where Digimart's sources disagree, record the disagreement in
`discrepancies` and say which reading the skill uses.

## Generated files

`AGENTS.md` is the source for the seven agent rule copies (`node scripts/sync-rules.mjs`), and
`catalog/digimart-api.json` is the source for `references/13-integration-reference.md`
(`node scripts/build-integration-reference.mjs`). Edit the sources, regenerate, and run `npm run check`.
