import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../tools/catalog.mjs";

const read = (p) => readFileSync(join(repoRoot, p), "utf8");
const readJson = (p) => JSON.parse(read(p));

/* ── Manifests ───────────────────────────────────────────────────────────── */

const MANIFESTS = [
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  ".codex-plugin/plugin.json",
  ".qoder-plugin/plugin.json",
  "gemini-extension.json",
  "opencode.json",
  "package.json",
];

test("every manifest is valid JSON", () => {
  for (const m of MANIFESTS) assert.doesNotThrow(() => readJson(m), `${m} is not valid JSON`);
});

test("plugin manifests agree on name and version", () => {
  const version = readJson("package.json").version;
  for (const m of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", ".qoder-plugin/plugin.json", "gemini-extension.json"]) {
    const manifest = readJson(m);
    assert.equal(manifest.name, "digimart", `${m} has the wrong name`);
    assert.equal(manifest.version, version, `${m} version drifted from package.json`);
  }
  assert.match(read("plugin.yaml"), new RegExp(`^version: ${version.replace(/\./g, "\\.")}$`, "m"));
});

test("plugin.yaml lists every skill that exists on disk", () => {
  const yaml = read("plugin.yaml");
  for (const skill of readdirSync(join(repoRoot, "skills"))) {
    assert.ok(yaml.includes(`- ${skill}`), `plugin.yaml does not list skill "${skill}"`);
  }
});

/* ── Skills and commands ─────────────────────────────────────────────────── */

test("every skill has valid frontmatter with a name matching its directory", () => {
  const dirs = readdirSync(join(repoRoot, "skills"));
  assert.ok(dirs.length >= 7, `expected at least 7 skills, found ${dirs.length}`);
  for (const dir of dirs) {
    const path = `skills/${dir}/SKILL.md`;
    assert.ok(existsSync(join(repoRoot, path)), `${dir} has no SKILL.md`);
    const fm = read(path).replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---/);
    assert.ok(fm, `${path} has no frontmatter`);
    const name = fm[1].match(/^name:\s*(.+)$/m);
    const description = fm[1].match(/^description:\s*(.+)$/m);
    assert.equal(name?.[1].trim(), dir, `${path} name does not match its directory`);
    assert.ok(description && description[1].trim().length > 40, `${path} description is too short to route on`);
  }
});

test("the root SKILL.md has frontmatter that routes on Digimart", () => {
  const fm = read("SKILL.md").match(/^---\n([\s\S]*?)\n---/);
  assert.ok(fm, "SKILL.md has no frontmatter");
  assert.match(fm[1], /^name:\s*digimart\s*$/m);
  for (const word of ["Digimart", "Grameenphone", "signed", "caas-authorize", "api.digimart.store"]) {
    assert.ok(fm[1].includes(word), `SKILL.md description does not mention ${word}`);
  }
});

test("every skill has a matching slash command", () => {
  for (const skill of readdirSync(join(repoRoot, "skills"))) {
    const path = `commands/${skill}.toml`;
    assert.ok(existsSync(join(repoRoot, path)), `missing command for skill "${skill}"`);
    const content = read(path);
    assert.match(content, /^description = ".+"$/m, `${path} has no description`);
    assert.match(content, /^prompt = ".+"$/m, `${path} has no prompt`);
  }
});

/* ── Agent rule copies ───────────────────────────────────────────────────── */

test("agent rule copies are in sync with AGENTS.md", () => {
  const out = execFileSync("node", ["scripts/sync-rules.mjs", "--check"], { cwd: repoRoot, encoding: "utf8" });
  assert.match(out, /in sync/);
});

test("every generated rule copy exists and carries the banner", () => {
  for (const copy of [
    ".agents/rules/digimart.md",
    ".windsurf/rules/digimart.md",
    ".clinerules/digimart.md",
    ".kiro/steering/digimart.md",
    ".qoder/rules/digimart.md",
    ".cursor/rules/digimart.mdc",
    ".github/copilot-instructions.md",
  ]) {
    assert.ok(existsSync(join(repoRoot, copy)), `missing ${copy}`);
    assert.match(read(copy), /Generated from AGENTS\.md/, `${copy} has no generated banner`);
  }
  assert.match(read(".cursor/rules/digimart.mdc"), /^---\ndescription:.*\n[\s\S]*?\n---/);
});

/* ── The entry points carry the facts that matter ────────────────────────── */

