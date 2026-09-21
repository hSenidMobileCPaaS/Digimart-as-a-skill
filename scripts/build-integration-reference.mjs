#!/usr/bin/env node
/**
 * Generate references/13-integration-reference.md from catalog/digimart-api.json.
 *
 *   node scripts/build-integration-reference.mjs           write the document
 *   node scripts/build-integration-reference.mjs --check   fail if it is stale (used in CI)
 *
 * This page is how the skill hands over an implementation in any language:
 * every signed-URL flow as a shell recipe (POSIX shell + openssl), every REST
 * call as a runnable curl, and every inbound surface with a command that
 * replays it against your own handler. There is no code generator — a recipe
 * and the host project's own HTTP client and hash function cover every language
 * equally.
 *
 * It is generated for the same reason the agent rule copies are: a parameter
 * that drifts from the catalog becomes a wrong parameter in someone's
 * production integration.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  buildAuthorizeUrl,
  buildPayload,
  catalog,
  lookupStatusCode,
  repoRoot,
  successCodesFor,
  toCurl,
  toShellRecipe,
  urlFor,
} from "../tools/catalog.mjs";

const OUT = join(repoRoot, "references", "13-integration-reference.md");
const check = process.argv.includes("--check");

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/** Safe inside a table cell: escape pipes, and angle brackets GitHub would read as HTML. */
const md = (s) =>
  String(s).replace(/\|/g, "\\|").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const anchor = (heading) =>
  heading
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9 -]/g, "")
    .trim()
    .replace(/\s+/g, "-");
const json = (value) => "```json\n" + JSON.stringify(value, null, 2) + "\n```";
const ref = (path) => `[${path.replace("references/", "")}](${path.replace("references/", "")})`;
const flows = catalog.sdkFlows.map((f) => ({ ...f, kind: "sdk-flow" }));
const services = catalog.services.map((s) => ({ ...s, kind: "service" }));
const callbacks = catalog.callbacks.map((c) => ({ ...c, kind: "callback" }));

function parameterTable(spec, { label = "Parameter", required = "Required", showSigned = false } = {}) {
  const head = showSigned
    ? [`| ${label} | Type | | Signed | Definition |`, `|---|---|---|---|---|`]
    : [`| ${label} | Type | | Definition |`, `|---|---|---|---|`];
  const rows = spec.map((p) => {
    const type = p.enum ? "enum" : md(p.type);
    const values = p.enum ? ` One of \`${p.enum.join("`, `")}\`.` : "";
    const fresh = p.perRequest ? ` **${md(p.perRequest)}**` : "";
    const note = p.note ? ` *${md(p.note)}*` : "";
    const example = p.example !== undefined ? ` Example: \`${md(p.example)}\`.` : "";
    const need = p.required ? `**${required}**` : "Optional";
    const signed = showSigned ? ` ${p.signed ? "**yes**" : "—"} |` : "";
    return `| \`${p.name}\` | ${type} | ${need} |${signed} ${md(p.description)}${md(values)}${example}${fresh}${note} |`;
  });
  return [...head, ...rows].join("\n");
}

function responseTable(fields) {
  const rows = [];
  for (const f of fields) {
    rows.push(`| \`${f.name}\` | ${md(f.type)} | ${md(f.description)} |`);
    for (const n of f.fields || []) rows.push(`| \`${f.name}[].${n.name}\` | ${md(n.type)} | ${md(n.description)} |`);
  }
  return [`| Field | Type | Meaning |`, `|---|---|---|`, ...rows].join("\n");
}

function statusTable(codes, entryId) {
  const rows = codes.map((code) => {
    const s = lookupStatusCode(code);
    const fix = catalog.statusCodes[s.code]?.fix ? ` → ${md(catalog.statusCodes[s.code].fix)}` : "";
    const benign = s.benignFor?.includes(entryId) ? " **Accepted as a success for this call.**" : "";
    return `| \`${s.code}\` | ${s.class} | ${md(s.description)}${fix}${benign} |`;
  });
  return [`| Code | Class | Meaning |`, `|---|---|---|`, ...rows].join("\n");
}

