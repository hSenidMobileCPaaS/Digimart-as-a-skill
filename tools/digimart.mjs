#!/usr/bin/env node
/**
 * digimart — offline reference CLI for Digimart.
 *
 * Everything an MCP server would expose as tools, exposed as subcommands any
 * agent can run through its shell. No install, no dependencies, no server and
 * no network access.
 *
 *   node tools/digimart.mjs <command> [args] [--json]
 *
 * Only `sign`, `url` and `check-url` ever touch a credential: they read
 * DIGIMART_API_SECRET from the environment, if it is set, to compute a SHA-512
 * locally. They never print it, never write it and never send it anywhere.
 */

import { readFileSync } from "node:fs";
import {
  allEntries,
  buildAuthorizeUrl,
  buildPayload,
  catalog,
  checkAuthorizeUrl,
  coerceValues,
  diagnose,
  findEntry,
  lookupStatusCode,
  readRedirect,
  readReference,
  readResponse,
  search,
  sign,
  signingString,
  successCodesFor,
  toCurl,
  toShellRecipe,
  urlFor,
  validatePayload,
} from "./catalog.mjs";

/* ── Output ──────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const JSON_MODE = argv.includes("--json");
const EXAMPLE = argv.includes("--example");
const args = argv.filter((a) => a !== "--json" && a !== "--example");
const [command, ...rest] = args;

const isTTY = process.stdout.isTTY;
const c = (code, s) => (isTTY && !JSON_MODE ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c(1, s);
const dim = (s) => c(2, s);
const red = (s) => c(31, s);
const green = (s) => c(32, s);
const yellow = (s) => c(33, s);
const cyan = (s) => c(36, s);

function out(data, render) {
  if (JSON_MODE) console.log(JSON.stringify(data, null, 2));
  else render(data);
}

function fail(message, data = {}) {
  if (JSON_MODE) console.log(JSON.stringify({ error: message, ...data }, null, 2));
  else console.error(red(`error: ${message}`));
  process.exit(1);
}

const indent = (s, n) => s.split("\n").map((l) => " ".repeat(n) + l).join("\n");

const CLASS_COLOR = {
  success: green,
  "undocumented-success": green,
  configuration: red,
  client: yellow,
  "user-state": yellow,
  transient: cyan,
  undocumented: dim,
};

const ARROW = { "sdk-flow": "⇢", service: "→", callback: "←" };

function pairs(list) {
  const raw = {};
  for (const pair of list) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    raw[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return raw;
}

function requireEntry(id, usage) {
  if (!id) fail(`usage: ${usage}`);
  const entry = findEntry(id);
  if (!entry) fail(`Unknown id "${id}".`, { available: allEntries().map((e) => e.id) });
  return entry;
}

/** Read a document from an inline argument, a @file, or stdin. */
function readArgument(source) {
  if (source === "-") return readFileSync(0, "utf8");
  if (source.startsWith("@")) return readFileSync(source.slice(1), "utf8");
  return source;
}

function readJsonArgument(source, label) {
  try {
    return JSON.parse(readArgument(source));
  } catch (err) {
    fail(`${label} is not valid JSON: ${err.message}`);
  }
}

const secretFromEnv = () => {
  const s = process.env.DIGIMART_API_SECRET;
  return s && s.trim() ? s.trim() : undefined;
};

/* ── Discover ────────────────────────────────────────────────────────────── */

function cmdList() {
  const category = rest.find((a) => !a.startsWith("--"));
  const dirFlag = rest.find((a) => a.startsWith("--direction="));
  const direction = dirFlag ? dirFlag.split("=")[1] : null;

  const entries = allEntries()
    .filter((e) => !category || e.category === category || e.kind === category)
    .filter((e) => !direction || e.direction === direction)
    .map((e) => ({
      id: e.id,
      name: e.name,
      kind: e.kind,
      category: e.category,
      direction: e.direction,
      endpoint:
        e.kind === "sdk-flow"
          ? `open ${urlFor(e)}`
          : e.kind === "service"
            ? `POST ${urlFor(e)}`
            : `${e.method} <your-host>${e.suggestedPath}`,
      summary: e.summary,
      movesMoney: e.movesMoney || undefined,
    }));
  if (!entries.length) fail(`Nothing matches "${category || direction}".`);

  out({ count: entries.length, hosts: catalog.hosts, entries }, (d) => {
    console.log(`\n${bold("Digimart")}  ${dim(`SDK ${d.hosts.sdk}   REST ${d.hosts.rest}`)}\n`);
    const groups = [
      ["sdk-flow", "SIGNED-URL CHARGING FLOWS — you build a URL, the subscriber's browser opens it"],
      ["service", "REST APIS — your server calls Digimart"],
      ["callback", "INBOUND — Digimart calls you"],
    ];
    for (const [kind, title] of groups) {
      const list = d.entries.filter((e) => e.kind === kind);
      if (!list.length) continue;
      console.log(bold(`  ${title}`));
      for (const e of list) {
        const money = e.movesMoney ? red("  $$ real money") : "";
        console.log(`    ${ARROW[e.kind]} ${cyan(e.id.padEnd(26))} ${dim(e.endpoint)}${money}`);
        console.log(`      ${dim(e.summary)}`);
      }
      console.log();
    }
    console.log(`  ${dim(`${d.count} entries. Full contract: digimart show <id>`)}\n`);
  });
}

