/**
 * Query library over catalog/digimart-api.json.
 *
 * Zero dependencies, Node 18+. Importable from your own code, and driven by
 * tools/digimart.mjs on the command line.
 *
 * This is the whole Digimart contract as structured data: the three signed-URL
 * charging flows, the three REST calls, the three things Digimart sends back
 * (two notifications and a browser redirect), every status code, every
 * practice, and every place the published sources disagree with themselves.
 */

import { readFileSync, existsSync } from "node:fs";
import { createHash, randomInt } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "..");

export const catalog = JSON.parse(
  readFileSync(join(repoRoot, "catalog", "digimart-api.json"), "utf8")
);

/** Every flow, service and callback in one list, tagged by kind. */
export function allEntries() {
  return [
    ...catalog.sdkFlows.map((f) => ({ ...f, kind: "sdk-flow" })),
    ...catalog.services.map((s) => ({ ...s, kind: "service" })),
    ...catalog.callbacks.map((c) => ({ ...c, kind: "callback" })),
  ];
}

/** Look up a flow, service or callback by id, name or alias. Case-insensitive. */
export function findEntry(idOrName) {
  const needle = String(idOrName || "").toLowerCase().trim();
  return (
    allEntries().find(
      (e) =>
        e.id.toLowerCase() === needle ||
        e.name.toLowerCase() === needle ||
        (e.aliases || []).some((a) => a.toLowerCase() === needle)
    ) || null
  );
}

/** Resolve the full URL for a flow (SDK host) or a service (REST host). */
export function urlFor(entry) {
  if (entry.kind === "callback") return null;
  const host = catalog.hosts[entry.host] || catalog.hosts.rest;
  return `${host.replace(/\/+$/, "")}${entry.path}`;
}

/** Decode a status code into meaning, class, retryability and the fix. */
export function lookupStatusCode(code) {
  const key = String(code || "").toUpperCase().trim();
  const entry = catalog.statusCodes[key];
  if (!entry) {
    const isSuccess = key.startsWith("S");
    return {
      code: key,
      known: false,
      published: false,
      class: isSuccess ? "undocumented-success" : "undocumented",
      description: `Not in any code list Digimart publishes. Treat it as ${
        isSuccess ? "a success-family code with no stated meaning" : "a failure"
      }, log statusDetail, and ask ${catalog.platform.support.email}.`,
      retry: false,
      action: "Quote the requestId (and internalTrxId, if you have one) to support.",
      surface: [],
      benignFor: [],
      affects: [],
    };
  }
  const cls = catalog.statusCodeClasses[entry.class] || {};
  return {
    code: key,
    known: true,
    published: entry.published !== false,
    class: entry.class,
    surface: entry.surface || [],
    description: entry.description,
    retry: cls.retry ?? false,
    action: entry.fix || cls.action,
    benignFor: entry.benignFor || [],
    affects: allEntries()
      .filter((e) => (e.statusCodes || []).includes(key))
      .map((e) => e.id),
  };
}

