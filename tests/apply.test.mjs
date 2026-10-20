/**
 * 宿主契约测试：用一个假的 ctx 跑一遍 apply()，
 * 确认工具/命令/提示词/审计四件事都真的注册上了。
 *
 * 这不是"模拟 DSH"，而是钉住我们对宿主 API 的调用形状——
 * 之前就是这里静默失效：ctx.tools 被可选链吞掉，工具根本没注册。
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "hookd-test-"));
process.env.DSH_HOME = sandbox;

const mod = await import("../lib/index.js");

function makeCtx() {
  const seen = { tools: [], commands: [], prompts: [], listeners: [] };
  const ctx = {
    logger: { warn: () => {} },
    systemPrompt: {
      section: (s) => seen.prompts.push(s),
    },
    tools: {
      register: (def) => {
        seen.tools.push(def);
        return () => {};
      },
    },
    commands: {
      register: (def) => {
        seen.commands.push(def);
        return () => {};
      },
    },
    on: (event, fn) => {
      seen.listeners.push([event, fn]);
      return () => {};
    },
  };
  return { ctx, seen };
}

const { ctx, seen } = makeCtx();
mod.apply(ctx);

test("apply exports the host-facing contract", () => {
  assert.equal(mod.inject.includes("tools"), true);
  assert.equal(mod.inject.includes("commands"), true);
  assert.equal(mod.inject.includes("systemPrompt"), true);
});

test("hook_check is registered with a valid tool definition", () => {
  const tool = seen.tools.find((t) => t.name === "hook_check");
  assert.ok(tool, "hook_check 必须注册");
  assert.equal(typeof tool.execute, "function");
  assert.equal(tool.parameters.type, "object");
  assert.ok(tool.output, "宿主需要 output 定义");
  assert.equal(tool.output.schema.type, "object");
  assert.equal(tool.output.schema.additionalProperties, false);
  assert.equal(typeof tool.output.render, "function");
  const rendered = tool.output.render({}, { action: "allow", reason: "ok" });
  assert.match(rendered[0].text, /allow/);
});

test("/hooks command is registered in the handler shape", () => {
  const cmd = seen.commands.find((c) => c.name === "hooks");
  assert.ok(cmd, "/hooks 必须注册");
  assert.equal(typeof cmd.handler, "function");
  const result = cmd.handler({ rawInput: "" });
  assert.equal(result.kind, "success");
  assert.match(result.text, /rules:/);
  assert.match(result.text, /deny\(\d+\)/);
});

test("prompt section is registered", () => {
  assert.equal(seen.prompts.length, 1);
  assert.match(seen.prompts[0].text, /hook_check/);
});

test("rules.json is seeded on first apply", () => {
  const file = path.join(sandbox, "hookd", "rules.json");
  assert.ok(fs.existsSync(file));
  const rules = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(Array.isArray(rules.deny));
  assert.ok(rules.deny.some((g) => g.includes("data/raw")));
});

test("execute: allow returns the verdict and audits it", async () => {
  const tool = seen.tools.find((t) => t.name === "hook_check");
  const verdict = await tool.execute({ path: "C:/proj/src/main.py" });
  assert.equal(verdict.action, "allow");
  const audit = fs.readFileSync(path.join(sandbox, "hookd", "audit.jsonl"), "utf8");
  assert.match(audit, /hook_check/);
  assert.match(audit, /main\.py/);
});

test("execute: deny throws", async () => {
  const tool = seen.tools.find((t) => t.name === "hook_check");
  await assert.rejects(() => tool.execute({ path: "C:/proj/data/raw/a.csv" }), /拒绝/);
  await assert.rejects(() => tool.execute({ command: "rm -rf C:/proj/build" }), /拒绝/);
});

test("session/event listener appends tool/call records", () => {
  const listener = seen.listeners.find(([evt]) => evt === "session/event")?.[1];
  assert.ok(listener, "session/event 监听必须注册");
  listener({ id: "s1" }, { type: "tool/call", data: { name: "bash", callId: "c1" } });
  listener({ id: "s1" }, { type: "session/start", data: {} });
  const audit = fs.readFileSync(path.join(sandbox, "hookd", "audit.jsonl"), "utf8");
  const lines = audit.trim().split("\n");
  assert.equal(lines.filter((l) => l.includes('"tool/call"')).length >= 1, true);
  assert.equal(audit.includes('"s1"'), true);
});
