// Transport "cli" (default since 0.3.0): the server triggers the runner in AE for every command and
// waits while a modal dialog is open. AE is replaced by tests/fake-launcher.mjs + a triggered MockPanel.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpClient, textOf } from "./mcp-client.mjs";
import { MockPanel } from "./mock-panel.mjs";
import { jsxPathLiteral, runnerCode } from "../src/ae-launch.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fakeLauncher = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-launcher.mjs");

let dir, client, runner;

async function setup({ env = {}, ae = { running: true, modal: false }, handler = () => ({ data: 1 }) } = {}) {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "ae mcp cli "));
  await setAe(ae);
  client = new McpClient({
    AE_MCP_BRIDGE_DIR: dir,
    AE_MCP_TIMEOUT_MS: "3000",
    AE_MCP_PICKUP_TIMEOUT_MS: "1500",
    AE_MCP_POLL_MS: "20",
    AE_MCP_RETRIGGER_MS: "400",
    AE_MCP_BACKUP: "0",
    AE_MCP_TEST_LAUNCHER: fakeLauncher,
    ...env
  });
  await client.initialize();
  runner = new MockPanel(dir, { handler, triggered: true });
  await runner.start();
}

const setAe = state => fs.writeFile(path.join(dir, "fake-ae.json"), JSON.stringify(state));
const triggers = async () => (await fs.readFile(path.join(dir, "triggers.txt"), "utf8").catch(() => "")).split("\n").filter(Boolean);

afterEach(async () => {
  client?.close();
  await runner?.stop();
  await sleep(50);
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  client = runner = undefined;
});

test("a command triggers the runner once and returns its result", async () => {
  await setup({ handler: cmd => ({ data: { echo: cmd.args } }) });
  const result = await client.call("ae_run_jsx", { code: "1", args: { a: 1 } });
  assert.ok(!result.isError, textOf(result));
  assert.deepEqual(JSON.parse(textOf(result)).echo, { a: 1 });
  assert.deepEqual(await triggers(), ["run"]);
  assert.ok(fsSync.existsSync(path.join(dir, "runner.jsx")), "runner installed into the bridge folder");
});

test("a command sent while a dialog is open waits for it to close, then runs once", async () => {
  await setup({ ae: { running: true, modal: true, dialogs: ["Composition Settings"] } });
  const started = Date.now();
  setTimeout(() => setAe({ running: true, modal: false }), 800);
  const result = await client.call("ae_list_project");
  assert.ok(!result.isError, textOf(result));
  assert.ok(Date.now() - started >= 700, "waited for the dialog");
  assert.deepEqual(await triggers(), ["run"], "nothing was sent while the dialog was open");
  assert.equal(runner.executed.length, 1);
});

test("a dialog that stays open fails cleanly after AE_MCP_DIALOG_WAIT_MS, nothing executed", async () => {
  await setup({ env: { AE_MCP_DIALOG_WAIT_MS: "500" }, ae: { running: true, modal: true, dialogs: ["Composition Settings"] } });
  const result = await client.call("ae_run_jsx", { code: "1" });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /dialog is open in After Effects \("Composition Settings"\)/);
  assert.match(textOf(result), /Nothing was executed/);
  assert.deepEqual(await triggers(), []);
  assert.equal(fsSync.existsSync(path.join(dir, "command.json")), false);
  await setAe({ running: true, modal: false });
  const next = await client.call("ae_run_jsx", { code: "2" });
  assert.ok(!next.isError, textOf(next));
  assert.deepEqual(runner.executed.map(c => c.code.slice(-1)), ["2"]);
});

test("a trigger swallowed by a dialog is re-sent; the command still runs once", async () => {
  await setup({ ae: { running: true, modal: false, swallowNext: true } });
  const result = await client.call("ae_run_jsx", { code: "1" });
  assert.ok(!result.isError, textOf(result));
  assert.deepEqual(await triggers(), ["swallowed", "run"]);
  assert.equal(runner.executed.length, 1);
});

test("AE not running: clear error, nothing written", async () => {
  await setup({ ae: { running: false } });
  const result = await client.call("ae_run_jsx", { code: "1" });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /After Effects is not running/);
  assert.equal(fsSync.existsSync(path.join(dir, "command.json")), false);
});

test("ae_health reports an open dialog without sending anything", async () => {
  await setup({ ae: { running: true, modal: true, dialogs: ["Preferences"] } });
  const result = await client.call("ae_health");
  const report = JSON.parse(textOf(result));
  assert.equal(report.afterEffects.modalDialog, true);
  assert.deepEqual(report.afterEffects.dialogs, ["Preferences"]);
  assert.match(report.message, /dialog is open/);
  assert.deepEqual(await triggers(), []);
});

test("runner path literal is safe ExtendScript", () => {
  assert.equal(jsxPathLiteral("C:\\MCP\\ae-bridge\\runner.jsx"), "'C:/MCP/ae-bridge/runner.jsx'");
  assert.equal(jsxPathLiteral("D:\\Мой 'мост'\\runner.jsx"), "'D:/\\u041c\\u043e\\u0439 \\'\\u043c\\u043e\\u0441\\u0442\\'/runner.jsx'");
  assert.equal(runnerCode("C:\\b\\runner.jsx"), "$.evalFile('C:/b/runner.jsx')");
});