/** Read a reference document from the repo. */
export function readReference(name) {
  const safe = String(name || "").replace(/[^a-zA-Z0-9._-]/g, "");
  for (const path of [
    join(repoRoot, "references", safe),
    join(repoRoot, "references", `${safe}.md`),
  ]) {
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  return null;
}

/* ── Signing ─────────────────────────────────────────────────────────────── */

/**
 * The current instant as Digimart's requestTime: ISO 8601, UTC, milliseconds,
 * trailing Z — 2024-07-08T10:33:54.929Z. This is what every published code
 * sample produces. "Generate it in Asia/Dhaka" does not mean "write Dhaka
 * wall-clock time with a Z", which would be six hours wrong.
 */
export function requestTimeNow(date = new Date()) {
  return date.toISOString();
}

/**
 * A fresh 15-digit requestId with a non-zero first digit.
 *
 * Random rather than derived from the millisecond clock: the documentation's
 * quick samples pad Date.now() to 15 digits, which collides the moment two
 * requests land in the same millisecond, and a collision is E1005.
 */
export function newRequestId() {
  // randomInt spans at most 2^48, so draw the 15 digits in two halves.
  const head = randomInt(1_000_000, 10_000_000); // 7 digits, first one non-zero
  const tail = randomInt(0, 100_000_000); // 8 digits
  return `${head}${String(tail).padStart(8, "0")}`;
}

/**
 * The pipe-joined signing string for a flow.
 *
 * `values.apiSecret` may be omitted; it is then shown as <apiSecret>. With
 * `redact`, a supplied secret is replaced by *** so the string can be logged.
 */
export function signingString(flow, values = {}, { redact = false } = {}) {
  return flow.signingFields
    .map((field) => {
      if (field === "apiSecret") {
        if (values.apiSecret === undefined) return "<apiSecret>";
        return redact ? "***" : values.apiSecret;
      }
      return values[field] === undefined ? `<${field}>` : String(values[field]);
    })
    .join("|");
}

/** SHA-512 of the signing string, lowercase hex — the `signature` parameter. */
export function sign(flow, values) {
  const missing = flow.signingFields.filter((f) => values[f] === undefined || values[f] === "");
  if (missing.length) {
    throw new Error(`Cannot sign ${flow.id}: missing ${missing.join(", ")}`);
  }
  return createHash("sha512").update(signingString(flow, values), "utf8").digest("hex");
}

/** Hash an arbitrary string the way Digimart does. Used by the self-checks. */
export function sha512Hex(text) {
  return createHash("sha512").update(String(text), "utf8").digest("hex");
}

/**
 * Build the authorize URL for a flow.
 *
 * Parameters come out in the order the documentation lists them. The secret is
 * used for the hash and nowhere else: it is never a query parameter, and the
 * returned signingString is redacted.
 *
 * Without `options.apiSecret` the signature is left as the placeholder
 * `$SIGNATURE`, so the URL can be printed as a recipe without a credential.
 */
export function buildAuthorizeUrl(flow, values = {}, options = {}) {
  const { apiSecret, perRequest = "sample" } = options;
  const fresh = perRequest === "fresh";

  const resolved = {};
  for (const p of flow.parameters) {
    if (p.name === "signature") continue;
    if (values[p.name] !== undefined) resolved[p.name] = String(values[p.name]);
    else if (p.name === "apiKey") resolved.apiKey = "$DIGIMART_API_KEY";
    else if (p.name === "requestId") resolved.requestId = fresh ? newRequestId() : p.example;
    else if (p.name === "requestTime") resolved.requestTime = fresh ? requestTimeNow() : p.example;
    else if (p.required && p.example !== undefined) resolved[p.name] = String(p.example);
  }

  let signature = "$SIGNATURE";
  if (apiSecret) signature = sign(flow, { ...resolved, apiSecret });

  const query = new URLSearchParams();
  for (const p of flow.parameters) {
    if (p.name === "signature") query.set("signature", signature);
    else if (resolved[p.name] !== undefined) query.set(p.name, resolved[p.name]);
  }

  return {
    url: `${urlFor({ ...flow, kind: "sdk-flow" })}?${query.toString()}`,
    params: { ...resolved, signature },
    signingString: signingString(flow, { ...resolved, apiSecret }, { redact: true }),
    signed: Boolean(apiSecret),
  };
}

/**
 * A shell recipe that builds the same URL with nothing but POSIX shell and
 * openssl — the language-neutral equivalent of a curl for a REST call.
 *
 * Values are left un-encoded, as in Digimart's own sample URLs. A redirectUrl
 * with its own query string must be percent-encoded by hand.
 */
export function toShellRecipe(flow, values = {}) {
  const lines = ["# Values used in the hash AND the URL — built once, reused."];
  lines.push(`REQUEST_ID="$(date +%s)$(printf '%05d' $((RANDOM % 100000)))"   # 15 digits, fresh every time`);
  lines.push(`REQUEST_TIME="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"             # current instant, UTC, with Z`);
  if (flow.signingFields.includes("amount")) {
    lines.push(`AMOUNT='${values.amount ?? flow.parameters.find((p) => p.name === "amount")?.example ?? "10"}'`);
  }
  const redirect = values.redirectUrl ?? flow.parameters.find((p) => p.name === "redirectUrl")?.example;
  lines.push(`REDIRECT_URL='${redirect}'`);
  lines.push("");

  const shellVar = {
    apiKey: "$DIGIMART_API_KEY",
    requestTime: "$REQUEST_TIME",
    apiSecret: "$DIGIMART_API_SECRET",
    amount: "$AMOUNT",
  };
  const joined = flow.signingFields.map((f) => shellVar[f]).join("|");
  lines.push(`# ${flow.signingFields.join("|")}  ->  SHA-512  ->  lowercase hex`);
  lines.push(`SIGNATURE="$(printf '%s' "${joined}" \\`);
  lines.push(`  | openssl dgst -sha512 | awk '{print $NF}')"`);
  lines.push("");

  const query = [];
  for (const p of flow.parameters) {
    if (p.name === "apiKey") query.push("apiKey=$DIGIMART_API_KEY");
    else if (p.name === "requestId") query.push("requestId=$REQUEST_ID");
    else if (p.name === "requestTime") query.push("requestTime=$REQUEST_TIME");
    else if (p.name === "signature") query.push("signature=$SIGNATURE");
    else if (p.name === "redirectUrl") query.push("redirectUrl=$REDIRECT_URL");
    else if (p.name === "amount") query.push(flow.signingFields.includes("amount") ? "amount=$AMOUNT" : `amount=${values.amount ?? p.example}`);
    else if (values[p.name] !== undefined) query.push(`${p.name}=${values[p.name]}`);
  }
  lines.push(`URL="$${flow.envVar}?${query.join("&")}"`);
  lines.push(`echo "$URL"          # open it in a browser — this is a page, not an API`);
  return lines.join("\n");
}

/* ── Checking a built URL ────────────────────────────────────────────────── */

const RE_REQUEST_ID = /^\d{15}$/;
const RE_REQUEST_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const RE_SIGNATURE = /^[0-9a-f]{128}$/;

/**
 * Check a signed authorize URL against the contract of its flow.
 *
 * The SDK equivalent of validating a request body. Catches the mistakes that
 * actually produce E1002/E1003/E1005/E1009/E1329/E1330, and — when the secret is
 * available — recomputes the signature and says which signing string would have
 * produced the one in the URL.
 */
export function checkAuthorizeUrl(rawUrl, { apiSecret, now = new Date() } = {}) {
  const errors = [];
  const warnings = [];
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { valid: false, flow: null, errors: ["Not an absolute URL."], warnings, params: {} };
  }

  const params = Object.fromEntries(parsed.searchParams.entries());
  const hasAmount = params.amount !== undefined;
  const path = parsed.pathname.replace(/\/+$/, "");

  let flow = catalog.sdkFlows.find((f) => f.path === path && (f.id === "one-time" || !hasAmount));
  if (!flow && path === "/sdk/subscription/authorize") flow = catalog.sdkFlows.find((f) => f.id === "subscription-he");
  if (!flow) {
    errors.push(
      `Path ${parsed.pathname} is not a Digimart SDK flow. Subscriptions use /sdk/subscription/authorize; one-time charges use /sdk/subscription/caas-authorize.`
    );
    return { valid: false, flow: null, errors, warnings, params };
  }

  if (`${parsed.protocol}//${parsed.host}` !== catalog.hosts.sdk) {
    warnings.push(`Host is ${parsed.host}. The published SDK host is ${new URL(catalog.hosts.sdk).host}.`);
  }
  if (/apisecret|secret|password/i.test(Object.keys(params).join(" "))) {
    errors.push("A secret is in the query string. The API Secret is never sent — it only contributes to the hash. Rotate it now.");
  }

  for (const p of flow.parameters) {
    if (p.required && (params[p.name] === undefined || params[p.name] === "")) {
      if (p.name === "amount" && flow.id === "subscription-he") continue;
      errors.push(`Missing required parameter "${p.name}" — ${p.description}`);
    }
  }
  const known = new Set(flow.parameters.map((p) => p.name));
  for (const key of Object.keys(params)) {
    if (!known.has(key)) warnings.push(`Unrecognised parameter "${key}".`);
  }

  if (params.requestId !== undefined && !RE_REQUEST_ID.test(params.requestId)) {
    errors.push(`requestId must be exactly 15 digits, got ${JSON.stringify(params.requestId)} (${params.requestId.length} characters).`);
  }
  if (params.requestTime !== undefined) {
    if (!RE_REQUEST_TIME.test(params.requestTime)) {
      errors.push(
        `requestTime ${JSON.stringify(params.requestTime)} is not ISO 8601 UTC with a Z (e.g. 2024-07-08T10:33:54.929Z). Expect E1003.`
      );
    } else {
      const age = (now.getTime() - Date.parse(params.requestTime)) / 60000;
      if (Math.abs(age) > 10) {
        warnings.push(
          `requestTime is ${Math.round(Math.abs(age))} minutes ${age > 0 ? "in the past" : "in the future"}. A stale or skewed time is rejected with E1004 — build the URL at the moment of redirect, with an NTP-synced clock. (Six hours out usually means Dhaka wall-clock time was written with a Z.)`
        );
      }
      if (!params.requestTime.includes(".")) {
        warnings.push("requestTime has no milliseconds. The published format includes them (…54.929Z); the worked example omits them. Either hashes fine as long as the URL and the hash carry the same string.");
      }
    }
  }
  if (params.signature !== undefined) {
    if (/^[0-9A-F]{128}$/.test(params.signature)) {
      errors.push("signature is uppercase hex. Digimart expects lowercase — normalise it.");
    } else if (!RE_SIGNATURE.test(params.signature)) {
      errors.push(
        `signature must be 128 lowercase hex characters (SHA-512), got ${params.signature.length} characters.` +
          (params.signature.length === 64 ? " 64 characters is SHA-256 — use SHA-512." : "")
      );
    }
  }
  if (params.redirectUrl !== undefined) {
    try {
      const r = new URL(params.redirectUrl);
      if (r.protocol !== "https:") warnings.push("redirectUrl is not HTTPS.");
    } catch {
      errors.push(`redirectUrl ${JSON.stringify(params.redirectUrl)} is not an absolute URL.`);
    }
  }
  if (params.msisdn !== undefined && !/^\+?\d{10,13}$/.test(params.msisdn)) {
    errors.push(`msisdn ${JSON.stringify(params.msisdn)} is not a phone number. Expect E3008. The documented sample is 01748277168.`);
  }
  if (hasAmount) {
    const n = Number(params.amount);
    if (!/^\d+(\.\d+)?$/.test(params.amount) || !Number.isFinite(n)) {
      errors.push(`amount must be a plain number such as 10 — no currency, no separators. Got ${JSON.stringify(params.amount)}.`);
    } else if (flow.id === "one-time") {
      const { min, max } = catalog.platform.chargingBand;
      if (n < min) errors.push(`amount ${params.amount} is below the ${min} BDT floor. Expect E1330.`);
      if (n > max) errors.push(`amount ${params.amount} is above the ${max} BDT ceiling. Expect E1329.`);
    }
  }
  if (flow.id === "subscription-he") {
    warnings.push(
      "This is a subscription URL carrying amount, which matches the header-enrichment flow. The amount is NOT signed on a subscription; if your application does not have header enrichment enabled, drop it."
    );
  }

  let signatureCheck = null;
  if (apiSecret && params.signature && RE_SIGNATURE.test(params.signature)) {
    const values = { ...params, apiSecret };
    const expected = sign(flow, values);
    signatureCheck = { matches: expected === params.signature };
    if (!signatureCheck.matches) {
      // Say which mistake produced it, if it is one of the common ones.
      const three = sha512Hex([params.apiKey, params.requestTime, apiSecret].join("|"));
      const four = sha512Hex([params.apiKey, params.requestTime, apiSecret, params.amount].join("|"));
      const swapped = sha512Hex([params.apiKey, apiSecret, params.requestTime].join("|"));
      if (flow.id === "one-time" && params.signature === three) {
        signatureCheck.cause = "The amount was left out of the hash. One-time charges sign apiKey|requestTime|apiSecret|amount.";
      } else if (flow.id !== "one-time" && hasAmount && params.signature === four) {
        signatureCheck.cause = "The amount was signed on a subscription. Subscriptions sign apiKey|requestTime|apiSecret only.";
      } else if (params.signature === swapped) {
        signatureCheck.cause = "The secret and requestTime are swapped. The order is apiKey|requestTime|apiSecret.";
      } else {
        signatureCheck.cause =
          "Not one of the common mistakes. Check the requestTime and amount in the hash are byte-identical to the URL's, that no value was URL-encoded before hashing, and that the key and secret belong to the same application.";
      }
      errors.push(`Signature does not match. ${signatureCheck.cause} Expect E1002.`);
    }
  }

  return {
    valid: errors.length === 0,
    flow: flow.id,
    signingFields: flow.signingFields,
    params,
    signatureCheck,
    errors,
    warnings,
  };
}