function cmdShow() {
  const entry = requireEntry(rest[0], "digimart show <id>");
  const data = {
    ...entry,
    url: urlFor(entry),
    statusCodeDetail: (entry.statusCodes || []).map(lookupStatusCode),
  };

  out(data, (d) => {
    console.log(`\n${bold(d.name)}  ${dim(`(${d.id})`)}`);
    console.log(`${d.summary}\n`);
    if (d.kind === "sdk-flow") {
      console.log(`  ${bold("Open")}      ${cyan(d.url)}  ${dim("in the subscriber's browser — not an API call")}`);
      console.log(`  ${bold("Variable")}  ${d.envVar}`);
      console.log(`  ${bold("Signs")}     ${yellow(d.signingFields.join("|"))}  ${dim("→ SHA-512 → lowercase hex")}`);
      console.log(`  ${bold("Returns")}   redirect to redirectUrl, then ${d.returns.notification} on the ${d.returns.notificationField}`);
    } else if (d.kind === "service") {
      console.log(`  ${bold("Endpoint")}  POST ${cyan(d.url)}`);
      console.log(`  ${bold("Variable")}  ${d.envVar}`);
    } else {
      console.log(`  ${bold("Your route")}  ${d.method} ${cyan(d.suggestedPath)}   ${dim(`configured in: ${d.configuredIn}`)}`);
      console.log(`  ${bold("Dedupe key")}  ${d.dedupeKey}`);
    }
    if (d.movesMoney) console.log(`  ${red("⚠  This flow moves real money.")}`);
    if (d.payloadNote) console.log(`  ${yellow("!")} ${d.payloadNote}`);

    const spec = d.parameters || d.fields || [];
    const label = d.kind === "sdk-flow" ? "Query parameters" : d.kind === "service" ? "Request body" : "What arrives";
    console.log(`\n  ${bold(label)}`);
    for (const p of spec) {
      const req = p.required ? red("required") : dim("optional");
      const signed = p.signed ? yellow(" signed") : "";
      const en = p.enum ? dim(`  [${p.enum.join(" | ")}]`) : "";
      console.log(`    ${cyan(p.name.padEnd(22))} ${String(p.type).padEnd(22)} ${req}${signed}${en}`);
      console.log(`      ${dim(p.description)}`);
      if (p.perRequest) console.log(`      ${yellow("!")} ${p.perRequest}`);
      if (p.note) console.log(`      ${yellow("!")} ${p.note}`);
    }

    if (d.workedExample) {
      console.log(`\n  ${bold("Worked example")}  ${dim("hash this in your language and compare")}`);
      console.log(`    ${d.workedExample.signingString}`);
      console.log(`    ${dim("sha512 →")} ${d.workedExample.digest}`);
    }
    if (d.responseFields) {
      console.log(`\n  ${bold("Response fields")}`);
      for (const f of d.responseFields) {
        console.log(`    ${cyan(f.name.padEnd(22))} ${dim(f.description)}`);
        for (const n of f.fields || []) console.log(`      ${cyan(`[].${n.name}`.padEnd(22))} ${dim(n.description)}`);
      }
      console.log(`\n  ${bold("Success")}  ${green(successCodesFor(d).join(" or "))}`);
      for (const h of d.responseHandling || []) console.log(`    ${dim("·")} ${h}`);
    }
    if (d.sampleUrl) {
      console.log(`\n  ${bold("Published sample URL")}`);
      console.log(indent(d.sampleUrl.replace(/[?&]/g, (m) => `\n  ${m}`), 4));
    }
    if (d.sampleRequest) {
      console.log(`\n  ${bold("Sample request")}`);
      console.log(indent(JSON.stringify(d.sampleRequest, null, 2), 4));
    }
    if (d.sampleResponse) {
      console.log(`\n  ${bold("Sample response")}`);
      console.log(indent(JSON.stringify(d.sampleResponse, null, 2), 4));
    }
    if (d.samplePayload) {
      console.log(`\n  ${bold(d.kind === "callback" && d.method === "GET" ? "Query parameters Digimart appends" : "Sample payload Digimart sends you")}`);
      console.log(indent(JSON.stringify(d.samplePayload, null, 2), 4));
      if (d.method === "POST") console.log(`\n  ${bold("You respond")}  HTTP 200, fast. ${dim(catalog.conventions.callbackAck.note)}`);
    }
    if (d.rules?.length) {
      console.log(`\n  ${bold("Rules")}`);
      d.rules.forEach((r) => console.log(`    ${yellow("!")} ${r}`));
    }
    if (d.statusCodeDetail?.length && d.kind !== "sdk-flow") {
      console.log(`\n  ${bold("Status codes")}`);
      for (const s of d.statusCodeDetail) {
        const colour = CLASS_COLOR[s.class] || dim;
        console.log(`    ${colour(s.code.padEnd(7))} ${dim(s.class.padEnd(21))} ${s.description}`);
      }
    } else if (d.kind === "sdk-flow") {
      console.log(`\n  ${bold("Status codes")}  ${dim(`all ${d.statusCodes.length} SDK codes — digimart code <CODE>, or references/07-status-codes.md`)}`);
    }
    console.log(`\n  ${dim(`Full guide: ${d.reference}   Source: ${d.source}`)}\n`);
  });
}