const CLASS_LEGEND =
  "`success` proceed · `undocumented-success` S-prefixed with no published meaning — do not raise an error · " +
  "`configuration` fix the application in the portal, not the code · `client` fix what you built · " +
  "`user-state` tell the subscriber what to do; do not loop · `transient` start again / back off · " +
  "`undocumented` permitted with no published meaning — log statusDetail and escalate. " +
  "Full table: [07-status-codes.md](07-status-codes.md).";

/* ── Document ────────────────────────────────────────────────────────────── */

const envLines = [
  ...new Map(
    [...flows, ...services].map((e) => [e.envVar, `export ${e.envVar}='${urlFor(e)}'`])
  ).values(),
];

const preamble = `<!-- Generated from catalog/digimart-api.json by scripts/build-integration-reference.mjs. Do not edit directly. -->

# Every Flow, Call and Callback at the Wire

The whole Digimart contract with nothing between you and the platform: each signed-URL flow as a
recipe you can run in a shell, each REST call as a runnable curl, each thing Digimart sends back
with a command that replays it against your own handler — and every parameter and field defined.

**Write the integration from this page, in whatever language the project already uses.** Signing
is one SHA-512 over a pipe-joined string, the URL is an ordinary query string, and the REST calls
are ordinary JSON POSTs, so every language has everything it needs in its standard library —
\`hashlib\` and \`urllib\` in Python, \`MessageDigest\` and \`HttpClient\` in Java, \`crypto/sha512\` and
\`net/http\` in Go, \`hash('sha512', …)\` and cURL in PHP, \`SHA512\` and \`HttpClient\` in .NET,
\`Digest::SHA512\` in Ruby, \`sha2\` + \`reqwest\` in Rust, \`node:crypto\` and \`fetch\` in Node. Translate
the recipe into the project's own idiom; keep everything else exactly as specified.

---

## Two surfaces, two hosts, two credentials

| | Charging SDK flows | REST APIs |
|---|---|---|
| **What it is** | A signed URL you send the subscriber's **browser** to | A JSON **POST** your server makes |
| **Host** | \`${catalog.hosts.sdk}\` | \`${catalog.hosts.rest}\` |
| **Credential** | \`apiKey\` in the URL + SHA-512 \`signature\` from the API Secret | \`applicationId\` + App Password (\`password\`) in the body |
| **Answer** | A browser redirect to your \`redirectUrl\`, then a notification POSTed to you | A JSON body with \`statusCode\` |
| **Covers** | Subscribing, one-time charging | Listing subscribers, looking them up, unsubscribing |

There is no REST call that charges anyone and no SDK flow that unsubscribes anyone. Digimart
publishes no SMS, USSD, OTP or balance API — see [12-source-discrepancies.md](12-source-discrepancies.md).

## Before you run anything

Export the credentials and the endpoints your application uses. Every command on this page reads
them from the environment, so nothing here contains a credential and nothing you copy can commit
one.

\`\`\`bash
# Charging SDK — from the approved application in the portal
export DIGIMART_API_KEY='…'
export DIGIMART_API_SECRET='…'        # never in a URL, never in a client, never committed

# REST — from provisioning (the App Password arrives by email)
export DIGIMART_APP_ID='APP_XXXXXX'
export DIGIMART_PASSWORD='…'

${envLines.join("\n")}
\`\`\`

One variable per service, never a shared base URL: the two surfaces live on different hosts, and
an unset variable is how your code knows a service is not in use.

**Check your hashing first.** Before touching the platform, hash Digimart's worked example in your
language and compare:

| Signing string | SHA-512 (lowercase hex) |
|---|---|
${flows
  .filter((f, i, all) => all.findIndex((x) => x.workedExample.signingString === f.workedExample.signingString) === i)
  .map((f) => `| \`${md(f.workedExample.signingString)}\` | \`${f.workedExample.digest}\` |`)
  .join("\n")}