/**
 * Read the query string Digimart appended to your redirectUrl.
 *
 * Accepts a full URL or a bare query string. This is the browser's view of the
 * outcome: useful for the screen you show, never for fulfilment.
 */
export function readRedirect(input) {
  let query = String(input || "").trim();
  if (/^[a-z]+:\/\//i.test(query)) query = new URL(query).search;
  const params = Object.fromEntries(new URLSearchParams(query.replace(/^\?/, "")).entries());
  const problems = [];
  const status = params.subscriptionStatus;

  if (!status) {
    problems.push(
      "No subscriptionStatus in the query string. Digimart returns the outcome as query parameters on your redirectUrl — subscriptionStatus, subscriberId, requestId — not as a JSON body."
    );
  }
  if (status && !/^[SE]\d{4}$/.test(status)) {
    problems.push(
      `subscriptionStatus is ${JSON.stringify(status)}. It carries a status code such as S1000 — not a word like REGISTERED or CHARGED (one quickstart sample shows CHARGED; the flow references and every sample URL use codes).`
    );
  }
  if (params.requestId !== undefined && !RE_REQUEST_ID.test(params.requestId)) {
    problems.push(`requestId ${JSON.stringify(params.requestId)} is not 15 digits — it is not one you issued.`);
  }

  const info = status ? lookupStatusCode(status) : null;
  const ok = status === "S1000";
  const nextSteps = [];
  if (ok) {
    nextSteps.push("Show 'payment received — confirming' and wait for the notification before granting anything.");
    nextSteps.push("Look requestId up in your own store; ignore it if you never issued it.");
    nextSteps.push("Record subscriberId against requestId as provisional; the notification confirms it.");
  } else if (info) {
    nextSteps.push(info.action);
    nextSteps.push("Show the user what to do next in plain words — never the raw code.");
  }

  return {
    ok,
    subscriptionStatus: status ?? null,
    statusClass: info?.class ?? null,
    description: info?.description ?? null,
    subscriberId: params.subscriberId ?? null,
    requestId: params.requestId ?? null,
    trusted: false,
    note: "Travelled through the subscriber's browser. Anyone can type this URL. Never fulfil on it.",
    problems,
    nextSteps,
  };
}

/* ── REST bodies ─────────────────────────────────────────────────────────── */

/**
 * Turn one `key=value` command-line argument into the value the wire expects.
 *
 * The declared type decides, not the shape of the text: `action=0` is the
 * string "0", `requestPage=2` is the integer 2, and a subscriberId list may be
 * typed as JSON or comma-separated.
 */
export function coerceValue(param, raw) {
  const asJson = () => {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  };
  switch (param?.type) {
    case "string":
    case "enum":
      return raw;
    case "integer":
    case "number": {
      const n = Number(raw);
      return raw.trim() !== "" && Number.isFinite(n) ? n : raw;
    }
    case "boolean":
      if (raw === "true") return true;
      if (raw === "false") return false;
      return raw;
    case "string[]": {
      const parsed = asJson();
      if (Array.isArray(parsed)) return parsed;
      return raw.split(",").map((s) => s.trim()).filter(Boolean);
    }
    default:
      return raw;
  }
}

/** Coerce a whole `key=value` argument list against an entry's contract. */
export function coerceValues(entry, pairs) {
  const values = {};
  for (const [key, raw] of Object.entries(pairs)) {
    const param = (entry.parameters || entry.fields || []).find((p) => p.name === key);
    values[key] = coerceValue(param, raw);
  }
  return values;
}

/**
 * Build a REST request body, with env placeholders for the credentials.
 *
 * Parameters come out in the declared order, credentials included, so the body
 * is the body the specification publishes, field for field. The credentials are
 * injected here and nowhere else, so nothing this tool prints carries one.
 */
export function buildPayload(service, values = {}, options = {}) {
  const { credentials = {} } = options;
  const payload = {};
  for (const p of service.parameters || []) {
    if (p.name === "applicationId") {
      payload.applicationId = credentials.applicationId || "$DIGIMART_APP_ID";
      continue;
    }
    if (p.name === "password") {
      payload.password = credentials.password || "$DIGIMART_PASSWORD";
      continue;
    }
    if (values[p.name] !== undefined) {
      payload[p.name] = values[p.name];
      continue;
    }
    const sample = service.sampleRequest?.[p.name];
    if (sample !== undefined) payload[p.name] = sample;
    else if (p.required) payload[p.name] = `<${p.name}>`;
  }
  return payload;
}

/** The codes that mean this call succeeded. Not a global constant. */
export function successCodesFor(entry) {
  if (entry?.successCodes?.length) return entry.successCodes;
  return ["S1000"];
}

const TEL_FIELDS = /^subscriberId$/;

/**
 * Validate a REST body, or a notification payload, against its contract.
 * Catches the mistakes that actually happen, not just missing fields.
 */
export function validatePayload(entry, payload) {
  const spec = entry.parameters || entry.fields || [];
  const errors = [];
  const warnings = [];
  const known = new Set(spec.map((p) => p.name));
  const outbound = entry.kind === "service" || entry.direction === "outbound";

  if (entry.kind === "sdk-flow") {
    return {
      valid: false,
      errors: [`${entry.id} is a signed URL, not a JSON body. Check a built URL with: digimart check-url '<url>'.`],
      warnings,
    };
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { valid: false, errors: ["The body must be a JSON object."], warnings };
  }

  for (const p of spec) {
    const value = payload[p.name];
    if (p.required && (value === undefined || value === null || value === "")) {
      errors.push(`Missing required field "${p.name}" — ${p.description}`);
      continue;
    }
    if (value === undefined) continue;

    if (typeof value === "string" && /^<.+>$/.test(value)) {
      errors.push(`"${p.name}" is still the placeholder ${value}. Fill it in.`);
      continue;
    }
    if ((p.type === "string" || p.type === "enum") && typeof value !== "string") {
      errors.push(
        `"${p.name}" must be a STRING on the wire, got ${typeof value} ${JSON.stringify(value)}. Quote it: ${JSON.stringify(String(value))}.`
      );
      continue;
    }
    if (p.enum && !p.enum.includes(value)) {
      errors.push(`"${p.name}" must be one of ${p.enum.join(" | ")}, got ${JSON.stringify(value)}`);
    }
    if (p.type === "integer" && !Number.isInteger(value)) {
      errors.push(
        `"${p.name}" must be an integer, got ${typeof value} ${JSON.stringify(value)}` +
          (typeof value === "string" ? " — send it as a JSON number, not a quoted string." : "")
      );
    }
    if (p.type === "string[]") {
      if (!Array.isArray(value)) {
        errors.push(`"${p.name}" must be an ARRAY of strings, even for one subscriber. Got ${typeof value}.`);
      } else if (value.some((v) => typeof v !== "string")) {
        errors.push(`"${p.name}" entries must all be strings.`);
      }
    }
    if (p.name === "requestPage" && Number.isInteger(value) && value < 1) {
      errors.push("requestPage must be 1 or greater.");
    }

    // Outbound REST calls address subscribers as tel:<msisdn>. Notifications
    // hand you the bare masked value — the prefix is yours to add.
    if (outbound && TEL_FIELDS.test(p.name)) {
      const list = Array.isArray(value) ? value : [value];
      for (const v of list) {
        if (typeof v !== "string") continue;
        if (!v.startsWith("tel:")) {
          errors.push(
            `subscriberId ${JSON.stringify(v.slice(0, 24) + (v.length > 24 ? "…" : ""))} must be tel:-prefixed. The value from the redirect or a notification has no prefix — add "tel:" in one helper.`
          );
        } else if (/^tel:\s/.test(v)) {
          warnings.push(
            'subscriberId has a space after "tel:". Some published examples do this; the unsubscription specification does not. Send "tel:<value>" with no space.'
          );
        }
      }
    }
  }

  for (const key of Object.keys(payload)) {
    if (!known.has(key)) warnings.push(`Unrecognised field "${key}".`);
  }
  if (entry.id === "charging-notification") {
    for (const f of ["totalAmount", "paidAmount", "balanceDue"]) {
      const v = payload[f];
      if (v !== undefined && Number.isNaN(Number(v))) {
        errors.push(`${f} ${JSON.stringify(v)} is not a number. Parse amounts as decimals.`);
      }
    }
    if (payload.statusCode && payload.statusCode !== "S1000") {
      warnings.push(`statusCode ${payload.statusCode}: this charge FAILED. Do not deliver.`);
    }
  }
  if (entry.id === "subscription-notification" && payload.applicationId === undefined) {
    const oddKey = Object.keys(payload).find((k) => /^\d{15}$/.test(k));
    if (oddKey) {
      warnings.push(
        `The application ID is under the key "${oddKey}" (the requestId), as in one old tutorial sample. The specification uses applicationId — tolerate this, log it, and ask support.`
      );
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Read an actual REST response body against the contract of the call that
 * produced it: success per endpoint, per-subscriber failures under a top-level
 * S1000, paging, and what to do next.
 */
export function readResponse(entry, body) {
  const successCodes = successCodesFor(entry);
  const messageField = entry.responseMessageField || "statusDetail";
  const notes = [];
  const problems = [];

  if (entry.kind !== "service") {
    return {
      service: entry.id,
      ok: false,
      statusCode: null,
      successCodes,
      messageField,
      message: null,
      notes: [],
      problems: [
        entry.kind === "sdk-flow"
          ? "SDK flows have no response body. Read the redirect with `digimart redirect '<url>'` and the notification with `digimart validate charging-notification '<json>'`."
          : "This is inbound — Digimart sends it to you. Check a payload with `digimart validate <id> '<json>'`.",
      ],
      nextSteps: [],
    };
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return {
      service: entry.id,
      ok: false,
      statusCode: null,
      successCodes,
      messageField,
      message: null,
      notes: [],
      problems: ["The response is not a JSON object."],
      nextSteps: [],
    };
  }

  const statusCode = body.statusCode ?? null;
  const info = statusCode ? lookupStatusCode(statusCode) : null;
  const ok = Boolean(statusCode) && successCodes.includes(statusCode);

  if (!statusCode) {
    problems.push("No statusCode in the body. The envelope, not the HTTP status, is the outcome.");
  }
  const message = body[messageField] ?? null;

  const missingFields = (entry.responseFields || [])
    .map((f) => f.name)
    .filter((name) => body[name] === undefined);
  if (ok && missingFields.length) {
    notes.push(`Documented fields absent from this response: ${missingFields.join(", ")}.`);
  }

  const perEntry = Array.isArray(body.destinationResponses) ? body.destinationResponses : [];
  for (const r of perEntry) {
    if (r?.statusCode && r.statusCode !== "S1000") {
      problems.push(
        `destinationResponses: ${String(r.subscriberId || "an entry").slice(0, 30)} came back ${r.statusCode} — ${r.statusDetail || "no detail"}`
      );
    }
  }

  const nextSteps = [];
  if (ok) {
    nextSteps.push(...(entry.responseHandling || []));
    if (entry.id === "get-subscribers") {
      if (body.subscribers && !Array.isArray(body.subscribers)) {
        notes.push("subscribers arrived as a single object. Normalise it to an array.");
      }
      if (body.moreDataAvailable === true && body.nextPageNumber !== -1) {
        nextSteps.unshift(`More pages: request requestPage ${body.nextPageNumber}.`);
      } else {
        nextSteps.unshift("Last page — stop paging.");
      }
      if (statusCode === "S1001") {
        notes.push("S1001 has no published meaning. It is S-prefixed, so it is not treated as an error here; statusDetail is the platform's own explanation.");
      }
    }
    if (entry.id === "unregistration" && body.subscriptionStatus) {
      const s = String(body.subscriptionStatus).replace(/[\s.]+$/, "");
      nextSteps.unshift(`Resulting subscriptionStatus: ${s}. Update your own store now.`);
    }
  } else if (info) {
    nextSteps.push(info.action);
    if (!info.published) {
      nextSteps.push(`Digimart publishes no meaning for ${statusCode}. statusDetail ("${message ?? "—"}") is the only explanation — quote requestId ${body.requestId ?? "(none)"} to ${catalog.platform.support.email}.`);
    }
  }

  return {
    service: entry.id,
    name: entry.name,
    ok,
    statusCode,
    statusClass: info?.class ?? null,
    known: info?.known ?? false,
    successCodes,
    messageField,
    message,
    description: info?.description ?? null,
    missingFields,
    notes,
    problems,
    nextSteps,
  };
}

/**
 * Render a REST call as a runnable curl command.
 *
 * The body goes in through an unquoted heredoc so $DIGIMART_APP_ID and
 * $DIGIMART_PASSWORD expand from the environment: the command runs as printed,
 * and no credential is ever written down.
 */
export function toCurl(service, payload, url) {
  return [
    `curl -sS -X POST "${url || `$${service.envVar}`}" \\`,
    `  -H 'Content-Type: application/json;charset=utf-8' \\`,
    `  --max-time 15 \\`,
    `  -d @- <<REQUEST`,
    JSON.stringify(payload, null, 2),
    `REQUEST`,
  ].join("\n");
}

/* ── Search and diagnosis ────────────────────────────────────────────────── */

/** Full-text search across flows, services, callbacks, codes and practices. */
export function search(query, limit = 20) {
  const needle = String(query || "").toLowerCase().trim();
  if (!needle) return [];
  const hit = (haystack, weight) => (String(haystack).toLowerCase().includes(needle) ? weight : 0);
  const results = [];

  for (const e of allEntries()) {
    const score =
      hit(e.id, 10) +
      hit(e.name, 8) +
      hit((e.aliases || []).join(" "), 8) +
      hit(e.path || e.suggestedPath || "", 6) +
      hit(e.summary, 4) +
      hit(JSON.stringify(e.parameters || e.fields || []), 2) +
      hit((e.rules || []).join(" "), 1);
    if (score) results.push({ type: e.kind, id: e.id, name: e.name, summary: e.summary, score });
  }
  for (const [code, meta] of Object.entries(catalog.statusCodes)) {
    const score = hit(code, 12) + hit(meta.description, 3);
    if (score) results.push({ type: "statusCode", id: code, name: code, summary: meta.description, score });
  }
  for (const p of catalog.practices) {
    const score = hit(p.id, 8) + hit(p.title, 6) + hit(p.detail, 2);
    if (score) results.push({ type: "practice", id: p.id, name: p.title, summary: p.detail, score });
  }
  for (const n of catalog.notPublished) {
    const score = hit(n.item, 6) + hit(n.detail, 2);
    if (score) results.push({ type: "notPublished", id: n.item, name: n.item, summary: n.detail, score });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Symptom signatures for the diagnose command. Order matters: specific first. */
export const SIGNATURES = [
  {
    when: /(invalid|bad|wrong|mismatch|reject).{0,20}signature|signature.{0,30}(invalid|fail|wrong|mismatch|reject)|e1002/,
    cause:
      "The signature Digimart rebuilt does not match yours. In practice: the wrong field order (it is apiKey|requestTime|apiSecret — the secret in the MIDDLE), the amount left out on a one-time charge, a requestTime or amount formatted once for the hash and again for the URL, spaces around the pipes, URL-encoded values hashed, uppercase hex, or SHA-256 instead of SHA-512.",
    fix: "Run `node tools/digimart.mjs sign --example one-time` and make your code produce the same digest from the same inputs. Then run `node tools/digimart.mjs check-url '<the URL you built>'` with DIGIMART_API_SECRET exported — it recomputes the signature and names the mistake. Build requestTime and amount into variables once and reuse them.",
  },
  {
    when: /one.?time.{0,40}(fail|e1002|signature)|caas.{0,40}(fail|e1002|signature)|subscription works.{0,40}(one.?time|caas)/,
    cause: "A subscription integration was copied to one-time charging without adding the amount to the signing string.",
    fix: "One-time charges sign FOUR fields: apiKey|requestTime|apiSecret|amount, and send amount as a query parameter too — the identical string in both places.",
  },
  {
    when: /e1005|already exists|duplicate request ?id|request ?id.{0,20}(reuse|used|collid)/,
    cause: "A requestId was reused — usually a retry that rebuilt the URL with the same id, or ids derived from the millisecond clock colliding under load.",
    fix: "Generate a fresh 15-digit requestId for every URL (random with a non-zero first digit, or a database sequence), persist it before redirecting, and never retry with it.",
  },
  {
    when: /e1003|e1004|time.?format|timeout|request ?time|clock|dhaka|timezone|time zone|six hours|6 hours/,
    cause:
      "requestTime is malformed (E1003) or too far from Digimart's clock (E1004). Common causes: Dhaka wall-clock time written with a Z (six hours out), a URL built earlier and cached, a drifting server clock, or a format without the T and Z.",
    fix: "Use the current instant in ISO 8601 UTC with a Z — 2024-07-08T10:33:54.929Z — exactly what new Date().toISOString(), Instant.now() or gmdate('Y-m-d\\TH:i:s.v\\Z') produce. Keep the clock NTP-synced and build the URL at the moment you redirect.",
  },
  {
    when: /(never|not|n[o']t|missing|no).{0,40}(notif|callback|webhook)|(notif|callback|webhook).{0,40}(never|not|n[o']t|missing|arriv)/,
    cause:
      "The notification URL on the application is wrong, unreachable, not HTTPS with a complete certificate chain, behind auth or a WAF challenge, or your handler is not answering HTTP 200. Remember the flows notify different fields: the subscription flow posts to the Subscription Notification URL; one-time charges and header-enrichment subscriptions post to the Async charging resp URL.",
    fix: "Check both URLs on the application in the portal; confirm they are public HTTPS and answer 200 to `./scripts/test-callbacks.sh https://your-host`. Exempt them from CSRF and session auth. Catch up on missed subscription changes with POST /subscription-info-server/getSubscribers.",
  },
  {
    when: /deliver.{0,40}(unpaid|without pay|free)|(got|get|gets|getting).{0,30}(for free|without pay)|without paying|fraud|forg|fake.{0,20}(redirect|success)|redirect.{0,40}(grant|unlock|deliver|fulfil)|(grant|unlock|deliver|fulfil).{0,40}redirect/,
    cause: "Access is being granted on the browser redirect. It travels through the subscriber's browser and anyone can type ?subscriptionStatus=S1000 onto your redirectUrl.",
    fix: "Fulfil only on the notification (statusCode S1000 on the Async charging resp URL for a charge, the Subscription Notification for a subscription), matched to a requestId you issued. Use the redirect only to pick the screen.",
  },
  {
    when: /e3009|balance|recharge|insufficient|no credit/,
    cause: "The subscriber does not have enough mobile balance. Not a bug — it is the most common production failure on Digimart.",
    fix: "Show a friendly 'please recharge and try again' screen with a retry that builds a NEW URL, and consider offering a cheaper tier.",
  },
  {
    when: /e3005|whitelist|sandbox.{0,40}(number|fail)|test number/,
    cause: "The number is not allowed to transact with the application yet — common in sandbox before approval.",
    fix: "Test with a number your application allows, and ask support@digimart.store to whitelist test numbers until the app is approved.",
  },
  {
    when: /e1011|sdk.{0,20}not enabled|e1008|not allowed for the application|e1006|invalid api key|e1007|unauthori[sz]ed|e1010/,
    cause: "A configuration problem on the application, not in your code: the SDK or CaaS is not enabled, the app is not approved, or the API Key belongs to another app or environment.",
    fix: "Check the application in the portal: CaaS API enabled, charging details complete, approved by an administrator, and the API Key copied from THIS app. Contact support@digimart.store for E1010/E1011.",
  },
  {
    when: /e1329|e1330|amount.{0,20}(too high|too low|limit|band|max|min)|600/,
    cause: "The one-time amount is outside the 1 to 600 BDT band.",
    fix: "Charge between 1 and 600 BDT. The amount must also be in the signing string and the URL, identically.",
  },
  {
    when: /e3001|already registered|already subscribed/,
    cause: "The subscriber already has an active subscription to this application.",
    fix: "Treat it as 'already subscribed', not an error. Check with POST /subscription/getSubscriberChargingInfo before starting a new opt-in.",
  },
  {
    when: /unsubscri|cancel|unregist/,
    cause: "Cancellation is not an SDK flow. It is the REST call POST /subs/unregistration on api.digimart.store, authenticated with applicationId and the App Password — not the API Key and signature.",
    fix: "Call /subs/unregistration from your server with subscriberId as a single tel:<masked value> string and action \"0\". Run `node tools/digimart.mjs curl unregistration subscriberId=tel:…` to see the exact call.",
  },
  {
    when: /which (host|url|base)|wrong host|api\.digimart|user\.digimart|404/,
    cause: "The two surfaces are on different hosts: SDK flows on user.digimart.store (a browser page), REST on api.digimart.store (JSON POST).",
    fix: "One endpoint variable per service, from templates/.env.example. Never a shared base URL.",
  },
  {
    when: /subscriberid.{0,40}(tel|prefix|format)|tel:.{0,30}(space|prefix)/,
    cause: "The subscriberId from the redirect and the notifications has no tel: prefix; the REST calls want tel:<value>.",
    fix: "Add \"tel:\" in one helper, with no space after the colon, and send the masked value unchanged.",
  },
  {
    when: /sms|ussd|otp api|query ?balance|direct ?debit|send (an )?sms/,
    cause: "Digimart publishes no SMS, USSD, OTP, balance or direct-debit API. The OpenAPI file carries leftover tag descriptions for them with no paths.",
    fix: "Use the SDK flows for charging (Digimart sends the OTP itself) and the three REST calls for subscriber management. Do not borrow endpoints from mSpace, Ideamart or Applink.",
  },
  {
    when: /certificate|tls|ssl|self.?signed|unable to verify/,
    cause: "The certificate chain presented to your client is incomplete, which strict clients reject.",
    fix: "Supply the missing intermediate CA. Do NOT disable verification — that exposes the App Password.",
  },
];

/** Diagnose from a status code or a plain-language symptom. */
export function diagnose(symptom) {
  const text = String(symptom);
  const s = text.toLowerCase();
  const sig = SIGNATURES.find((x) => x.when.test(s));
  const codeMatch = text.match(/\b([SE]\d{4})\b/i);

  if (codeMatch && (!sig || !new RegExp(codeMatch[1], "i").test(sig.when.source))) {
    return { matchedOn: "statusCode", ...lookupStatusCode(codeMatch[1]) };
  }
  if (sig) return { matchedOn: "symptom", symptom: text, cause: sig.cause, fix: sig.fix };
  if (codeMatch) return { matchedOn: "statusCode", ...lookupStatusCode(codeMatch[1]) };

  return {
    matchedOn: "none",
    symptom: text,
    suggestion: "Try `digimart search <keyword>`, or look up the code from the redirect or the response body.",
    searchResults: search(text, 5),
  };
}