function cmdSearch() {
  const query = rest.join(" ");
  if (!query) fail("usage: digimart search <query>");
  const results = search(query, 20);
  out({ query, results }, (d) => {
    if (!d.results.length) return console.log(`\n  ${yellow(`Nothing matched "${d.query}".`)}\n`);
    console.log(`\n  ${bold(`${d.results.length} results for "${d.query}"`)}\n`);
    for (const r of d.results) {
      console.log(`    ${dim(r.type.padEnd(13))} ${cyan(String(r.id).slice(0, 30).padEnd(30))} ${(r.summary || "").slice(0, 60)}`);
    }
    console.log(`\n  ${dim("Detail: digimart show <id>   or   digimart code <CODE>")}\n`);
  });
}

function cmdPlatform() {
  const data = {
    platform: catalog.platform,
    hosts: catalog.hosts,
    credentials: catalog.credentials,
    conventions: catalog.conventions,
    yourEndpoints: catalog.yourEndpoints,
  };
  out(data, (d) => {
    const p = d.platform;
    console.log(`\n  ${bold(p.name)} — run by ${p.operator}, charging ${p.network} subscribers in ${p.market} (${p.currency})\n`);
    console.log(`  ${dim(p.summary)}\n`);
    console.log(`  ${bold("Products")}`);
    for (const x of p.products) console.log(`    ${cyan(x.name.padEnd(28))} ${dim(x.reference)}\n      ${dim(x.summary)}`);
    console.log(`\n  ${bold("Two surfaces, two hosts, two credentials")}`);
    console.log(`    SDK   ${cyan(d.hosts.sdk.padEnd(30))} API Key + SHA-512 signature from the API Secret`);
    console.log(`    REST  ${cyan(d.hosts.rest.padEnd(30))} applicationId + App Password in the JSON body`);
    console.log(`\n  ${bold("Credentials")}`);
    for (const x of d.credentials) {
      console.log(`    ${cyan(x.envVar.padEnd(22))} ${x.name.padEnd(14)} ${x.secret ? red("secret") : dim("not secret")}  ${dim(x.surface)}`);
    }
    console.log(`\n  ${bold("Endpoints YOU build")}`);
    for (const e of d.yourEndpoints) console.log(`    ${cyan(e.name.padEnd(40))} ${dim(e.suggestedPath)}`);
    console.log(`\n  ${bold("Charging band")}  ${p.chargingBand.min}–${p.chargingBand.max} ${p.chargingBand.currency} per one-time charge`);
    console.log(`  ${bold("Portal")}  ${p.portal}   ${bold("Docs")}  ${p.docs}`);
    console.log(`  ${bold("Support")}  ${p.support.email} · ${p.support.phone}\n`);
  });
}

/* ── Build: signed URLs ──────────────────────────────────────────────────── */

function flowFrom(id, usage) {
  const entry = requireEntry(id, usage);
  if (entry.kind !== "sdk-flow") {
    fail(`${entry.id} is not a signed-URL flow. Flows: ${catalog.sdkFlows.map((f) => f.id).join(", ")}.`);
  }
  return entry;
}