\`\`\`bash
printf '%s' 'myApiKey123|2024-08-08T12:00:00Z|mySecretKey456|50' | openssl dgst -sha512
\`\`\`

A different digest means the bug is in your hashing — encoding, algorithm or hex case — and no
amount of debugging against Digimart will find it.

---

## Index

| Flow | Open | Signs | Variable |
|---|---|---|---|
${flows.map((f) => `| [${f.name}](#${anchor(f.name)}) | \`${urlFor(f)}\` | \`${f.signingFields.join("\\|")}\` | \`${f.envVar}\` |`).join("\n")}

| REST call | Endpoint | Variable |
|---|---|---|
${services.map((s) => `| [${s.name}](#${anchor(s.name)}) | \`POST ${urlFor(s)}\` | \`${s.envVar}\` |`).join("\n")}

| Inbound | Digimart | Configured in |
|---|---|---|
${callbacks.map((c) => `| [${c.name}](#${anchor(c.name)}) | \`${c.method} <your-host>${c.suggestedPath}\` | ${c.configuredIn} |`).join("\n")}

---

# Signed-URL charging flows — the subscriber's browser opens these
`;

function flowSection(f) {
  const parts = [`---\n`, `## ${f.name}\n`, `${f.summary}\n`];
  parts.push(
    [
      `| | |`,
      `|---|---|`,
      `| **Open** | \`${urlFor(f)}\` in a browser or web view — an HTTP redirect or a link, never a server-side fetch |`,
      `| **Environment variable** | \`${f.envVar}\` |`,
      `| **Signing string** | \`${f.signingFields.join("\\|")}\` → SHA-512 → lowercase hex |`,
      `| **Answer** | Browser redirect to your \`redirectUrl\` ([Redirect Return](#${anchor("Redirect Return (browser)")})), then the [${catalog.callbacks.find((c) => c.id === f.returns.notification).name}](#${anchor(catalog.callbacks.find((c) => c.id === f.returns.notification).name)}) on the *${f.returns.notificationField}* |`,
      `| **Full guide** | ${ref(f.reference)} |`,
      `| **Source** | <${f.source}> |`,
    ].join("\n") + "\n"
  );
  if (f.movesMoney) {
    parts.push(
      `> **This flow moves real money.** Decide the amount on the server, sign it, and deliver only when the\n> charging notification arrives with \`statusCode\` \`S1000\` for this \`requestId\`.\n`
    );
  }
  parts.push(`### Query parameters\n`);
  parts.push(parameterTable(f.parameters, { showSigned: true }) + "\n");

  parts.push(`### Signing\n`);
  parts.push(
    `Join these fields with \`|\` — no spaces, no trailing separator, in exactly this order — hash the\n` +
      `UTF-8 bytes with SHA-512, and send the lowercase hex digest as \`signature\`:\n`
  );
  parts.push("```\n" + f.signingFields.join("|") + "\n```\n");
  parts.push(
    `Worked example: \`${f.workedExample.signingString}\` → \`${f.workedExample.digest}\`. ${f.workedExample.note}\n`
  );

  parts.push(`### Build it\n`);
  parts.push("```bash\n" + toShellRecipe(f) + "\n```\n");
  parts.push(
    `The values go into the URL un-encoded here, as in Digimart's own sample URLs. In code, use the\n` +
      `language's query-string encoder — but hash the **raw** values, never the encoded ones. A\n` +
      `\`redirectUrl\` with its own query string must be percent-encoded.\n`
  );

  const built = buildAuthorizeUrl(f, {});
  parts.push(`### The URL you end up with\n`);
  const readable = built.url
    .split(/(?=[?&])/)
    .map((part, i) => (i === 0 ? part : `  ${part[0]}${decodeURIComponent(part.slice(1))}`))
    .join("\n");
  parts.push("```\n" + readable + "\n```\n");
  parts.push(
    `Shown decoded. On the wire each value is percent-encoded by the query-string encoder; the\n` +
      `signature is computed over the raw values.\n`
  );
  parts.push(`Digimart's published sample for this flow:\n`);
  parts.push("```\n" + f.sampleUrl + "\n```\n");

  parts.push(`### What the subscriber sees\n`);
  parts.push(`Digimart renders every screen. You build none of them.\n`);
  parts.push(f.screens.map((s, i) => `${i + 1}. ${s}`).join("\n") + "\n");

  parts.push(`### What comes back\n`);
  parts.push(
    `1. **The redirect** — the browser lands on your \`redirectUrl\` with \`subscriptionStatus\`,\n` +
      `   \`subscriberId\` and \`requestId\` appended. Convenient, untrusted, may never arrive.\n` +
      `2. **The notification** — Digimart POSTs to the *${f.returns.notificationField}* configured on the\n` +
      `   application. Authoritative. Fulfil on this.\n`
  );
  parts.push(`Digimart's published redirect sample. ${f.sampleRedirectNote}\n`);
  parts.push("```\n" + f.sampleRedirect + "\n```\n");
  parts.push(
    `\`subscriptionStatus\` is a status code from the SDK table — all ${f.statusCodes.length} are in ` +
      `[07-status-codes.md](07-status-codes.md). Decode one with \`node tools/digimart.mjs code <CODE>\`, ` +
      `and check a URL you built with \`node tools/digimart.mjs check-url '<url>'\`.\n`
  );

  parts.push(`### Rules\n`);
  parts.push(f.rules.map((r) => `- ${r}`).join("\n") + "\n");
  return parts.join("\n");
}

