# 发布推文

## 短版（X / 即刻，~200 字）

给 DSH 写了个小插件 **dsh-hookd**：一层可审计的自检闸。

· 每次 tool/call、tool/result 落 `$DSH_HOME/hookd/audit.jsonl`（8MB 轮转）
· 动手前 `hook_check({path|command})`，命中 deny/protected/危险命令特征直接抛错
· 规则在 `rules.json`，改完即生效，不用重启
· `/hooks` 一条命令看规则 + 最近审计

它不替代沙箱，补的是沙箱看不见的那段：路径合法但命令可疑。
`npm i dsh-hookd`

## 长版（B站动态 / 掘金 / V2EX）

**dsh-hookd：给 agent 加一层"动手前先问自己一句"的闸**

DSH 的沙箱只认路径，approval 只认"要不要问"。真实事故往往长这样：

- `rm -rf ./build` 手滑成 `rm -rf ./` —— 路径在允许范围内，沙箱放行；
- 想把 `~/.ssh/id_rsa` 粘进文件 —— 字节数不大，没人拦；
- 上一轮删了什么，想复盘，会话一压缩证据就没了。

所以写了这个插件，四个能力：

1. **审计**：监听 `session/event`，把每次工具调用追加到 `$DSH_HOME/hookd/audit.jsonl`，8MB 自动轮转；
2. **路径规则**：`deny` / `protected` / `warn` 三类 glob，`dir/**` 连目录本身一起命中；
3. **命令规则**：把 `rm -rf C:/p/data/raw` 拆成 token 逐段比，再匹配危险命令特征；
4. **`/hooks`**：打印规则文件位置、三类规则、最近 5 条审计。

用法就一句：破坏性操作前调 `hook_check({ path })` 或 `hook_check({ command })`，deny 直接抛错，拿不到"假装成功"的结果。

边界说清楚：**不是内核级拦截**，只有主动调用才生效；真正的硬边界仍在 DSH 的 sandbox 和 approval。审计是本地明文 JSONL，没做防篡改链（要取证级用 `@cyd-prc/dsh-audit-chain`）。要"改完代码自动格式化"这类硬需求，去用官方 hooks 桥。

`npm i dsh-hookd`，MIT，17 个测试。