/**
 * Compute a signature. With --example, from Digimart's worked example — the
 * known answer every implementation should reproduce.
 */
function cmdSign() {
  const flow = flowFrom(rest[0] || (EXAMPLE ? "subscription" : undefined), "digimart sign <flow> [apiKey=… requestTime=… amount=…]  |  digimart sign --example [flow]");

  if (EXAMPLE) {
    const ex = flow.workedExample;
    const computed = sign(flow, ex.values);
    const data = { flow: flow.id, ...ex, computed, matches: computed === ex.digest };
    return out(data, (d) => {
      console.log(`\n  ${bold("Worked example")}  ${dim(`${flow.name}`)}\n`);
      console.log(`  ${bold("Signing string")}  ${d.signingString}`);
      console.log(`  ${bold("SHA-512")}         ${green(d.computed)}\n`);
      console.log(`  ${dim("Hash this exact string in your own language. If you do not get this digest,")}`);
      console.log(`  ${dim("your hashing is wrong before Digimart is involved — check UTF-8, SHA-512, lowercase hex.")}\n`);
    });
  }

  const raw = pairs(rest.slice(1));
  if (raw.apiSecret !== undefined) {
    fail("Do not pass the secret on the command line — it lands in shell history. Export DIGIMART_API_SECRET instead.");
  }
  const values = {
    apiKey: raw.apiKey ?? process.env.DIGIMART_API_KEY,
    requestTime: raw.requestTime,
    amount: raw.amount,
  };
  const secret = secretFromEnv();
  const missing = flow.signingFields.filter((f) => f !== "apiSecret" && !values[f]);

  const data = {
    flow: flow.id,
    signingFields: flow.signingFields,
    signingString: signingString(flow, { ...values, apiSecret: secret }, { redact: true }),
    pipes: flow.signingFields.length - 1,
    signature: secret && !missing.length ? sign(flow, { ...values, apiSecret: secret }) : null,
    missing: missing.length ? missing : undefined,
    secretSource: secret ? "DIGIMART_API_SECRET (never printed)" : null,
  };
  out(data, (d) => {
    console.log(`\n  ${bold("Signing string")}  ${d.signingString}  ${dim(`(${d.pipes} pipes)`)}`);
    if (d.signature) {
      console.log(`  ${bold("signature")}       ${green(d.signature)}`);
      console.log(`  ${dim(`secret read from ${d.secretSource}`)}\n`);
    } else {
      if (d.missing) console.log(`  ${yellow("!")} missing: ${d.missing.join(", ")}`);
      if (!secret) console.log(`  ${yellow("!")} DIGIMART_API_SECRET is not set, so nothing was hashed.`);
      console.log(`\n  ${dim("Or in any shell:")}`);
      const vars = { apiKey: "$DIGIMART_API_KEY", requestTime: "$REQUEST_TIME", apiSecret: "$DIGIMART_API_SECRET", amount: "$AMOUNT" };
      console.log(`    printf '%s' "${flow.signingFields.map((f) => vars[f]).join("|")}" | openssl dgst -sha512 | awk '{print $NF}'\n`);
    }
  });
}

/** Build a complete authorize URL, with fresh per-request values. */
function cmdUrl() {
  const flow = flowFrom(rest[0], "digimart url <flow> [redirectUrl=… amount=… msisdn=…]");
  const raw = pairs(rest.slice(1));
  if (raw.apiSecret !== undefined) fail("Do not pass the secret on the command line. Export DIGIMART_API_SECRET instead.");
  if (!raw.apiKey && process.env.DIGIMART_API_KEY) raw.apiKey = process.env.DIGIMART_API_KEY;

  const built = buildAuthorizeUrl(flow, raw, { apiSecret: secretFromEnv(), perRequest: "fresh" });
  const check = built.signed ? checkAuthorizeUrl(built.url, { apiSecret: secretFromEnv() }) : null;
  const recipe = toShellRecipe(flow, raw);

  const data = { flow: flow.id, ...built, check, shellRecipe: recipe, reference: "references/13-integration-reference.md" };
  out(data, (d) => {
    console.log(`\n  ${bold(flow.name)}  ${dim(`open in a browser — ${flow.envVar}`)}\n`);
    console.log(indent(d.url.replace(/[?&]/g, (m) => `\n${m}`), 4));
    console.log(`\n  ${bold("Signed")}  ${d.signingString}  ${dim(d.signed ? "→ computed locally" : "→ $SIGNATURE placeholder: export DIGIMART_API_SECRET to compute it")}`);
    console.log(`  ${yellow("!")} requestId ${d.params.requestId} is single-use. Persist it against the order before redirecting.`);
    if (d.check && !d.check.valid) d.check.errors.forEach((e) => console.log(`  ${red("✗")} ${e}`));
    d.check?.warnings?.forEach((w) => console.log(`  ${yellow("!")} ${w}`));
    console.log(`\n  ${bold("The same URL in any shell")}\n`);
    console.log(indent(d.shellRecipe, 4));
    console.log(`\n  ${dim(`Every flow in this form: ${d.reference}`)}\n`);
  });
}

