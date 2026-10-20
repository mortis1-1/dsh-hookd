# Changelog

## 0.1.0 — 2026-10-20

首个版本，四个能力：

- **审计**：监听 `session/event`，把 `tool/call` / `tool/result` 追加到 `$DSH_HOME/hookd/audit.jsonl`，8MB 轮转。
- **路径规则**：`deny` / `protected` / `warn` 三类 glob；`dir/**` 同时匹配目录本身。
- **命令规则**：按空白/管道/分号拆 token，逐段比路径规则，并匹配危险命令特征（`rm -rf`、`del /f` 等）。
- **`/hooks` 命令**：打印规则位置、三类规则内容（含 `denyCommands`）、最近 5 条审计。

修复（发布前自测发现，未单独发版）：

- 补 `export const inject = ["systemPrompt", "tools", "commands"]`。缺它时 `ctx.tools` 不可用，四个能力的注册被可选链静默吞掉，只剩审计生效。
- `hook_check` 按宿主契约改成 `{ parameters, output: { schema, render }, execute }`，返回值不再被宿主校验拒掉。
- `/hooks` 从 `execute()` 改成 `handler(invocation)`，返回 `{ kind: "success" | "error", text }`。
- 注册失败不再静默：改为 `ctx.logger.warn` 打出来。
- 新增 `tests/apply.test.mjs`（8 例）：用假 ctx 钉住注册形状与审计落盘；旧 `test.mjs` 冒烟脚本删除。

已知限制：

- 不是内核级拦截，只有调用 `hook_check` 时才生效。
- 审计为本地明文 JSONL，未做防篡改链。
- 数据目录固定在 `$DSH_HOME/hookd/`，尚未支持按工作区隔离。