test("SKILL.md and AGENTS.md state the rules an agent most often gets wrong", () => {
  for (const file of ["SKILL.md", "AGENTS.md"]) {
    const doc = read(file);
    assert.match(doc, /signed URLs?, not REST/i, `${file} does not say charging is a signed URL`);
    assert.ok(doc.includes("apiKey|requestTime|apiSecret"), `${file} does not give the signing order`);
    assert.match(doc, /\|amount/, `${file} does not say the amount is signed on one-time`);
    assert.match(doc, /notification, never (on )?the redirect/i, `${file} does not forbid fulfilment on the redirect`);
    assert.ok(doc.includes("user.digimart.store") && doc.includes("api.digimart.store"), `${file} does not separate the hosts`);
    assert.match(doc, /\/subs\/unregistration/, `${file} does not name the cancel call`);
    assert.match(doc, /mSpace, Ideamart or Applink/, `${file} does not warn against borrowing endpoints`);
  }
});

/* ── Templates: the skill must not be Node-only ──────────────────────────── */

const TEMPLATE_LANGUAGES = {
  typescript: ["digimart-config.ts", "digimart-client.ts", "digimart-routes-express.ts"],
  python: ["digimart_config.py", "digimart_client.py", "callbacks_fastapi.py"],
  java: ["DigimartConfig.java", "DigimartClient.java", "DigimartController.java"],
  go: ["config.go", "client.go", "callbacks.go"],
  php: ["DigimartConfig.php", "DigimartClient.php", "callbacks.php"],
  csharp: ["DigimartOptions.cs", "DigimartClient.cs", "DigimartEndpoints.cs"],
};

test("every documented language ships config, client and handler templates", () => {
  for (const [language, files] of Object.entries(TEMPLATE_LANGUAGES)) {
    for (const file of files) {
      assert.ok(existsSync(join(repoRoot, "templates", language, file)), `missing templates/${language}/${file}`);
    }
  }
});