function cmdCheckUrl() {
  const source = rest[0];
  if (!source) fail("usage: digimart check-url '<the authorize URL you built>'");
  const result = checkAuthorizeUrl(readArgument(source).trim(), { apiSecret: secretFromEnv() });
  out(result, (d) => {
    console.log();
    if (d.valid) console.log(`  ${green("✓ looks right")}  against ${bold(d.flow)}${d.signatureCheck?.matches ? green("  signature verified") : ""}`);
    else console.log(`  ${red(`✗ ${d.errors.length} problem(s)`)}${d.flow ? `  against ${bold(d.flow)}` : ""}`);
    d.errors.forEach((e) => console.log(`    ${red("✗")} ${e}`));
    d.warnings.forEach((w) => console.log(`    ${yellow("!")} ${w}`));
    if (d.flow && !d.signatureCheck) {
      console.log(`    ${dim("signature not verified — export DIGIMART_API_SECRET to have it recomputed locally")}`);
    }
    console.log();
  });
  if (!result.valid) process.exitCode = 1;
}

function cmdRedirect() {
  const source = rest[0];
  if (!source) fail("usage: digimart redirect '<the URL the browser landed on, or its query string>'");
  const result = readRedirect(readArgument(source));
  out(result, (d) => {
    console.log();
    const verdict = d.ok ? green(`✓ ${d.subscriptionStatus}`) : red(`✗ ${d.subscriptionStatus ?? "no subscriptionStatus"}`);
    console.log(`  ${verdict}  ${dim(d.description ?? "")}`);
    console.log(`  ${bold("requestId")}     ${d.requestId ?? "—"}`);
    console.log(`  ${bold("subscriberId")}  ${d.subscriberId ? `${d.subscriberId.slice(0, 12)}…  ${dim("(masked number)")}` : "—"}`);
    console.log(`  ${yellow("!")} ${d.note}`);
    d.problems.forEach((p) => console.log(`\n  ${red("✗")} ${p}`));
    if (d.nextSteps.length) {
      console.log(`\n  ${bold("Next")}`);
      d.nextSteps.forEach((s) => console.log(`    ${dim("·")} ${s}`));
    }
    console.log();
  });
  if (!result.ok) process.exitCode = 1;
}

/* ── Build: REST calls ───────────────────────────────────────────────────── */

