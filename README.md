# dsh-hookd · a small, auditable self-check gate for DSH

A tiny [DSH](https://github.com) plugin: **it records every tool call, and before you act it checks the target against your rules.**
It does not replace the sandbox. It covers the gap the sandbox cannot see — "this command looks like `rm -rf`, maybe stop for a second".

[中文](README.zh.md)

## What problem it solves

DSH's sandbox only knows about paths (`workspace-write` / full access); approval only knows "ask or not".
But real accidents look like this:

- `rm -rf ./build` mistyped as `rm -rf ./` — the path is inside the allowed root, the sandbox lets it through;
- `~/.ssh/id_rsa` pasted into a file — a few kilobytes, the sandbox has no reason to object;
- you want to review what got deleted last turn, and there is no record at all — once the session is compacted, the evidence is gone.

dsh-hookd does three things: **record it, make it queryable, ask itself a question before acting**.

## Four capabilities

| Capability | Trigger | Behaviour |
|---|---|---|
| **Audit** | listens on `session/event` | appends `tool/call` / `tool/result` to `$DSH_HOME/hookd/audit.jsonl`, rotates at 8 MB |
| **Path rules** | `hook_check({path})` | `deny` / `protected` hit throws; `warn` only reports |
| **Command rules** | `hook_check({command})` | splits the command into tokens, compares each against the path rules, and matches dangerous-command patterns (`rm -rf`, `del /f`, …) |
| **Inspect** | `/hooks` command | prints the rules file location, all rule lists, and the last 5 audit records |

## Usage

The agent calls it once before a destructive operation (the `reason` text is Chinese for now; keys and `action` values are stable):

```jsonc
// hook_check({ path: "C:/proj/data/raw/a.csv" })
{ "action": "deny", "matched": "**/data/raw/**", "reason": "命中禁止规则…" }

// hook_check({ command: "rm -rf C:/proj/build" })
{ "action": "deny", "matched": "rm -rf", "reason": "命中危险命令特征「rm -rf」…" }

// hook_check({ path: "C:/proj/src/main.py" })
{ "action": "allow", "reason": "没有命中任何规则" }
```

A denial **throws**, so the caller cannot mistake it for success.

## Rules file

`$DSH_HOME/hookd/rules.json`, seeded on first run:

```json
{
  "deny":         ["**/data/raw/**", "**/node_modules/**", "**/app.asar"],
  "warn":         ["**/.env", "**/id_rsa*", "**/*.pem"],
  "protected":    ["C:/Windows/**", "**/profiles/*/node_modules/**"],
  "denyCommands": ["rm -rf", "rm -fr", "del /f", "del /s", "rmdir /s",
                   "remove-item -recurse", "format "]
}
```

- `**` crosses directories, `*` matches within one level; a directory itself also matches `dir/**` (compared again with a trailing slash).
- The file is re-read on every call — **no restart needed to change rules**.
- Command checks split `rm -rf C:/p/data/raw` into tokens, so a rule cannot be dodged by embedding the path in a longer command.

## Install / uninstall

- **Install**: in the plugin page choose "Add plugin → local directory" and pick this folder; it is linked into the profile as `link:`, so source edits apply after a restart.
- **Uninstall**: remove the `- id: dsh-hookd` block from `cordis.yml` plus both `dsh-hookd` entries in `package.json` (the `link:` dependency and the bundles item).
- **A restart is required after enabling it** (the host facet is mounted at startup only).

## Boundaries (important)

- **This is not kernel-level interception**: it only runs when `hook_check` is called; skipping the call skips the check.
- The real hard boundary is DSH's sandbox and approval policy; this plugin does not modify them.
- The audit log is **local plaintext JSONL** with no tamper-evident chain; for forensic-grade records use `@cyd-prc/dsh-audit-chain`.
- Every code path is wrapped: a failed audit write or a broken rules file never breaks the main flow — but registration failures are reported through `ctx.logger.warn` instead of being swallowed.

## Why not a "real hook"

DSH already ships `@deepseek-ai/dsh-hooks-codex` / `dsh-hooks-claude-code`, which can run shell hooks and truly block a call.
This plugin is deliberately an **in-process, lightweight self-check**: no external scripts, no dependency on the host hook channel, and rule edits apply immediately. For hard requirements such as "format after every edit" or "block writes to this class of files", use the official hooks bridge (companion scripts live in `work/hooks-starter-pack`).

## Layout

```
dsh-plugin.json     facet manifest (host entry + declared permissions)
cordis.patch.yml    bundle patch
lib/index.js        the whole plugin
tests/              node:test suites (rules + host contract)
```

`npm test` runs `node --test tests/`.