test("no template directory is missing from the templates index", () => {
  const index = read("templates/README.md");
  const onDisk = readdirSync(join(repoRoot, "templates"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  assert.ok(onDisk.length >= 6);
  for (const language of onDisk) assert.ok(index.includes(`${language}/`), `templates/README.md does not list ${language}/`);
  assert.deepEqual(onDisk.sort(), Object.keys(TEMPLATE_LANGUAGES).sort());
});

test("the entry points and the any-stack spec agree on the languages", () => {
  for (const file of ["references/10-any-stack.md", "templates/README.md", "SKILL.md", "AGENTS.md"]) {
    const content = read(file);
    for (const language of ["Python", "Java", "Go", "PHP"]) {
      assert.ok(content.includes(language), `${file} does not mention ${language}`);
    }
  }
});

test("every language template reads the same environment variables", () => {
  const env = read("templates/.env.example");
  const variables = [
    "DIGIMART_APP_ID",
    "DIGIMART_API_KEY",
    "DIGIMART_API_SECRET",
    "DIGIMART_REDIRECT_URL",
    "DIGIMART_PASSWORD",
    "DIGIMART_SUBSCRIPTION_AUTHORIZE_URL",
    "DIGIMART_CAAS_AUTHORIZE_URL",
    "DIGIMART_GET_SUBSCRIBERS_URL",
    "DIGIMART_CHARGING_INFO_URL",
    "DIGIMART_UNREGISTRATION_URL",
  ];
  for (const v of variables) assert.ok(env.includes(v), `.env.example does not define ${v}`);
  for (const [language, files] of Object.entries(TEMPLATE_LANGUAGES)) {
    const config = read(join("templates", language, files[0]));
    for (const v of variables) assert.ok(config.includes(v), `templates/${language}/${files[0]} does not read ${v}`);
  }
});

/**
 * The facts a port cannot get away with dropping: the signing order, the
 * amount in the one-time hash, S1001 on the subscriber list, the "0" action,
 * and a known answer to test the hashing against.
 */
test("every language client signs, classifies and calls the REST APIs the same way", () => {
  const digest = "3badf638ceca499000fd07b899e5fc0cec348d9762886b8430104291126683892845a208caef8e99b53432571e46c5f04162a1a25646443f7935239ea0901b38";
  for (const [language, files] of Object.entries(TEMPLATE_LANGUAGES)) {
    const client = read(join("templates", language, files[1]));
    const where = `templates/${language}/${files[1]}`;
    assert.ok(client.includes(digest), `${where} does not document the worked-example digest`);
    assert.ok(client.includes("apiKey|requestTime|apiSecret"), `${where} does not state the signing order`);
    assert.match(client, /sha512|SHA-512|SHA512/i, `${where} does not use SHA-512`);
    assert.ok(client.includes("S1001"), `${where} does not accept S1001 on the subscriber list`);
    assert.match(client, /"0"|'0'/, `${where} does not send action as the string "0"`);
    assert.ok(client.includes("tel:"), `${where} has no tel: helper`);
    assert.ok(client.includes("600"), `${where} does not enforce the 1-600 BDT band`);
    for (const code of ["E1006", "E1011", "E3009"]) assert.ok(client.includes(code), `${where} does not classify ${code}`);
  }
});

test("every language's handlers settle on the notification and never on the redirect", () => {
  for (const [language, files] of Object.entries(TEMPLATE_LANGUAGES)) {
    const handlers = read(join("templates", language, files[2]));
    const where = `templates/${language}/${files[2]}`;
    for (const route of ["/digimart/checkout", "/digimart/return", "/api/digimart/charging/notify", "/api/digimart/subscription/notify", "/digimart/unsubscribe"]) {
      assert.ok(handlers.includes(route), `${where} has no ${route}`);
    }
    assert.match(handlers, /paidAmount/, `${where} does not compare paidAmount`);
    assert.match(handlers, /balanceDue/, `${where} does not read balanceDue`);
    assert.match(handlers, /internalTrxId/, `${where} does not dedupe on internalTrxId`);
    assert.match(handlers, /subscriberRequestId/, `${where} does not map subscriberRequestId`);
    assert.match(handlers, /grants? nothing/i, `${where} does not state the redirect grants nothing`);
    assert.match(handlers, /PRICE_LIST|PriceList/, `${where} does not price on the server`);
  }
});

test("no template disables TLS verification", () => {
  const forbidden = [
    /rejectUnauthorized:\s*false/,
    /verify\s*=\s*False/,
    /InsecureSkipVerify:\s*true/,
    /CURLOPT_SSL_VERIFYPEER\s*=>\s*false/,
    /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*0/,
    /ServerCertificateCustomValidationCallback\s*=.*true/,
  ];
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      for (const line of readFileSync(path, "utf8").split("\n")) {
        const code = line.replace(/^\s*(\/\/|#|\*|\/\*).*/, "");
        if (forbidden.some((p) => p.test(code))) offenders.push(`${path.replace(repoRoot, ".")}: ${line.trim()}`);
      }
    }
  };
  walk(join(repoRoot, "templates"));
  assert.deepEqual(offenders, [], `templates disable TLS verification:\n${offenders.join("\n")}`);
});

test("no template exposes a Digimart secret to a client bundle", () => {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
  for (const file of walk(join(repoRoot, "templates"))) {
    const content = readFileSync(file, "utf8");
    assert.doesNotMatch(content, /(NEXT_PUBLIC|VITE|REACT_APP|EXPO_PUBLIC)_DIGIMART/, `${file} uses a browser-exposed prefix`);
  }
});

/* ── Governance and assets ───────────────────────────────────────────────── */

test("governance files exist", () => {
  for (const f of ["LICENSE", "README.md", "CONTRIBUTING.md", "SECURITY.md", "CLAUDE.md", "docs/agent-support.md"]) {
    assert.ok(existsSync(join(repoRoot, f)), `missing ${f}`);
  }
});

test("the project forbids AI co-author trailers on commits", () => {
  assert.match(read("CLAUDE.md"), /Never add a `Co-Authored-By` trailer/);
});

test("SVG assets are well-formed and labelled", () => {
  for (const f of ["assets/architecture.svg", "assets/social-preview.svg"]) {
    const svg = read(f);
    assert.match(svg, /^<svg[\s>]/m);
    assert.match(svg, /<\/svg>\s*$/);
    assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(svg, /role="img"|aria-label=/);
  }
});

test("brand logos are present as transparent PNGs", () => {
  for (const f of ["assets/digimart-logo.png", "assets/hsenid-logo.png"]) {
    const buf = readFileSync(join(repoRoot, f));
    assert.equal(buf.readUInt32BE(0), 0x89504e47, `${f} is not a PNG`);
    assert.equal(buf[25], 6, `${f} has no alpha channel`);
  }
});

const REPO = "hSenidMobileCPaaS/Digimart-as-a-skill";

test("manifests point at the published repository", () => {
  assert.equal(readJson("package.json").homepage, `https://github.com/${REPO}`);
  assert.equal(readJson("package.json").repository.url, `git+https://github.com/${REPO}.git`);
  assert.equal(readJson("package.json").bugs.url, `https://github.com/${REPO}/issues`);
  assert.equal(readJson(".claude-plugin/plugin.json").homepage, `https://github.com/${REPO}`);
  assert.equal(readJson(".codex-plugin/plugin.json").repository, `https://github.com/${REPO}`);
  for (const f of ["README.md", "docs/agent-support.md", ".github/ISSUE_TEMPLATE/config.yml"]) {
    assert.doesNotMatch(read(f), /OWNER\/|<repo-url>|mSpace-as-a-skill/, `${f} has a placeholder or wrong repository`);
  }
});

test("nothing still describes mSpace, Mobitel or Sri Lanka as this platform", () => {
  const files = [
    "README.md", "SKILL.md", "AGENTS.md", "SECURITY.md", "CONTRIBUTING.md", "LICENSE", "docs/agent-support.md",
    "package.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json", "templates/README.md", "templates/.env.example",
    ...readdirSync(join(repoRoot, "references")).map((f) => `references/${f}`),
    ...readdirSync(join(repoRoot, "skills")).map((d) => `skills/${d}/SKILL.md`),
  ];
  for (const f of files) {
    const content = read(f);
    assert.doesNotMatch(content, /Mobitel|Sri Lanka|api\.mspace\.lk|MSPACE_|\bLKR\b/, `${f} still refers to mSpace's platform`);
  }
});

test("the licence is proprietary and declared consistently everywhere", () => {
  const licence = read("LICENSE");
  assert.match(licence, /^PROPRIETARY SOFTWARE LICENCE/m);
  assert.match(licence, /All rights reserved/);
  assert.match(licence, /sole\s+and\s+exclusive property of hSenid Mobile Solutions/);
  assert.match(licence, /your own Digimart\s+integrations/);
  for (const restriction of [/modify/i, /distribut/i, /publish/i, /sublicense/i, /sell/i, /copy/i]) {
    assert.match(licence, restriction);
  }
  assert.match(licence, /copying strictly necessary/i);
  assert.equal(readJson("package.json").license, "UNLICENSED");
  assert.equal(readJson("package.json").private, true);
  assert.equal(readJson(".claude-plugin/plugin.json").license, "UNLICENSED");
  assert.equal(readJson(".codex-plugin/plugin.json").license, "UNLICENSED");
  for (const f of ["README.md", "SECURITY.md", "CONTRIBUTING.md", "plugin.yaml"]) {
    assert.doesNotMatch(read(f), /\bMIT\b/, `${f} refers to MIT`);
  }
});

test("attribution names hSenid Mobile Solutions for Digimart", () => {
  assert.match(read("LICENSE"), /hSenid Mobile Solutions \(Pvt\) Ltd/);
  assert.match(read("README.md"), /hSenid Mobile Solutions<\/strong> for <strong>Digimart/);
  for (const m of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", "package.json"]) {
    assert.equal(readJson(m).author.name, "hSenid Mobile Solutions");
  }
  assert.equal(readJson(".claude-plugin/marketplace.json").owner.name, "hSenid Mobile Solutions");
});

test("every asset and relative link in the README exists", () => {
  const readme = read("README.md");
  for (const [, src] of readme.matchAll(/(?:src|srcset)="(assets\/[^"]+)"/g)) {
    assert.ok(existsSync(join(repoRoot, src)), `README references missing asset ${src}`);
  }
  const missing = [];
  for (const [, target] of readme.matchAll(/\]\((?!https?:|#)([^)]+)\)/g)) {
    const clean = target.split("#")[0];
    if (clean && !existsSync(join(repoRoot, clean))) missing.push(clean);
  }
  assert.deepEqual(missing, []);
});

test("every relative link in the references and skills points at something real", () => {
  const docs = [
    ...readdirSync(join(repoRoot, "references")).map((f) => ["references", f]),
    ["templates", "README.md"],
    [".", "SKILL.md"],
    [".", "AGENTS.md"],
  ];
  const missing = [];
  for (const [dir, file] of docs) {
    const content = read(join(dir, file));
    for (const [, target] of content.matchAll(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g)) {
      const clean = target.split("#")[0];
      if (clean && !existsSync(join(repoRoot, dir, clean))) missing.push(`${dir}/${file} → ${clean}`);
    }
  }
  assert.deepEqual(missing, []);
});

/* ── CLI ─────────────────────────────────────────────────────────────────── */

const cli = (args, env = {}) =>
  execFileSync("node", ["tools/digimart.mjs", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, DIGIMART_API_SECRET: "", DIGIMART_API_KEY: "", ...env },
  });

test("the CLI responds to every documented command", () => {
  for (const args of [
    ["help"],
    ["list", "--json"],
    ["list", "--direction=inbound", "--json"],
    ["show", "one-time", "--json"],
    ["show", "charging-notification", "--json"],
    ["search", "unsubscribe", "--json"],
    ["platform", "--json"],
    ["gaps", "--json"],
    ["sign", "--example", "one-time", "--json"],
    ["url", "subscription", "--json"],
    ["curl", "get-subscribers", "--json"],
    ["curl", "charging-notification", "--json"],
    ["code", "E1002", "--json"],
    ["diagnose", "invalid signature", "--json"],
    ["practices", "--json"],
    ["checklist", "--json"],
    ["reference", "--json"],
  ]) {
    assert.doesNotThrow(() => cli(args), `digimart ${args.join(" ")} failed`);
  }
});

test("sign --example reproduces the worked example digest", () => {
  const r = JSON.parse(cli(["sign", "--example", "one-time", "--json"]));
  assert.equal(r.matches, true);
  assert.equal(r.computed, "3badf638ceca499000fd07b899e5fc0cec348d9762886b8430104291126683892845a208caef8e99b53432571e46c5f04162a1a25646443f7935239ea0901b38");
});

test("nothing the CLI prints carries a credential", () => {
  const rest = JSON.parse(cli(["curl", "unregistration", "--json"]));
  assert.equal(rest.payload.applicationId, "$DIGIMART_APP_ID");
  assert.equal(rest.payload.password, "$DIGIMART_PASSWORD");

  const secret = "do-not-print-me-123";
  const built = cli(["url", "one-time", "amount=50", "--json"], { DIGIMART_API_KEY: "key1", DIGIMART_API_SECRET: secret });
  assert.ok(!built.includes(secret), "url printed the API Secret");
  assert.equal(JSON.parse(built).signed, true);
  const signed = cli(["sign", "one-time", "requestTime=2024-08-08T12:00:00Z", "amount=50", "--json"], { DIGIMART_API_KEY: "key1", DIGIMART_API_SECRET: secret });
  assert.ok(!signed.includes(secret), "sign printed the API Secret");

  assert.throws(() => cli(["sign", "one-time", `apiSecret=${secret}`]), /Command failed|status/);
});

test("a URL printed by the CLI passes the CLI's own check", () => {
  const env = { DIGIMART_API_KEY: "key1", DIGIMART_API_SECRET: "sec1" };
  const { url } = JSON.parse(cli(["url", "one-time", "amount=50", "redirectUrl=https://shop.example/r", "--json"], env));
  const check = JSON.parse(cli(["check-url", url, "--json"], env));
  assert.equal(check.valid, true, check.errors.join("; "));
  assert.equal(check.signatureCheck.matches, true);
  assert.throws(() => cli(["check-url", url.replace("amount=50", "amount=51")], env), /Command failed|status/);
});

test("the CLI exits non-zero on a bad body, a failed response and a failed redirect", () => {
  assert.throws(() => cli(["validate", "unregistration", '{"subscriberId":"abc","action":0}']), /Command failed|status/);
  assert.throws(() => cli(["response", "unregistration", '{"statusCode":"E1104"}']), /Command failed|status/);
  assert.throws(() => cli(["redirect", "subscriptionStatus=E3009&requestId=123456789012345"]), /Command failed|status/);
  assert.doesNotThrow(() => cli(["response", "get-subscribers", '{"statusCode":"S1001"}']));
});

test("the CLI refuses to treat a signed-URL flow as a REST call", () => {
  assert.throws(() => cli(["curl", "one-time"]), /Command failed|status/);
});

test("the CLI fails clearly on an unknown id", () => {
  assert.throws(() => cli(["show", "sms-send"]));
});