function cmdCurl() {
  const entry = requireEntry(rest[0], "digimart curl <id> [key=value ...]");

  if (entry.kind === "sdk-flow") {
    fail(`${entry.id} is a signed URL opened in a browser, not a request you send. Use: digimart url ${entry.id}`);
  }
  if (entry.kind === "callback") {
    const isGet = entry.method === "GET";
    const qs = new URLSearchParams(entry.samplePayload).toString();
    const testCommand = isGet
      ? `curl -sS -i 'http://localhost:3000${entry.suggestedPath}?${qs}'`
      : `curl -sS -i -X POST 'http://localhost:3000${entry.suggestedPath}' \\\n  -H 'Content-Type: application/json' \\\n  --data '${JSON.stringify(entry.samplePayload)}'`;
    const data = {
      note: `${entry.name} is inbound — Digimart ${isGet ? "sends the browser to" : "calls"} you. You do not call it.`,
      yourRoute: `${entry.method} ${entry.suggestedPath}`,
      configuredIn: entry.configuredIn,
      fields: entry.fields,
      incoming: entry.samplePayload,
      yourResponse: isGet ? "A page for the user." : catalog.conventions.callbackAck,
      dedupeKey: entry.dedupeKey,
      testCommand,
      reference: "references/13-integration-reference.md",
    };
    return out(data, (d) => {
      console.log(`\n  ${yellow(d.note)}`);
      console.log(`  ${dim(`configured in: ${d.configuredIn}`)}\n`);
      console.log(`  ${bold("Fields")}`);
      for (const f of d.fields) console.log(`    ${cyan(f.name.padEnd(22))} ${String(f.type).padEnd(8)} ${dim(f.description)}`);
      console.log(`\n  ${bold("Replay it against your handler:")}\n`);
      console.log(indent(d.testCommand, 4));
      console.log(`\n  ${bold("Deduplicate on:")} ${d.dedupeKey}\n`);
    });
  }

  const raw = pairs(rest.slice(1));
  const values = coerceValues(entry, raw);
  const payload = buildPayload(entry, values);
  const validation = validatePayload(entry, payload);
  for (const secret of ["applicationId", "password"]) {
    if (raw[secret] !== undefined) {
      validation.warnings.unshift(
        `${secret} was ignored — this command never prints a credential. Export DIGIMART_${secret === "password" ? "PASSWORD" : "APP_ID"}.`
      );
    }
  }
  const data = {
    service: entry.id,
    name: entry.name,
    endpoint: `POST ${urlFor(entry)}`,
    envVar: entry.envVar,
    parameters: entry.parameters,
    payload,
    curl: toCurl(entry, payload),
    sampleResponse: entry.sampleResponse,
    successCodes: successCodesFor(entry),
    responseFields: entry.responseFields,
    responseHandling: entry.responseHandling,
    validation,
    reference: "references/13-integration-reference.md",
  };
  out(data, (d) => {
    console.log(`\n  ${bold(d.name)}  ${dim(d.endpoint)}`);
    console.log(`  ${dim(`endpoint variable ${d.envVar}`)}\n`);
    console.log(`  ${bold("Parameters")}`);
    for (const p of d.parameters) {
      const req = p.required ? red("required") : dim("optional");
      const en = p.enum ? dim(`  [${p.enum.join(" | ")}]`) : "";
      console.log(`    ${cyan(p.name.padEnd(20))} ${p.type.padEnd(9)} ${req}${en}`);
      console.log(`      ${dim(p.description)}`);
    }
    console.log(`\n  ${bold("Request")}\n`);
    console.log(indent(d.curl, 2));
    console.log(`\n  ${bold("Response")}  ${dim(`success is statusCode ${d.successCodes.join(" or ")}`)}\n`);
    console.log(indent(JSON.stringify(d.sampleResponse, null, 2), 4));
    if (d.responseHandling?.length) {
      console.log(`\n  ${bold("Reading the response")}`);
      d.responseHandling.forEach((h) => console.log(`    ${dim("·")} ${h}`));
      console.log(`    ${dim(`Check a real one: digimart response ${d.service} '<body>'`)}`);
    }
    console.log();
    if (!d.validation.valid) {
      console.log(`  ${red(bold("Invalid:"))}`);
      d.validation.errors.forEach((e) => console.log(`    ${red("✗")} ${e}`));
    }
    d.validation.warnings.forEach((w) => console.log(`  ${yellow("!")} ${w}`));
    console.log(`\n  ${dim("Credentials are env placeholders — export them, do not paste them in.")}\n`);
  });
}

function cmdValidate() {
  const [id, source] = rest;
  if (!id || !source) fail("usage: digimart validate <id> <json|@file|->");
  const entry = requireEntry(id, "digimart validate <id> <json>");
  const result = validatePayload(entry, readJsonArgument(source, "Payload"));
  out({ id: entry.id, ...result }, (d) => {
    console.log();
    if (d.valid) console.log(`  ${green("✓ valid")}  against ${bold(d.id)}`);
    else {
      console.log(`  ${red(`✗ ${d.errors.length} error(s)`)}  against ${bold(d.id)}`);
      d.errors.forEach((e) => console.log(`    ${red("✗")} ${e}`));
    }
    d.warnings.forEach((w) => console.log(`    ${yellow("!")} ${w}`));
    console.log();
  });
  if (!result.valid) process.exitCode = 1;
}

function cmdResponse() {
  const [id, source] = rest;
  if (!id || !source) fail("usage: digimart response <id> <json|@file|->");
  const entry = requireEntry(id, "digimart response <id> <json>");
  const result = readResponse(entry, readJsonArgument(source, "Response"));
  out(result, (d) => {
    console.log();
    const verdict = d.ok ? green(`✓ success  ${d.statusCode}`) : red(`✗ failure  ${d.statusCode ?? "no statusCode"}`);
    console.log(`  ${verdict}  ${dim(`against ${d.service}; success here is ${d.successCodes.join(" or ")}`)}`);
    if (d.message) console.log(`  ${bold("Message")}  ${d.message}`);
    if (!d.ok && d.description) console.log(`  ${dim(d.description)}`);
    d.problems.forEach((p) => console.log(`\n  ${red("✗")} ${p}`));
    d.notes.forEach((n) => console.log(`\n  ${yellow("!")} ${n}`));
    if (d.nextSteps.length) {
      console.log(`\n  ${bold("Next")}`);
      d.nextSteps.forEach((s) => console.log(`    ${dim("·")} ${s}`));
    }
    console.log();
  });
  if (!result.ok) process.exitCode = 1;
}

