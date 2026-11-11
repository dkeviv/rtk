import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, chmodSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { delimiter } from "node:path";
import { apply, name } from "../index.js";

function ctx() {
  const handlers = [];
  const sections = [];
  const plugin = {
    handlers,
    sections,
    on(event, handler) { handlers.push(handler); },
    systemPrompt: {
      getSectionOrder: () => 10000,
      section(section) { sections.push(section); return () => {}; },
    },
  };
  return plugin;
}

const exec = { name: "bash", arguments: { command: "pytest -q" } };
const big = "collected 101 items\n" + "tests/a.py " + ".".repeat(3000) + " [100%]\n1 passed\n";

async function run(plugin, input, output, next = async () => ({ kind: "accept", content: output })) {
  return plugin.handlers[0](input, output, next);
}

test("registers awareness and post-execute hook", () => {
  const plugin = ctx();
  apply(plugin);
  assert.equal(plugin.sections[0].name, "rtk-awareness");
  assert.equal(plugin.handlers.length, 1);
});

test("filters long pytest output through rtk pipe", async () => {
  const plugin = ctx();
  apply(plugin, { minChars: 10 });
  const out = await run(plugin, exec, [{ type: "text", text: big }]);
  assert.equal(out.kind, "accept");
  assert.match(out.content[0].text, /pytest/i);
  assert.ok(out.content[0].text.length < big.length);
});

test("passes through short output", async () => {
  const plugin = ctx();
  apply(plugin);
  const original = [{ type: "text", text: "ok" }];
  const out = await run(plugin, exec, original);
  assert.deepEqual(out.content, original);
});

test("passes through when rtk is unavailable", async () => {
  const plugin = ctx();
  apply(plugin, { minChars: 10, rtkBin: "definitely-not-rtk", timeoutMs: 100 });
  const original = [{ type: "text", text: big }];
  const out = await run(plugin, exec, original);
  assert.deepEqual(out.content, original);
});
