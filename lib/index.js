/**
 * dsh-hookd —— 给 DSH 加一层"可审计的自检闸"
 *
 * 提供三样东西：
 *   1) 审计：把每次 tool/call 与 tool/result 追加到 $DSH_HOME/hookd/audit.jsonl（带轮转）
 *   2) 规则：$DSH_HOME/hookd/rules.json 里配 deny / warn / protected / denyCommands
 *   3) 工具 hook_check({path?, command?, intent?})：动手前先问一句，deny 的会直接抛错
 *
 * 注意：这是"审计 + 自检"，不是内核级拦截。DSH 真正的强制拦截在 sandbox / approval
 * 策略里；本插件负责让越界操作"有据可查、且默认被自己的工具挡住"。
 *
 * 宿主契约（见 oh-my-clm / meow-memory 的写法）：
 *   - 工具用 { name, description, parameters, output: { schema, render }, execute } 注册；
 *   - 命令用 { name, description, handler(invocation) -> {kind:"success"|"error", text} } 注册；
 *   - 提示词段用 ctx.systemPrompt.section({ name, order, text })；
 *   - 三个服务都在 inject 里声明，宿主就绪后才 apply。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const name = "dsh-hookd";
export const inject = ["systemPrompt", "tools", "commands"];

const HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const DIR = path.join(HOME, "hookd");
const RULES_FILE = path.join(DIR, "rules.json");
const AUDIT_FILE = path.join(DIR, "audit.jsonl");
const AUDIT_MAX_BYTES = 8 * 1024 * 1024;

const DEFAULT_RULES = {
  notes: "deny 命中就拒绝；warn 只提示；protected 是绝不能写的地方；denyCommands 按小写子串匹配整条命令",
  deny: ["**/data/raw/**", "**/node_modules/**", "**/app.asar"],
  warn: ["**/.env", "**/id_rsa*", "**/*.pem"],
  protected: ["C:/Windows/**", "**/profiles/*/node_modules/**"],
  denyCommands: ["rm -rf", "rm -fr", "del /f", "del /s", "rmdir /s", "remove-item -recurse", "format "],
};

function ensureDir() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
  } catch {
    /* 目录建不了也不影响插件加载 */
  }
}

function loadRules() {
  try {
    if (!fs.existsSync(RULES_FILE)) {
      ensureDir();
      fs.writeFileSync(RULES_FILE, JSON.stringify(DEFAULT_RULES, null, 2), "utf8");
      return DEFAULT_RULES;
    }
    const raw = JSON.parse(fs.readFileSync(RULES_FILE, "utf8"));
    return {
      deny: Array.isArray(raw.deny) ? raw.deny : [],
      warn: Array.isArray(raw.warn) ? raw.warn : [],
      protected: Array.isArray(raw.protected) ? raw.protected : [],
      denyCommands: Array.isArray(raw.denyCommands)
        ? raw.denyCommands
        : DEFAULT_RULES.denyCommands,
    };
  } catch {
    return DEFAULT_RULES;
  }
}