/* ── Debug and guidance ──────────────────────────────────────────────────── */

function cmdCode() {
  const code = rest[0];
  if (!code) fail("usage: digimart code <statusCode>");
  const info = lookupStatusCode(code);
  out(info, (d) => {
    const colour = CLASS_COLOR[d.class] || dim;
    const scope = d.surface.length ? dim(`  ${d.surface.join(" + ")}`) : "";
    console.log(`\n  ${colour(bold(d.code))}  ${dim(d.class)}${scope}${d.known ? "" : dim("  (not in any published list)")}`);
    console.log(`  ${d.description}\n`);
    const retry = d.retry === true ? green("yes — a NEW flow or a backed-off REST retry") : d.retry === "after-user-action" ? yellow("only after the subscriber acts") : red("no");
    console.log(`  ${bold("Retry")}   ${retry}`);
    console.log(`  ${bold("Action")}  ${d.action}`);
    if (d.known && !d.published) console.log(`  ${yellow("!")} Digimart publishes no meaning for this code. Do not borrow one from another platform.`);
    if (d.affects?.length) console.log(`  ${dim(`Seen on: ${d.affects.join(", ")}`)}`);
    console.log();
  });
}

function cmdDiagnose() {
  const symptom = rest.join(" ");
  if (!symptom) fail('usage: digimart diagnose "<symptom or status code>"');
  const d = diagnose(symptom);
  out(d, (r) => {
    console.log();
    if (r.matchedOn === "statusCode") {
      console.log(`  ${(CLASS_COLOR[r.class] || dim)(bold(r.code))}  ${r.description}\n`);
      console.log(`  ${bold("Fix")}  ${r.action}`);
    } else if (r.matchedOn === "symptom") {
      console.log(`  ${bold("Likely cause")}\n  ${r.cause}\n`);
      console.log(`  ${bold("Fix")}\n  ${green(r.fix)}`);
    } else {
      console.log(`  ${yellow("No signature matched.")} ${r.suggestion}`);
      r.searchResults?.forEach((x) => console.log(`    ${cyan(String(x.id).slice(0, 28).padEnd(28))} ${dim(x.summary?.slice(0, 70) ?? "")}`));
    }
    console.log();
  });
}

function cmdPractices() {
  const severity = rest[0];
  const practices = catalog.practices.filter((p) => !severity || p.severity === severity);
  if (!practices.length) fail(`No practices with severity "${severity}". Try: critical, high, medium.`);
  out({ practices }, (d) => {
    console.log(`\n  ${bold("Digimart practices")}\n`);
    let group = null;
    for (const p of d.practices) {
      if (p.severity !== group) {
        group = p.severity;
        const colour = group === "critical" ? red : group === "high" ? yellow : dim;
        console.log(`  ${colour(bold(group.toUpperCase()))}`);
      }
      console.log(`    ${bold(p.title)}\n      ${dim(p.detail)}\n      ${dim(p.reference)}\n`);
    }
  });
}

function cmdGaps() {
  const data = { notPublished: catalog.notPublished, discrepancies: catalog.discrepancies };
  out(data, (d) => {
    console.log(`\n  ${bold("Not published by Digimart — do not invent these")}\n`);
    d.notPublished.forEach((n) => console.log(`    ${red("✗")} ${bold(n.item)}\n      ${dim(n.detail)}\n`));
    console.log(`  ${bold("Where the published sources disagree, and what this skill uses")}\n`);
    d.discrepancies.forEach((x) => console.log(`    ${yellow("≠")} ${bold(x.where)}\n      ${dim(x.issue)}\n      ${green("→")} ${x.resolution}\n`));
  });
}

function cmdChecklist() {
  const doc = readReference("09-production-checklist");
  if (!doc) fail("Checklist not found.");
  if (JSON_MODE) {
    const items = doc
      .split("\n")
      .filter((l) => l.trim().startsWith("- [ ]"))
      .map((l) => l.replace(/^\s*- \[ \]\s*/, "").trim());
    console.log(JSON.stringify({ count: items.length, items }, null, 2));
  } else console.log(doc);
}

const REFERENCE_DOCS = [
  "01-getting-started", "02-signatures", "03-subscription-sdk", "04-one-time-sdk",
  "05-callbacks", "06-rest-apis", "07-status-codes", "08-security-best-practices",
  "09-production-checklist", "10-any-stack", "11-implementation-playbook",
  "12-source-discrepancies", "13-integration-reference",
];

