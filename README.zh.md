# dsh-hookd · 给 DSH 加一层"可审计的自检闸"

[English](README.md)

一个很小的 DSH 插件：**记录我每一次工具调用，并在动手前按规则检查一遍**。
它不替代沙箱，它补的是沙箱管不到的那段——"这条命令看起来像 `rm -rf`，要不要先停一下"。

## 它解决什么问题

DSH 的 sandbox 只认路径（workspace-write / 全权限），approval 只管"要不要问一句"。
但真实事故往往长这样：

- `rm -rf ./build` 写错成 `rm -rf ./` —— 路径在允许范围内，沙箱放行；
- 把 `~/.ssh/id_rsa` 的内容贴进文件 —— 字节数不大，沙箱没理由拦；
- 上一轮删了什么东西，想复盘却没有任何记录 —— 会话一压缩，证据没了。

dsh-hookd 就干这三件事：**记下来、能查、动手前先问自己一句**。

## 四个能力

| 能力 | 触发 | 行为 |
|---|---|---|
| **审计** | 监听 `session/event` | 把 `tool/call`、`tool/result` 追加到 `$DSH_HOME/hookd/audit.jsonl`，8MB 自动轮转 |
| **路径规则** | `hook_check({path})` | `deny` / `protected` 命中就抛错拒绝；`warn` 只提示 |
| **命令规则** | `hook_check({command})` | 拆 token 逐段比对路径规则，另外匹配危险命令特征（`rm -rf`、`del /f`…） |
| **查看** | `/hooks` 命令 | 打印规则文件位置、三类规则内容、最近 5 条审计 |

## 怎么用

我（或任何一个 agent）在破坏性操作前调用一次：

```jsonc
// hook_check({ path: "C:/proj/data/raw/a.csv" })
{ "action": "deny", "matched": "**/data/raw/**", "reason": "命中禁止规则…" }

// hook_check({ command: "rm -rf C:/proj/build" })
{ "action": "deny", "matched": "rm -rf", "reason": "命中危险命令特征「rm -rf」…" }

// hook_check({ path: "C:/proj/src/main.py" })
{ "action": "allow", "reason": "没有命中任何规则" }
```

被拒绝时它会**抛错**，所以调用方拿不到"假装成功"的结果。

## 规则文件

`$DSH_HOME/hookd/rules.json`，首次运行自动生成：

```json
{
  "deny":         ["**/data/raw/**", "**/node_modules/**", "**/app.asar"],
  "warn":         ["**/.env", "**/id_rsa*", "**/*.pem"],
  "protected":    ["C:/Windows/**", "**/profiles/*/node_modules/**"],
  "denyCommands": ["rm -rf", "rm -fr", "del /f", "del /s", "rmdir /s",
                   "remove-item -recurse", "format "]
}
```

- `**` 匹配任意层级，`*` 匹配单层；目录本身也能命中 `dir/**`（补尾斜杠再比一次）。
- 每次调用都重新读文件 —— **改规则不用重启**。
- 命令检查会把 `rm -rf C:/p/data/raw` 拆成 token 逐段比对，不会整串漏判。

## 装 / 卸

- **装**：插件页「添加插件 → 本地目录」选这个目录即可；会以 `link:` 链接进 profile，改源码重启即生效。
- **卸**：删 `cordis.yml` 里 `- id: dsh-hookd` 那一段 + `package.json` 里的 `dsh-hookd` 两处（link 依赖与 bundles 项）。
- **启用后要重启 DSH**（host facet 只在启动时挂载）。

## 边界（重要）

- **它不是内核级拦截**：只有主动调 `hook_check` 时才生效；不调用就绕过。
- 真正的硬边界在 DSH 的 sandbox 与 approval 策略；本插件不修改它们。
- 审计是**本地明文 JSONL**，没做防篡改链；要取证级别的，用 `@cyd-prc/dsh-audit-chain`。
- 所有代码都包了 try/catch：审计写失败、规则文件坏掉，都不会影响主流程。

## 为什么不做成"真钩子"

DSH 已有官方的 `@deepseek-ai/dsh-hooks-codex` / `dsh-hooks-claude-code`，能跑 shell 钩子并真正阻断。
本插件的定位是**进程内的轻量自检**：不需要外部脚本、不依赖宿主钩子通道、规则改完即生效。
要"改完代码自动格式化""拦住某类文件写入"这类硬需求，去用官方钩子桥（配套脚本见 `work/hooks-starter-pack`）。
