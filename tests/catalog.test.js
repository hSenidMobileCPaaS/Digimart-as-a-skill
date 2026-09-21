import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
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
  newRequestId,
  readRedirect,
  readResponse,
  repoRoot,
  requestTimeNow,
  search,
  sign,
  signingString,
  successCodesFor,
  toShellRecipe,
  urlFor,
  validatePayload,
} from "../tools/catalog.mjs";

const sha512 = (s) => createHash("sha512").update(s, "utf8").digest("hex");
const read = (p) => readFileSync(join(repoRoot, p), "utf8");

/* ── The platform ────────────────────────────────────────────────────────── */

test("the catalog describes Digimart: hSenid Mobile, Grameenphone, Bangladesh, BDT", () => {
  assert.equal(catalog.platform.name, "Digimart");
  assert.equal(catalog.platform.operator, "hSenid Mobile Solutions");
  assert.equal(catalog.platform.network, "Grameenphone");
  assert.equal(catalog.platform.market, "Bangladesh");
  assert.equal(catalog.platform.currency, "BDT");
  assert.equal(catalog.platform.docs, "https://digimart.store/docs");
  assert.deepEqual(catalog.platform.chargingBand, {
    ...catalog.platform.chargingBand,
    min: 1,
    max: 600,
    currency: "BDT",
  });
});

test("the two surfaces live on two different hosts", () => {
  assert.equal(catalog.hosts.sdk, "https://user.digimart.store");
  assert.equal(catalog.hosts.rest, "https://api.digimart.store");
  for (const f of catalog.sdkFlows) assert.equal(f.host, "sdk", `${f.id} must be on the SDK host`);
  for (const s of catalog.services) assert.equal(s.host, "rest", `${s.id} must be on the REST host`);
});

test("the four credentials are split by surface, and only two are secret", () => {
  const byVar = Object.fromEntries(catalog.credentials.map((c) => [c.envVar, c]));
  assert.deepEqual(Object.keys(byVar).sort(), [
    "DIGIMART_API_KEY",
    "DIGIMART_API_SECRET",
    "DIGIMART_APP_ID",
    "DIGIMART_PASSWORD",
  ]);
  assert.equal(byVar.DIGIMART_API_SECRET.secret, true);
  assert.equal(byVar.DIGIMART_PASSWORD.secret, true);
  assert.equal(byVar.DIGIMART_API_KEY.secret, false);
  assert.equal(byVar.DIGIMART_API_SECRET.surface, "sdk");
  assert.equal(byVar.DIGIMART_PASSWORD.surface, "rest");
});

/* ── Nothing invented, nothing missing ───────────────────────────────────── */

/**
 * The published surface, exactly. A path that is not here is not a Digimart
 * API — the most likely way for one to appear is an agent (or a maintainer)
 * filling in a leftover OpenAPI tag from another hSenid platform.
 */
test("the surface is exactly what Digimart publishes", () => {
  assert.deepEqual(
    catalog.sdkFlows.map((f) => [f.id, f.path]),
    [
      ["subscription", "/sdk/subscription/authorize"],
      ["subscription-he", "/sdk/subscription/authorize"],
      ["one-time", "/sdk/subscription/caas-authorize"],
    ]
  );
  assert.deepEqual(
    catalog.services.map((s) => [s.id, s.method, s.path]),
    [
      ["get-subscribers", "POST", "/subscription-info-server/getSubscribers"],
      ["subscriber-charging-info", "POST", "/subscription/getSubscriberChargingInfo"],
      ["unregistration", "POST", "/subs/unregistration"],
    ]
  );
  assert.deepEqual(
    catalog.callbacks.map((c) => c.id),
    ["subscription-notification", "charging-notification", "redirect-return"]
  );
  assert.equal(findEntry("subscription-notification").specPath, "/subscription/notify");
});

test("no SMS, USSD, OTP, balance or direct-debit operation is presented as available", () => {
  const forbidden = /\/(sms|ussd|otp|lbs)\b|queryBalance|directDebit|direct\/debit/i;
  for (const e of allEntries()) {
    assert.doesNotMatch(e.path || e.specPath || "", forbidden, `${e.id} has an unpublished path`);
  }
  const notPublished = JSON.stringify(catalog.notPublished);
  for (const word of ["sms", "ussd", "otp", "queryBalance", "directDebit"]) {
    assert.match(notPublished, new RegExp(word, "i"), `notPublished does not record ${word}`);
  }
});