function serviceSection(s) {
  const parts = [`---\n`, `## ${s.name}\n`, `${s.summary}\n`];
  parts.push(
    [
      `| | |`,
      `|---|---|`,
      `| **Endpoint** | \`POST ${urlFor(s)}\` |`,
      `| **Environment variable** | \`${s.envVar}\` |`,
      `| **Content type** | \`${catalog.conventions.rest.contentType}\` |`,
      `| **Full guide** | ${ref(s.reference)} |`,
      `| **Source** | <${s.source}> |`,
    ].join("\n") + "\n"
  );
  parts.push(`### Request parameters\n`);
  parts.push(parameterTable(s.parameters) + "\n");
  parts.push(`### Request\n`);
  parts.push("```bash\n" + toCurl(s, buildPayload(s)) + "\n```\n");
  parts.push(`### Response\n`);
  parts.push(
    `Success is \`statusCode\` ${successCodesFor(s).map((c) => `\`${c}\``).join(" or ")} in the body — ` +
      `branch on that, not on the HTTP status. The message is in \`${s.responseMessageField}\`.\n`
  );
  parts.push(json(s.sampleResponse) + "\n");
  parts.push(`### Response fields\n`);
  parts.push(responseTable(s.responseFields) + "\n");
  parts.push(`### Reading the response\n`);
  parts.push(s.responseHandling.map((h) => `- ${h}`).join("\n") + "\n");
  parts.push(`Check a real response with \`node tools/digimart.mjs response ${s.id} '<the body you got>'\`.\n`);
  parts.push(`### Status codes for this endpoint\n`);
  parts.push(statusTable(s.statusCodes, s.id) + "\n");
  if (s.statusCodes.length === 1) {
    parts.push(
      `The specification enumerates no further codes for this endpoint. Treat any other code as a\n` +
        `failure, log \`statusDetail\` and \`requestId\`, and escalate — do not borrow a meaning from another\n` +
        `platform.\n`
    );
  }
  parts.push(CLASS_LEGEND + "\n");
  parts.push(`### Rules\n`);
  parts.push(s.rules.map((r) => `- ${r}`).join("\n") + "\n");
  return parts.join("\n");
}

function callbackSection(cb) {
  const parts = [`---\n`, `## ${cb.name}\n`, `${cb.summary}\n`];
  const isGet = cb.method === "GET";
  parts.push(
    [
      `| | |`,
      `|---|---|`,
      `| **Direction** | Digimart → you. There is nothing to call. |`,
      `| **Your route** | \`${cb.method} <your-host>${cb.suggestedPath}\` (the path is yours) |`,
      `| **Configured in** | ${cb.configuredIn} |`,
      `| **Deduplicate on** | \`${cb.dedupeKey}\` |`,
      `| **Full guide** | ${ref(cb.reference)} |`,
      `| **Source** | <${cb.source}> |`,
    ].join("\n") + "\n"
  );
  if (cb.payloadNote) parts.push(`> ${cb.payloadNote}\n`);
  parts.push(`### ${isGet ? "Query parameters" : "Payload fields"}\n`);
  parts.push(parameterTable(cb.fields, { label: "Field", required: isGet ? "Always" : "Always sent" }) + "\n");
  parts.push(`### What arrives\n`);
  if (isGet) {
    parts.push("```\nGET <your redirectUrl>?" + new URLSearchParams(cb.samplePayload).toString() + "\n```\n");
  } else {
    parts.push(json(cb.samplePayload) + "\n");
  }
  parts.push(`### What you must respond\n`);
  parts.push(
    isGet
      ? `A page for the subscriber, chosen by \`subscriptionStatus\`. Never grant anything here.\n`
      : `HTTP 200, immediately, before doing any work. ${catalog.conventions.callbackAck.note}\n`
  );
  parts.push(`### Replay it against your own handler\n`);
  const cmd = isGet
    ? `curl -sS -i "http://localhost:3000${cb.suggestedPath}?${new URLSearchParams(cb.samplePayload).toString()}"`
    : `curl -sS -i -X POST "http://localhost:3000${cb.suggestedPath}" \\\n  -H 'Content-Type: application/json' \\\n  -d @- <<'PAYLOAD'\n${JSON.stringify(cb.samplePayload, null, 2)}\nPAYLOAD`;
  parts.push("```bash\n" + cmd + "\n```\n");
  if (cb.statusCodes?.length && cb.statusCodes.length < 10) {
    parts.push(`### Status codes documented on this payload\n`);
    parts.push(statusTable(cb.statusCodes, cb.id) + "\n");
  }
  parts.push(`### Rules\n`);
  parts.push(cb.rules.map((r) => `- ${r}`).join("\n") + "\n");
  return parts.join("\n");
}

