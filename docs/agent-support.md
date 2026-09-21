# Agent support matrix

Which file each agent reads, and what you get.

## Support tiers

| Tier | What you get |
|---|---|
| **Plugin** | Skills, slash commands, and always-on context via a native plugin manifest |
| **Skills** | The skill files load and activate on relevant tasks |
| **Rules** | Always-on instructions, no commands |
| **Context** | The agent reads `AGENTS.md` from the project root with zero setup |

Every tier gets the full `references/`, `templates/`, `catalog/` and `tools/` — the CLI works
anywhere the agent can run a shell command, which is the practical floor for all of them. Tiers say
nothing about the language you build in: `references/13-integration-reference.md` gives every
signed-URL flow as a shell recipe and every REST call as a runnable curl, with every parameter and
field defined, which is enough on its own in any language; `references/10-any-stack.md` specifies
what surrounds them; and `templates/` shows both already built in TypeScript/Node, Python, Java, Go,
PHP and C#.

## Matrix

| Agent | Tier | File it reads | Install |
|---|---|---|---|
| Claude Code | Plugin | `.claude-plugin/plugin.json`, `skills/`, `commands/` | `/plugin marketplace add hSenidMobileCPaaS/Digimart-as-a-skill` |
| Claude Agent SDK | Skills | `SKILL.md`, `skills/` | Point the SDK at the checkout |
| Codex CLI / desktop | Plugin | `.codex-plugin/plugin.json`, `skills/` | `codex plugin marketplace add hSenidMobileCPaaS/Digimart-as-a-skill` |
| GitHub Copilot CLI | Plugin | `.claude-plugin/`, `.github/copilot-instructions.md` | `copilot plugin marketplace add hSenidMobileCPaaS/Digimart-as-a-skill` |
| Gemini CLI / Antigravity | Plugin | `gemini-extension.json` → `AGENTS.md` | `gemini extensions install https://github.com/hSenidMobileCPaaS/Digimart-as-a-skill` |
| Qoder | Plugin | `.qoder-plugin/plugin.json`, `.qoder/rules/` | Copy `.qoder/rules/digimart.md` |
| Hermes Agent | Plugin | `plugin.yaml`, `skills/`, `commands/` | `hermes plugins install hSenidMobileCPaaS/Digimart-as-a-skill` |
| OpenCode | Context | `opencode.json` → `AGENTS.md` | Auto-loads `AGENTS.md` from the project root |
| Cursor | Rules | `.cursor/rules/digimart.mdc` | Copy into your project's `.cursor/rules/` |
| Windsurf | Rules | `.windsurf/rules/digimart.md` | Copy into your project's `.windsurf/rules/` |
| Cline | Rules | `.clinerules/digimart.md` | Copy into your project's `.clinerules/` |
| Kiro | Rules | `.kiro/steering/digimart.md` | Copy to `~/.kiro/steering/` or the project's `.kiro/steering/` |
| GitHub Copilot (editor) | Rules | `.github/copilot-instructions.md` | Copy into your project's `.github/` |
| Aider | Context | `AGENTS.md` | `aider --read AGENTS.md` |
| Zed | Context | `AGENTS.md` | Reads from the project root |
| Amp (Sourcegraph) | Context | `AGENTS.md` | Reads from the working directory upward |
| Jules (Google) | Context | `AGENTS.md` | Reads from the repository root |
| JetBrains Junie | Context | `AGENTS.md` | Settings → Tools → Junie → Guidelines Path |
| VS Code + Codex extension | Context | `AGENTS.md` | Reads from the project root |
| Any other agent | Context | `AGENTS.md` | Copy it, or paste the raw URL |

## File map

```
AGENTS.md                          ← the single source of truth
├── .cursor/rules/digimart.mdc       ← generated (with .mdc frontmatter)
├── .windsurf/rules/digimart.md      ← generated
├── .clinerules/digimart.md          ← generated
├── .kiro/steering/digimart.md       ← generated
├── .qoder/rules/digimart.md         ← generated
├── .agents/rules/digimart.md        ← generated
└── .github/copilot-instructions.md ← generated

SKILL.md                           ← Claude Code / Agent SDK entry point
skills/*/SKILL.md                  ← the seven task-specific skills
commands/*.toml                    ← slash commands for plugin-tier hosts
```

The generated copies come from `scripts/sync-rules.mjs`. Edit `AGENTS.md` and rerun it; CI fails if
they drift.

## No plugin support? You lose nothing important

The tiers differ in *how the instructions load*, not in what the skill knows. A rules-tier agent
still has the complete `references/`, and can still run:

```bash
node tools/digimart.mjs show one-time
node tools/digimart.mjs sign --example one-time
node tools/digimart.mjs check-url '<the URL your code built>'
node tools/digimart.mjs validate charging-notification '<the body you received>'
node tools/digimart.mjs code E1002
```

which is where the precision actually lives. An agent with no shell at all still reads
`references/13-integration-reference.md`, which is the same contract written out.

## Adding an agent

1. Add its path to `PLAIN` (or a bespoke entry) in `scripts/sync-rules.mjs`.
2. Run `node scripts/sync-rules.mjs`.
3. Add a manifest if it has a plugin format.
4. Add a row above.