test("everything not published is recorded as such", () => {
  const items = catalog.notPublished.map((n) => n.item.toLowerCase()).join(" | ");
  for (const gap of ["server-to-server charge", "subscribing a user by rest", "refunds", "authentication of notifications", "response body", "sandbox host", "status codes"]) {
    assert.ok(items.includes(gap), `notPublished is missing "${gap}"`);
  }
});

test("every entry cites a digimart.store source", () => {
  for (const e of allEntries()) {
    assert.match(e.source || "", /^https:\/\/digimart\.store\//, `${e.id} has no digimart.store source`);
  }
  for (const s of catalog.sources) assert.match(s.url, /^https:\/\/digimart\.store\//);
});

test("the recorded discrepancies are all present and resolved", () => {
  assert.ok(catalog.discrepancies.length >= 17);
  const ids = catalog.discrepancies.map((d) => d.id);
  for (const id of ["hash-algorithm", "signing-order", "quickstart-redirect-json", "timezone-error-code", "dhaka-vs-utc", "tel-space", "subscribers-shape", "legacy-tags"]) {
    assert.ok(ids.includes(id), `missing discrepancy ${id}`);
  }
  for (const d of catalog.discrepancies) {
    assert.ok(d.where && d.issue && d.resolution, `${d.id} is incomplete`);
  }
});

/* ── Signing ─────────────────────────────────────────────────────────────── */

test("the worked-example digests are the SHA-512 of Digimart's worked examples", () => {
  for (const f of catalog.sdkFlows) {
    const ex = f.workedExample;
    assert.equal(ex.signingString, f.signingFields.map((k) => ex.values[k]).join("|"), `${f.id} worked example is not in field order`);
    assert.equal(sha512(ex.signingString), ex.digest, `${f.id} digest is wrong`);
    assert.equal(sign(f, ex.values), ex.digest);
  }
  // The published values themselves.
  assert.equal(findEntry("subscription").workedExample.signingString, "myApiKey123|2024-08-08T12:00:00Z|mySecretKey456");
  assert.equal(findEntry("one-time").workedExample.signingString, "myApiKey123|2024-08-08T12:00:00Z|mySecretKey456|50");
});

test("the secret sits in the middle, and only one-time signs the amount", () => {
  assert.deepEqual(findEntry("subscription").signingFields, ["apiKey", "requestTime", "apiSecret"]);
  assert.deepEqual(findEntry("subscription-he").signingFields, ["apiKey", "requestTime", "apiSecret"]);
  assert.deepEqual(findEntry("one-time").signingFields, ["apiKey", "requestTime", "apiSecret", "amount"]);

  const heAmount = findEntry("subscription-he").parameters.find((p) => p.name === "amount");
  assert.equal(heAmount.signed, false, "the header-enrichment amount is listed but not signed");
  const oneTimeAmount = findEntry("one-time").parameters.find((p) => p.name === "amount");
  assert.equal(oneTimeAmount.signed, true);
  assert.equal(findEntry("subscription").parameters.some((p) => p.name === "amount"), false);
});

test("every flow takes the published query parameters, and the secret is never one", () => {
  for (const f of catalog.sdkFlows) {
    const names = f.parameters.map((p) => p.name);
    for (const required of ["apiKey", "requestId", "requestTime", "signature", "redirectUrl"]) {
      assert.ok(names.includes(required), `${f.id} is missing ${required}`);
      assert.equal(f.parameters.find((p) => p.name === required).required, true);
    }
    assert.ok(names.includes("msisdn"));
    assert.equal(f.parameters.find((p) => p.name === "msisdn").required, false);
    assert.ok(!names.some((n) => /secret|password/i.test(n)), `${f.id} puts a secret in the URL`);
    assert.match(f.envVar, /^DIGIMART_[A-Z_]+_URL$/);
  }
});

test("requestTime and requestId generators produce the published shapes", () => {
  assert.match(requestTimeNow(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const ids = new Set();
  for (let i = 0; i < 500; i++) {
    const id = newRequestId();
    assert.match(id, /^[1-9]\d{14}$/);
    ids.add(id);
  }
  assert.equal(ids.size, 500, "requestIds collided");
});

test("a URL built and signed here passes its own check, and tampering is diagnosed", () => {
  const secret = "s3cr3t";
  const flow = findEntry("one-time");
  const built = buildAuthorizeUrl(flow, { apiKey: "key123", amount: "50", redirectUrl: "https://shop.example/r" }, { apiSecret: secret, perRequest: "fresh" });
  assert.ok(!built.url.includes(secret), "the secret leaked into the URL");
  assert.ok(built.signingString.includes("***"), "the returned signing string is not redacted");

  const ok = checkAuthorizeUrl(built.url, { apiSecret: secret });
  assert.equal(ok.valid, true, ok.errors.join("; "));
  assert.equal(ok.signatureCheck.matches, true);

  // Amount left out of the hash — the classic one-time mistake.
  const u = new URL(built.url);
  const threeField = sha512([u.searchParams.get("apiKey"), u.searchParams.get("requestTime"), secret].join("|"));
  u.searchParams.set("signature", threeField);
  const bad = checkAuthorizeUrl(u.toString(), { apiSecret: secret });
  assert.equal(bad.valid, false);
  assert.match(bad.signatureCheck.cause, /amount was left out/);

  // Secret and time swapped.
  const sub = buildAuthorizeUrl(findEntry("subscription"), { apiKey: "key123" }, { apiSecret: secret, perRequest: "fresh" });
  const s = new URL(sub.url);
  s.searchParams.set("signature", sha512([s.searchParams.get("apiKey"), secret, s.searchParams.get("requestTime")].join("|")));
  assert.match(checkAuthorizeUrl(s.toString(), { apiSecret: secret }).signatureCheck.cause, /swapped/);
});

test("check-url catches the malformed values that produce E1002/E1003/E1005/E1329/E1330", () => {
  const base = "https://user.digimart.store/sdk/subscription/caas-authorize";
  const good = {
    apiKey: "k",
    requestId: "123456789012345",
    requestTime: requestTimeNow(),
    signature: "a".repeat(128),
    redirectUrl: "https://shop.example/r",
    amount: "50",
  };
  const check = (overrides) => {
    const q = new URLSearchParams({ ...good, ...overrides });
    return checkAuthorizeUrl(`${base}?${q}`).errors.join(" | ");
  };
  assert.equal(check({}), "");
  assert.match(check({ requestId: "12345" }), /15 digits/);
  assert.match(check({ requestTime: "20240227113053" }), /E1003/);
  assert.match(check({ signature: "A".repeat(128) }), /uppercase/);
  assert.match(check({ signature: "a".repeat(64) }), /SHA-256/);
  assert.match(check({ amount: "700" }), /E1329/);
  assert.match(check({ amount: "0.5" }), /E1330/);
  assert.match(check({ amount: "৳50" }), /plain number/);
  assert.match(check({ apiSecret: "oops" }), /secret is in the query string/i);
  assert.match(
    checkAuthorizeUrl("https://user.digimart.store/sdk/sms/send?x=1").errors.join(" "),
    /not a Digimart SDK flow/
  );
});

test("the shell recipe signs the same fields in the same order", () => {
  const oneTime = toShellRecipe(findEntry("one-time"));
  assert.match(oneTime, /\$DIGIMART_API_KEY\|\$REQUEST_TIME\|\$DIGIMART_API_SECRET\|\$AMOUNT/);
  assert.match(oneTime, /amount=\$AMOUNT/);
  const sub = toShellRecipe(findEntry("subscription"));
  assert.match(sub, /"\$DIGIMART_API_KEY\|\$REQUEST_TIME\|\$DIGIMART_API_SECRET"/);
  assert.doesNotMatch(sub, /AMOUNT/);
  assert.equal(signingString(findEntry("one-time"), { apiKey: "a", requestTime: "t", apiSecret: "s", amount: "5" }, { redact: true }), "a|t|***|5");
});

/* ── REST ────────────────────────────────────────────────────────────────── */

test("every REST call authenticates with applicationId + password in the body", () => {
  for (const s of catalog.services) {
    for (const field of ["applicationId", "password"]) {
      const p = s.parameters.find((x) => x.name === field);
      assert.ok(p?.required, `${s.id}.${field} must be required`);
    }
    assert.ok(!s.parameters.some((p) => /signature|apiKey/.test(p.name)), `${s.id} uses SDK credentials`);
    assert.match(s.envVar, /^DIGIMART_[A-Z_]+_URL$/);
  }
});

test("the documented types survive: requestPage integer, action \"0\", subscriberId array on charging info", () => {
  const list = findEntry("get-subscribers");
  assert.equal(list.parameters.find((p) => p.name === "requestPage").type, "integer");
  assert.deepEqual(list.parameters.find((p) => p.name === "status").enum, ["REGISTERED", "TEMPORARY_BLOCKED", "REG_PENDING"]);
  assert.deepEqual(findEntry("unregistration").parameters.find((p) => p.name === "action").enum, ["0"]);
  assert.equal(findEntry("subscriber-charging-info").parameters.find((p) => p.name === "subscriberId").type, "string[]");
  assert.equal(findEntry("unregistration").parameters.find((p) => p.name === "subscriberId").type, "string");

  const coerced = coerceValues(list, { requestPage: "2" });
  assert.equal(coerced.requestPage, 2);
  assert.equal(coerceValues(findEntry("unregistration"), { action: "0" }).action, "0");
  assert.deepEqual(coerceValues(findEntry("subscriber-charging-info"), { subscriberId: "tel:a,tel:b" }).subscriberId, ["tel:a", "tel:b"]);
});

test("every published sample validates against its own contract", () => {
  for (const s of catalog.services) {
    const body = buildPayload(s, {}, { credentials: { applicationId: "APP_000001", password: "x" } });
    const result = validatePayload({ ...s, kind: "service" }, body);
    assert.equal(result.valid, true, `${s.id}: ${result.errors.join("; ")}`);
  }
  for (const c of catalog.callbacks.filter((x) => x.method === "POST")) {
    const result = validatePayload({ ...c, kind: "callback" }, c.samplePayload);
    assert.equal(result.valid, true, `${c.id}: ${result.errors.join("; ")}`);
  }
});

test("validation catches the REST mistakes that actually happen", () => {
  const unreg = { ...findEntry("unregistration"), kind: "service" };
  const creds = { applicationId: "APP_1", password: "p" };
  assert.match(validatePayload(unreg, { ...creds, subscriberId: "NTM3", action: "0" }).errors.join(), /tel:-prefixed/);
  assert.match(validatePayload(unreg, { ...creds, subscriberId: "tel:NTM3", action: 0 }).errors.join(), /STRING/);
  assert.match(validatePayload(unreg, { ...creds, subscriberId: "tel: NTM3", action: "0" }).warnings.join(), /space/);

  const info = { ...findEntry("subscriber-charging-info"), kind: "service" };
  assert.match(validatePayload(info, { ...creds, subscriberId: "tel:NTM3" }).errors.join(), /ARRAY/);

  const list = { ...findEntry("get-subscribers"), kind: "service" };
  assert.match(validatePayload(list, { ...creds, requestPage: "1" }).errors.join(), /STRING|integer/);
  assert.match(validatePayload(list, { ...creds, requestPage: 1, status: "ACTIVE" }).errors.join(), /one of/);
});

test("success is per call, and undocumented REST codes are never given a meaning", () => {
  assert.deepEqual(successCodesFor(findEntry("get-subscribers")), ["S1000", "S1001"]);
  assert.deepEqual(successCodesFor(findEntry("unregistration")), ["S1000"]);
  for (const code of ["S1001", "E1100", "E1102", "E1103", "E1104", "E1105", "E1106", "E1107"]) {
    const info = lookupStatusCode(code);
    assert.equal(info.published, false, `${code} must be marked unpublished`);
    assert.match(info.description, /no description/i);
    assert.deepEqual(info.surface, ["rest"]);
  }
});

test("reading REST responses: paging, object-shaped lists, per-entry failures, trimmed status", () => {
  const list = findEntry("get-subscribers");
  const page = readResponse(list, { statusCode: "S1000", moreDataAvailable: true, nextPageNumber: 3, subscribers: { subscriberId: "tel:x" } });
  assert.equal(page.ok, true);
  assert.match(page.nextSteps.join(), /requestPage 3/);
  assert.match(page.notes.join(), /single object/);
  assert.equal(readResponse(list, { statusCode: "S1001" }).ok, true);
  const bad = readResponse(list, { statusCode: "E1104", statusDetail: "whatever", requestId: "9" });
  assert.equal(bad.ok, false);
  assert.match(bad.nextSteps.join(), /publishes no meaning/);

  const info = readResponse(findEntry("subscriber-charging-info"), {
    statusCode: "S1000",
    destinationResponses: [{ subscriberId: "tel:a", statusCode: "E1234", statusDetail: "not found" }],
  });
  assert.equal(info.ok, true);
  assert.match(info.problems.join(), /E1234/);

  const unreg = readResponse(findEntry("unregistration"), { statusCode: "S1000", subscriptionStatus: "UNREGISTERED." });
  assert.match(unreg.nextSteps[0], /UNREGISTERED\. Update/);
});

/* ── Inbound ─────────────────────────────────────────────────────────────── */

test("every inbound surface has fields, a sample, a route, a dedupe key and where it is configured", () => {
  for (const c of catalog.callbacks) {
    assert.ok(c.fields?.length, `${c.id} has no fields`);
    assert.ok(c.samplePayload, `${c.id} has no sample`);
    assert.match(c.suggestedPath, /^\//);
    assert.ok(c.dedupeKey && c.configuredIn, `${c.id} is incomplete`);
    for (const f of c.fields.filter((x) => x.required)) {
      assert.ok(f.name in c.samplePayload, `${c.id}.${f.name} is required but not in the sample`);
    }
  }
  assert.equal(findEntry("charging-notification").payloadPublished, "sample-only");
  assert.equal(findEntry("redirect-return").method, "GET");
  assert.equal(findEntry("subscription-notification").dedupeKey, "subscriberId + status + timeStamp");
  assert.equal(findEntry("charging-notification").dedupeKey, "internalTrxId + statusCode");
});

test("each flow names the notification its documentation names", () => {
  assert.equal(findEntry("subscription").returns.notification, "subscription-notification");
  assert.equal(findEntry("subscription-he").returns.notification, "charging-notification");
  assert.equal(findEntry("one-time").returns.notification, "charging-notification");
});

test("the notification ack is not invented", () => {
  assert.equal(catalog.conventions.callbackAck.http, 200);
  assert.equal(catalog.conventions.callbackAck.body, "not published");
});

test("the redirect is read as untrusted query parameters carrying a code", () => {
  const ok = readRedirect("https://shop.example/r?subscriptionStatus=S1000&subscriberId=abc&requestId=123456789012345");
  assert.equal(ok.ok, true);
  assert.equal(ok.trusted, false);
  assert.match(ok.nextSteps.join(), /wait for the notification/);

  assert.match(readRedirect("subscriptionStatus=CHARGED&requestId=123456789012345").problems.join(), /status code/);
  assert.match(readRedirect("https://shop.example/r").problems.join(), /query parameters/);
  assert.equal(readRedirect("?subscriptionStatus=E3009&requestId=123456789012345").statusClass, "user-state");
});

test("a charging notification that failed or carries bad amounts is flagged", () => {
  const cb = { ...findEntry("charging-notification"), kind: "callback" };
  assert.match(validatePayload(cb, { ...cb.samplePayload, statusCode: "E3009" }).warnings.join(), /FAILED/);
  assert.match(validatePayload(cb, { ...cb.samplePayload, paidAmount: "fifty" }).errors.join(), /not a number/);
  const sub = { ...findEntry("subscription-notification"), kind: "callback" };
  const legacy = { ...sub.samplePayload };
  delete legacy.applicationId;
  legacy["123456789012100"] = "APP_000186";
  const r = validatePayload(sub, legacy);
  assert.match(r.errors.join(), /applicationId/);
  assert.match(r.warnings.join(), /tutorial sample/);
});

/* ── Status codes ────────────────────────────────────────────────────────── */

test("all 31 SDK codes are present with Digimart's wording", () => {
  const sdk = Object.entries(catalog.statusCodes).filter(([, v]) => v.surface.includes("sdk")).map(([k]) => k);
  assert.deepEqual(sdk.sort(), [
    "E1001", "E1002", "E1003", "E1004", "E1005", "E1006", "E1007", "E1008", "E1009", "E1010",
    "E1011", "E1012", "E1013", "E1014", "E1329", "E1330",
    "E2001", "E2002", "E2003", "E2004",
    "E3001", "E3002", "E3003", "E3004", "E3005", "E3006", "E3007", "E3008", "E3009",
    "E4001", "S1000",
  ]);
  assert.equal(catalog.statusCodes.E1002.description, "Invalid Signature");
  assert.equal(catalog.statusCodes.E1011.description, "SDK Is Not Enabled For This Application. Please Contact Administrator");
  assert.equal(catalog.statusCodes.E3009.description, "Your account balance is too low, recharge and try again");
  assert.equal(catalog.statusCodes.E1329.description, "Charging amount too high");
  assert.equal(catalog.statusCodes.E1330.description, "Charging amount too low");
});

test("every referenced status code exists and every class is defined", () => {
  for (const e of allEntries()) {
    for (const code of e.statusCodes || []) {
      assert.ok(catalog.statusCodes[code], `${e.id} references unknown code ${code}`);
    }
  }
  for (const [code, meta] of Object.entries(catalog.statusCodes)) {
    assert.ok(catalog.statusCodeClasses[meta.class], `${code} has unknown class ${meta.class}`);
    assert.ok(meta.surface?.length, `${code} has no surface`);
  }
});

test("an unknown code is never given a meaning", () => {
  const info = lookupStatusCode("E9876");
  assert.equal(info.known, false);
  assert.match(info.description, /Not in any code list Digimart publishes/);
});

/* ── Diagnosis and search ────────────────────────────────────────────────── */

test("diagnose recognises the common failures", () => {
  assert.match(diagnose("invalid signature on every request").fix, /sign --example/);
  assert.match(diagnose("one-time charge fails but subscription works").fix, /FOUR fields/);
  assert.match(diagnose("E1005 duplicate request id").cause, /reused/);
  assert.match(diagnose("time is six hours off").cause, /Dhaka/);
  assert.match(diagnose("customers get it without paying, we unlock on the redirect").fix, /notification/);
  assert.match(diagnose("how do I send an SMS").cause, /no SMS/);
  assert.equal(diagnose("E1013").matchedOn, "statusCode");
});

test("search finds flows by intent", () => {
  const ids = (q) => search(q).map((r) => r.id);
  assert.ok(ids("caas").includes("one-time"));
  assert.ok(ids("unsubscribe").includes("unregistration"));
  assert.ok(ids("header enrichment").includes("subscription-he"));
  assert.ok(ids("E3009").includes("E3009"));
});

/* ── Documents agree with the catalog ────────────────────────────────────── */

test("every reference the catalog points at exists", () => {
  const refs = new Set([
    ...allEntries().map((e) => e.reference),
    ...catalog.practices.map((p) => p.reference),
    ...catalog.platform.products.map((p) => p.reference),
    ...catalog.yourEndpoints.map((p) => p.reference),
  ]);
  for (const r of refs) assert.ok(existsSync(join(repoRoot, r)), `missing ${r}`);
});

test("the integration reference is generated from the catalog and in sync", () => {
  const out = execFileSync("node", ["scripts/build-integration-reference.mjs", "--check"], { cwd: repoRoot, encoding: "utf8" });
  assert.match(out, /in sync/);
  const doc = read("references/13-integration-reference.md");
  for (const e of allEntries()) {
    assert.ok(doc.includes(`## ${e.name}`), `integration reference has no section for ${e.id}`);
    for (const p of e.parameters || e.fields || []) {
      assert.ok(doc.includes(`\`${p.name}\``), `integration reference never defines ${e.id}.${p.name}`);
    }
    for (const f of e.responseFields || []) {
      assert.ok(doc.includes(`\`${f.name}\``), `integration reference never defines ${e.id} response ${f.name}`);
    }
  }
  for (const f of catalog.sdkFlows) assert.ok(doc.includes(f.workedExample.digest), `${f.id} digest missing`);
  assert.ok(!/"password":\s*"[A-Za-z0-9]{8,}"/.test(doc), "the integration reference contains a literal password");
});

test("the status-code reference lists every code", () => {
  const doc = read("references/07-status-codes.md");
  for (const code of Object.keys(catalog.statusCodes)) {
    assert.ok(doc.includes(`\`${code}\``), `07-status-codes.md does not list ${code}`);
  }
});

test("the discrepancy register lists every gap and disagreement", () => {
  const doc = read("references/12-source-discrepancies.md");
  for (const n of catalog.notPublished) assert.ok(doc.includes(n.item), `missing not-published item: ${n.item}`);
  for (const d of catalog.discrepancies) assert.ok(doc.includes(d.resolution.slice(0, 30).replace(/\|/g, "\\|")) || doc.includes(d.resolution.slice(0, 30)), `missing discrepancy ${d.id}`);
});

test("the go-live checklist is substantial and machine-readable", () => {
  const items = read("references/09-production-checklist.md").split("\n").filter((l) => l.trim().startsWith("- [ ]"));
  assert.ok(items.length >= 50, `only ${items.length} checklist items`);
});

test("urlFor puts each surface on its own host", () => {
  assert.equal(urlFor({ ...findEntry("one-time"), kind: "sdk-flow" }), "https://user.digimart.store/sdk/subscription/caas-authorize");
  assert.equal(urlFor({ ...findEntry("unregistration"), kind: "service" }), "https://api.digimart.store/subs/unregistration");
  assert.equal(urlFor({ ...findEntry("redirect-return"), kind: "callback" }), null);
});