const epilogue = `---

## What a recipe does not show

Every recipe above is a hash and a query string, or one HTTPS POST, and that part ports to any
language in a few lines. The difference between a working call and a production integration is
what surrounds it:

| | Why the recipe hides it |
|---|---|
| **The secret stays on the server** | A shell has the secret in its environment. A browser or a phone must never: clients call *your* start endpoint, and your server signs. |
| **The amount comes from your price list** | Typed by hand here. In code it is looked up on the server by what the user is buying — never taken from the client. |
| **One \`requestTime\`, one \`amount\`, used twice** | The recipe builds each into a variable once. Code that formats them again for the URL produces \`E1002\`. |
| **\`requestId\` persisted first** | Allocate, store against the order, then redirect. The notification is matched on it. |
| **Fulfil on the notification** | The replay commands show both signals. Only the notification grants anything. |
| **Acknowledge first, idempotently** | Answer 200 and queue; deduplicate on the documented key. |
| **\`statusCode\` branching on REST** | You read the JSON yourself here. Code that trusts the HTTP status is wrong. |
| **\`tel:\` in one helper** | The notification gives a bare masked \`subscriberId\`; the REST calls want \`tel:<value>\`. |

Those are specified language-neutrally in [10-any-stack.md](10-any-stack.md), and built in
TypeScript/Node, Python, Java, Go, PHP and C# in [templates/](../templates/README.md).

## Related

| | |
|---|---|
| Machine-readable form of this page | [\`catalog/digimart-api.json\`](../catalog/digimart-api.json) |
| Build a signed URL with your own values | \`node tools/digimart.mjs url <flow> key=value …\` |
| Check a URL you built | \`node tools/digimart.mjs check-url '<url>'\` |
| Build a REST call | \`node tools/digimart.mjs curl <id> key=value …\` |
| Decode a status code | \`node tools/digimart.mjs code <statusCode>\` |
| Smoke-test the REST calls | [\`scripts/smoke-test.sh\`](../scripts/smoke-test.sh) (or \`smoke-test.ps1\`) |
| Test your inbound handlers | [\`scripts/test-callbacks.sh\`](../scripts/test-callbacks.sh) |
`;

const document = [
  preamble,
  ...flows.map(flowSection),
  `---\n\n# REST APIs — your server calls Digimart\n`,
  ...services.map(serviceSection),
  `---\n\n# Inbound — Digimart calls you\n`,
  ...callbacks.map(callbackSection),
  epilogue,
].join("\n");

/* ── Write or check ──────────────────────────────────────────────────────── */

const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : null;
if (current === document) {
  console.log("references/13-integration-reference.md is in sync with the catalog.");
} else if (check) {
  console.error(
    "stale: references/13-integration-reference.md\n\n" +
      "It no longer matches catalog/digimart-api.json. Run\n" +
      "`node scripts/build-integration-reference.mjs` and commit the result."
  );
  process.exit(1);
} else {
  writeFileSync(OUT, document);
  console.log(
    `wrote references/13-integration-reference.md — ${flows.length} flows, ${services.length} REST calls, ${callbacks.length} inbound.`
  );
}