function cmdReference() {
  const doc = rest[0];
  if (!doc) {
    return out({ documents: REFERENCE_DOCS }, (d) => {
      console.log(`\n  ${bold("Reference documents")}\n`);
      d.documents.forEach((x) => console.log(`    ${cyan(x)}`));
      console.log(`\n  ${dim("digimart reference <name>")}\n`);
    });
  }
  const content = readReference(doc);
  if (!content) fail(`Reference "${doc}" not found.`);
  console.log(content);
}

function cmdHelp() {
  console.log(`
  ${bold("digimart")} — offline reference for Digimart ${dim(`(catalog v${catalog.catalogVersion})`)}

  ${bold("USAGE")}
    node tools/digimart.mjs <command> [args] [--json]

  ${bold("DISCOVER")}
    list [category|kind] [--direction=redirect|outbound|inbound]   Flows, APIs, callbacks
    show <id>                          Full contract for one
    search <query>                     Search everything
    platform                           Hosts, credentials, the endpoints you build
    gaps                               What Digimart does NOT publish, and where its docs disagree

  ${bold("BUILD — signed-URL charging (subscription, subscription-he, one-time)")}
    sign --example [flow]              The worked example's digest: the known answer to test against
    sign <flow> [apiKey=… requestTime=… amount=…]
                                       Signing string and signature (secret from DIGIMART_API_SECRET)
    url <flow> [redirectUrl=… amount=… msisdn=…]
                                       A complete authorize URL + the same thing as a shell recipe
    check-url '<url>'                  Check a URL you built; recomputes the signature if the secret is set
    redirect '<url or query>'          Read what Digimart appended to your redirectUrl

  ${bold("BUILD — REST (get-subscribers, subscriber-charging-info, unregistration)")}
    curl <id> [key=value ...]          Runnable request + parameter and response definitions
    validate <id> <json|@file|->       Check a REST body or a notification payload
    response <id> <json|@file|->       Read a real response against the contract

  ${bold("DEBUG")}
    code <statusCode>                  Decode a status code
    diagnose "<symptom>"               Most likely cause and fix

  ${bold("GUIDANCE")}
    practices [critical|high|medium]   Security and reliability rules
    checklist                          Go-live checklist
    reference [doc]                    Print a reference document

  ${bold("EXAMPLES")}
    ${dim("$")} node tools/digimart.mjs list
    ${dim("$")} node tools/digimart.mjs show one-time
    ${dim("$")} node tools/digimart.mjs sign --example one-time
    ${dim("$")} node tools/digimart.mjs url one-time amount=50 redirectUrl=https://shop.example/digimart/return
    ${dim("$")} node tools/digimart.mjs check-url 'https://user.digimart.store/sdk/subscription/caas-authorize?…'
    ${dim("$")} node tools/digimart.mjs redirect 'https://shop.example/digimart/return?subscriptionStatus=E3009&…'
    ${dim("$")} node tools/digimart.mjs curl unregistration subscriberId=tel:NTM3MDgz…
    ${dim("$")} node tools/digimart.mjs validate charging-notification @notification.json
    ${dim("$")} node tools/digimart.mjs code E1002
    ${dim("$")} node tools/digimart.mjs diagnose "one-time charge fails but subscription works"

  ${dim("Add --json to any command for machine-readable output. No network calls, ever.")}
  ${dim("sign / url / check-url read DIGIMART_API_SECRET from the environment if set; they never print it.")}
`);
}

/* ── Dispatch ────────────────────────────────────────────────────────────── */

const COMMANDS = {
  list: cmdList, ls: cmdList,
  show: cmdShow, get: cmdShow,
  search: cmdSearch, find: cmdSearch,
  platform: cmdPlatform, info: cmdPlatform,
  gaps: cmdGaps,
  sign: cmdSign,
  url: cmdUrl, build: cmdUrl,
  "check-url": cmdCheckUrl,
  redirect: cmdRedirect,
  curl: cmdCurl,
  validate: cmdValidate, check: cmdValidate,
  response: cmdResponse, read: cmdResponse,
  code: cmdCode, status: cmdCode,
  diagnose: cmdDiagnose, debug: cmdDiagnose,
  practices: cmdPractices,
  checklist: cmdChecklist,
  reference: cmdReference, docs: cmdReference,
  help: cmdHelp,
};

const handler = COMMANDS[command];
if (!command || command === "--help" || command === "-h") cmdHelp();
else if (!handler) fail(`Unknown command "${command}". Run \`digimart help\`.`, { commands: Object.keys(COMMANDS) });
else handler();
