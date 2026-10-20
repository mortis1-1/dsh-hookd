import assert from "node:assert/strict";
import test from "node:test";

import { checkRules, globToRegExp, matchesAny } from "../lib/index.js";

test("glob: ** crosses directories", () => {
  const re = globToRegExp("**/data/raw/**");
  assert.ok(re.test("a/b/data/raw/x.csv"));
});

test("glob: single * does not cross directories", () => {
  const re = globToRegExp("src/*.py");
  assert.ok(re.test("src/main.py"));
  assert.ok(!re.test("src/sub/main.py"));
});

test("matchesAny: directory itself matches dir/**", () => {
  assert.equal(matchesAny("C:/p/data/raw", ["**/data/raw/**"]), "**/data/raw/**");
});

test("checkRules: existing data/raw file -> deny", () => {
  const v = checkRules({ path: "C:/p/data/raw/a.csv" });
  assert.equal(v.action, "deny");
});

test("checkRules: normal source file -> allow", () => {
  const v = checkRules({ path: "C:/p/src/main.py" });
  assert.equal(v.action, "allow");
});

test("checkRules: .env -> warn", () => {
  const v = checkRules({ path: "C:/p/.env" });
  assert.equal(v.action, "warn");
});

test("checkRules: rm -rf -> deny by command pattern", () => {
  const v = checkRules({ command: "rm -rf C:/p/build" });
  assert.equal(v.action, "deny");
  assert.match(v.reason, /rm -rf/);
});

test("checkRules: normal command -> allow", () => {
  assert.equal(checkRules({ command: "ls -la" }).action, "allow");
});

test("checkRules: empty input -> allow", () => {
  assert.equal(checkRules({}).action, "allow");
});