/** 极简 glob：** 匹配任意层级，* 匹配单层内任意字符，? 匹配一个字符 */
export function globToRegExp(glob) {
  const norm = glob.replace(/\\/g, "/");
  let out = "^";
  for (let i = 0; i < norm.length; i++) {
    const c = norm[i];
    if (c === "*") {
      if (norm[i + 1] === "*") {
        i++;
        if (norm[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(out + "$", "i");
}

export function matchesAny(target, globs) {
  if (!target) return null;
  const norm = String(target).replace(/\\/g, "/");
  for (const g of globs || []) {
    let re;
    try {
      re = globToRegExp(g);
    } catch {
      continue;
    }
    // 目录本身也要命中 `dir/**`：补一个尾部斜杠再比一次
    if (re.test(norm) || re.test(norm + "/")) return g;
  }
  return null;
}

export function checkRules(input) {
  const rules = loadRules();
  const candidates = [];
  if (input && input.path) candidates.push(String(input.path));
  if (input && input.command) {
    const cmd = String(input.command);
    candidates.push(cmd);
    // 命令要拆成 token 再比：`rm -rf C:/proj/data/raw` 里真正要命的是那个路径
    for (const tok of cmd.split(/[\s|;&<>"'`]+/)) {
      if (tok) candidates.push(tok);
    }
  }
  if (candidates.length === 0) return { action: "allow", reason: "没给 path/command，无法判断" };

  for (const target of candidates) {
    const deny = matchesAny(target, rules.deny);
    if (deny) return { action: "deny", matched: deny, target, reason: `命中禁止规则 ${deny}（${target}）` };
  }
  for (const target of candidates) {
    const prot = matchesAny(target, rules.protected);
    if (prot) return { action: "deny", matched: prot, target, reason: `命中受保护路径 ${prot}（${target}）` };
  }
  for (const target of candidates) {
    const warn = matchesAny(target, rules.warn);
    if (warn) return { action: "warn", matched: warn, target, reason: `命中敏感文件规则 ${warn}（${target}）` };
  }

  // 危险命令特征：按小写子串匹配整条命令（路径规则拦不到 `rm -rf` 这种）
  const cmd = input && input.command ? String(input.command).toLowerCase() : "";
  if (cmd) {
    for (const pattern of rules.denyCommands || []) {
      const p = String(pattern || "").toLowerCase();
      if (p && cmd.includes(p)) {
        return {
          action: "deny",
          matched: pattern,
          target: cmd,
          reason: `命中危险命令特征「${pattern}」，请确认不是破坏性操作`,
        };
      }
    }
  }

  return { action: "allow", reason: "没有命中任何规则" };
}

function rotateIfNeeded() {
  try {
    const st = fs.statSync(AUDIT_FILE);
    if (st.size > AUDIT_MAX_BYTES) {
      fs.renameSync(AUDIT_FILE, `${AUDIT_FILE}.1`);
    }
  } catch {
    /* 文件还不存在 */
  }
}

function appendAudit(record) {
  try {
    ensureDir();
    rotateIfNeeded();
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(record) + "\n", "utf8");
  } catch {
    /* 审计失败绝不能影响主流程 */
  }
}

const checkParameters = {
  type: "object",
  properties: {
    path: { type: "string", description: "要写入/删除的文件或目录路径" },
    command: { type: "string", description: "要执行的命令（没有具体路径时用）" },
    intent: { type: "string", description: "一句话说明你要干什么，便于审计" },
  },
  additionalProperties: false,
};

/** 返回值要过宿主校验：只声明实际会出现的字段，deny 时整条抛错。 */
const checkOutput = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["allow", "warn", "deny"] },
    matched: { type: "string", description: "命中的规则（glob 或命令特征）" },
    target: { type: "string", description: "实际命中的那个路径/token/命令" },
    reason: { type: "string", description: "给人看的一句话解释" },
  },
  required: ["action", "reason"],
  additionalProperties: false,
};

const hookCheckTool = {
  name: "hook_check",
  description:
    "按 $DSH_HOME/hookd/rules.json 检查一个路径或命令是否被允许；deny 时抛错。用于破坏性操作前的自检。",
  parameters: checkParameters,
  output: {
    schema: checkOutput,
    render: (_args, value) => [
      { type: "text", text: `hook_check: ${value.action} — ${value.reason}` },
    ],
  },
  isConcurrencySafe: () => true,
  async execute(args) {
    const verdict = checkRules(args || {});
    appendAudit({
      t: new Date().toISOString(),
      kind: "hook_check",
      input: args || {},
      verdict,
    });
    if (verdict.action === "deny") {
      throw new Error(`[hookd] 拒绝：${verdict.reason}`);
    }
    return verdict;
  },
};

const hooksCommand = {
  name: "hooks",
  description: "查看 hookd 规则文件位置与最近几条审计记录",
  input: { hint: "" },
  handler() {
    try {
      const rules = loadRules();
      let tail = [];
      try {
        tail = fs.readFileSync(AUDIT_FILE, "utf8").trim().split("\n").slice(-5);
      } catch {
        tail = [];
      }
      const lines = [
        `rules: ${RULES_FILE}`,
        `audit: ${AUDIT_FILE}`,
        `deny(${rules.deny.length}): ${rules.deny.join(", ")}`,
        `warn(${rules.warn.length}): ${rules.warn.join(", ")}`,
        `protected(${rules.protected.length}): ${rules.protected.join(", ")}`,
        `denyCommands(${rules.denyCommands.length}): ${rules.denyCommands.join(", ")}`,
        "--- 最近审计 ---",
        ...tail,
      ];
      return { kind: "success", text: lines.join("\n") };
    } catch (err) {
      return { kind: "error", text: `dsh-hookd: /hooks 读取失败：${String(err)}` };
    }
  },
};

export function apply(ctx) {
  const warn = (message) => {
    try {
      ctx?.logger?.warn?.(`dsh-hookd: ${message}`);
    } catch {
      /* 日志都写不了就算了 */
    }
  };

  try {
    ensureDir();
    loadRules();
  } catch (err) {
    // 规则文件生成失败不致命，后续每次 check 还会再试
    warn(`rules bootstrap failed: ${String(err)}`);
  }

  // 提示词段：告诉模型"动手前先自检"
  try {
    if (typeof ctx?.systemPrompt?.section === "function") {
      ctx.systemPrompt.section({
        name: "dsh-hookd:rules",
        order: 3260,
        text:
          "破坏性操作（写入 protected 目录、改 data/raw、删文件、跑 shell 命令）之前，先调用 hook_check 工具自检；" +
          "它返回 deny 时必须停手并说明原因。审计日志在 $DSH_HOME/hookd/audit.jsonl。",
      });
    } else {
      warn("systemPrompt.section 不可用，提示词段未注册");
    }
  } catch (err) {
    warn(`systemPrompt.section 注册失败: ${String(err)}`);
  }

  // 工具：注册失败一定要吼出来，不然会静默失效
  try {
    if (typeof ctx?.tools?.register === "function") {
      ctx.tools.register(hookCheckTool);
    } else {
      warn("tools.register 不可用，hook_check 未注册");
    }
  } catch (err) {
    warn(`hook_check 注册失败: ${String(err)}`);
  }

  // 命令：/hooks
  try {
    if (typeof ctx?.commands?.register === "function") {
      ctx.commands.register(hooksCommand);
    } else {
      warn("commands.register 不可用，/hooks 未注册");
    }
  } catch (err) {
    warn(`/hooks 注册失败: ${String(err)}`);
  }

  // 审计：监听会话事件
  try {
    if (typeof ctx?.on === "function") {
      ctx.on("session/event", (session, event) => {
        try {
          const type = event && (event.type || event.kind);
          if (type !== "tool/call" && type !== "tool/result") return;
          const data = event.data || {};
          appendAudit({
            t: new Date().toISOString(),
            kind: type,
            session: session?.id,
            tool: data.name,
            callId: data.callId,
            args: typeof data.arguments === "string" ? data.arguments.slice(0, 400) : undefined,
          });
        } catch {
          /* 单条失败忽略 */
        }
      });
    } else {
      warn("ctx.on 不可用，审计未启用");
    }
  } catch (err) {
    warn(`审计监听注册失败: ${String(err)}`);
  }
}
