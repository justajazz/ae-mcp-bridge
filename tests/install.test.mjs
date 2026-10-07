// Panel installer helpers (no files are written outside temp).
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import vm from "node:vm";
import { loaderSource, panelsFolder } from "../src/install-panel.mjs";

test("ScriptUI Panels folder per platform", () => {
  assert.equal(panelsFolder("C:\\Program Files\\Adobe\\Adobe After Effects 2026", "win32"),
    path.join("C:\\Program Files\\Adobe\\Adobe After Effects 2026", "Support Files", "Scripts", "ScriptUI Panels"));
  assert.match(panelsFolder("/Applications/Adobe After Effects 2026", "darwin").replace(/\\/g, "/"), /After Effects 2026\/Scripts\/ScriptUI Panels$/);
});

test("dev loader is ASCII ES3 and points at the panel, even with Cyrillic paths", () => {
  const source = loaderSource("D:\\Проекты\\AE MCP\\src\\ae-mcp-panel.jsx");
  assert.match(source, /^[\x00-\x7f]*$/);
  assert.doesNotThrow(() => new Function(source));
  // Evaluate with fake ExtendScript globals and capture the File path.
  let opened = null, evaluated = null;
  const context = vm.createContext({
    $: { global: {}, evalFile: f => { evaluated = f.path; } },
    File: function (p) { opened = p; this.path = p; this.exists = true; this.fsName = p; },
    alert: () => {}
  });
  vm.runInContext(source, context);
  assert.equal(opened, "D:/Проекты/AE MCP/src/ae-mcp-panel.jsx");
  assert.equal(evaluated, opened);
});
