// End-to-end protocol tests: real server process + Node mock panel.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpClient, textOf } from "./mcp-client.mjs";
import { MockPanel, TINY_PNG, writePngSlowly } from "./mock-panel.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let dir, client, panel;

// Space and Cyrillic in the path on purpose.
async function setup({ env = {}, panelOptions, startPanel = true } = {}) {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "ae mcp тест "));
  client = new McpClient({
    AE_MCP_BRIDGE_DIR: dir,
    AE_MCP_TIMEOUT_MS: "1500",
    AE_MCP_PICKUP_TIMEOUT_MS: "600",
    AE_MCP_POLL_MS: "20",
    AE_MCP_TRANSPORT: "files",
    ...env
  });
  await client.initialize();
  panel = new MockPanel(dir, panelOptions);
  if (startPanel) await panel.start();
}

afterEach(async () => {
  client?.close();
  await panel?.stop();
  await sleep(50);
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  client = panel = undefined;
});

describe("MCP protocol", () => {
  beforeEach(() => setup({ startPanel: false }));

  test("initialize and tools/list", async () => {
    const reply = await client.request("tools/list", {});
    const names = reply.result.tools.map(t => t.name);
    for (const name of ["ae_health", "ae_run_jsx", "ae_get_result", "ae_list_project", "ae_save_project", "ae_capture_frame"]) {
      assert.ok(names.includes(name), `missing ${name}`);
    }
  });

  test("malformed JSON does not crash the server", async () => {
    client.writeRaw("{not json\n");
    const reply = await client.request("ping", {});
    assert.deepEqual(reply.result, {});
    assert.ok(client.messages.some(m => m.error?.code === -32700));
  });

  test("unknown method returns -32601", async () => {
    const reply = await client.request("resources/list", {});
    assert.equal(reply.error.code, -32601);
  });
});

describe("commands", () => {
  test("run_jsx round trip keeps code and data separate, non-ASCII escaped", async () => {
    await setup({ panelOptions: { handler: cmd => ({ data: { echo: cmd.args, code: cmd.code } }) } });
    const args = { text: 'Привет "мир" \\ </script>', path: "D:\\Work\\Проект 1.aep" };
    const result = await client.call("ae_run_jsx", { code: "comp.layers.addText(args.text)", args });
    assert.ok(!result.isError, textOf(result));
    const data = JSON.parse(result.content[0].text);
    assert.deepEqual(data.echo, args);
    assert.ok(data.code.endsWith(" comp.layers.addText(args.text)"), "user code goes last, on the same line as lib");
    assert.match(data.code, /^var lib = /);
    const raw = panel.seenCommands[0].raw;
    assert.match(raw, /^[\x00-\x7f]*$/, "command.json must be pure ASCII");
    const command = panel.seenCommands[0].command;
    assert.equal(command.undo, true);
    assert.equal(command.undoName, "MCP: ae_run_jsx");
  });

  test("errors from AE are reported with line", async () => {
    await setup({ panelOptions: { handler: () => ({ error: "ReferenceError: foo is undefined" }) } });
    const result = await client.call("ae_run_jsx", { code: "foo()" });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /ae_run_jsx failed in After Effects: ReferenceError/);
  });

  test("read-only tools are not wrapped in undo groups", async () => {
    await setup({ panelOptions: { handler: () => ({ data: { compositions: [] } }) } });
    await client.call("ae_list_project");
    assert.equal(panel.executed[0].undo, false);
  });

  test("timeout returns commandId; ae_get_result collects it without re-execution", async () => {
    await setup({ panelOptions: { handler: () => ({ delayMs: 2500, data: { done: true } }) } });
    const first = await client.call("ae_run_jsx", { code: "slow()" });
    const status = JSON.parse(textOf(first));
    assert.equal(status.status, "running");
    assert.ok(status.commandId);

    const notYet = await client.call("ae_get_result", { commandId: status.commandId });
    assert.equal(JSON.parse(textOf(notYet)).status, "running");

    const done = await client.call("ae_get_result", { commandId: status.commandId, waitMs: 5000 });
    assert.ok(!done.isError, textOf(done));
    assert.deepEqual(JSON.parse(textOf(done)), { done: true });
    assert.equal(panel.executed.length, 1);

    const again = await client.call("ae_get_result", { commandId: status.commandId });
    assert.match(textOf(again), /already returned/);
  });

  test("busy panel: a new command is refused, nothing is queued or duplicated", async () => {
    await setup({ panelOptions: { handler: cmd => (cmd.code.endsWith("slow()") ? { delayMs: 2500, data: 1 } : { data: 2 }) } });
    const first = JSON.parse(textOf(await client.call("ae_run_jsx", { code: "slow()" })));
    assert.equal(first.status, "running");
    const second = await client.call("ae_run_jsx", { code: "fast()" });
    assert.equal(second.isError, true);
    assert.match(textOf(second), /still executing ae_run_jsx/);
    assert.match(textOf(second), new RegExp(first.commandId));

    const health = JSON.parse(textOf(await client.call("ae_health")));
    assert.equal(health.busy.commandId, first.commandId);

    await client.call("ae_get_result", { commandId: first.commandId, waitMs: 5000 });
    assert.deepEqual(panel.executed.map(c => c.code.slice(-6)), ["slow()"]);
  });

  test("panel not running: clear error, and the stale command is never executed later", async () => {
    await setup({ startPanel: false });
    const started = Date.now();
    const result = await client.call("ae_run_jsx", { code: "x()" });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /No runner has ever answered/);
    assert.ok(Date.now() - started < 1400, "should fail at pickup timeout, not the full timeout");
    assert.equal(fsSync.existsSync(path.join(dir, "command.json")), false, "withdrawn command removed");

    // Simulate a stale command left behind (e.g. server crashed) and a panel starting later.
    await fs.writeFile(path.join(dir, "command.json"), JSON.stringify({
      commandId: "stale-1", tool: "ae_run_jsx", code: "x()", args: {}, createdAt: Date.now() - 5000, pickupDeadline: Date.now() - 4000
    }));
    await panel.start();
    await sleep(200);
    assert.equal(panel.executed.length, 0);
    assert.equal(panel.expired.length, 1);
  });

  test("stopped panel is reported as stopped", async () => {
    await setup();
    await panel.stop();
    const result = await client.call("ae_list_project");
    assert.equal(result.isError, true);
    assert.match(textOf(result), /runner is stopped/);
  });

  test("ae_health reports server, panel and AE info", async () => {
    await setup({ panelOptions: { handler: () => ({ data: { app: "After Effects", version: "26.3", runnerVersion: "0.3.0" } }) } });
    const result = await client.call("ae_health");
    const report = JSON.parse(textOf(result));
    assert.equal(report.connected, true);
    assert.equal(report.server.serverVersion, "0.3.0");
    assert.equal(report.server.bridgeDir, dir);
    assert.equal(report.ae.version, "26.3");
    assert.equal(report.warning, undefined);
  });

  test("ae_health flags panel/server version mismatch", async () => {
    await setup({ panelOptions: { handler: () => ({ data: { runnerVersion: "0.1.9" } }) } });
    const report = JSON.parse(textOf(await client.call("ae_health")));
    assert.match(report.warning, /Version mismatch/);
  });
});

describe("capture frame", () => {
  test("waits for a complete PNG, returns it as image and deletes the temp file", async () => {
    await setup({
      panelOptions: {
        handler: async cmd => {
          await writePngSlowly(cmd.args.path, 200);
          return { data: { path: cmd.args.path, composition: "Main", time: 0 } };
        }
      }
    });
    const result = await client.call("ae_capture_frame", { comp: "Main", background: "transparent" });
    assert.ok(!result.isError, textOf(result));
    const image = result.content.find(c => c.type === "image");
    assert.equal(image.mimeType, "image/png");
    assert.equal(Buffer.from(image.data, "base64").compare(TINY_PNG), 0);
    await sleep(50);
    assert.deepEqual(await fs.readdir(path.join(dir, "frames")), [], "temporary PNG must be deleted");
  });

  test("an explicit path is kept", async () => {
    const keep = path.join(os.tmpdir(), `ae-mcp-keep-${Date.now()}.png`);
    await setup({
      panelOptions: { handler: async cmd => { await writePngSlowly(cmd.args.path, 0); return { data: { path: cmd.args.path } }; } }
    });
    const result = await client.call("ae_capture_frame", { path: keep });
    assert.ok(!result.isError, textOf(result));
    assert.ok(fsSync.existsSync(keep));
    await fs.rm(keep, { force: true });
  });
});

describe("safety", () => {
  test("AE_MCP_DISABLE_RUN_JSX hides and blocks ae_run_jsx", async () => {
    await setup({ env: { AE_MCP_DISABLE_RUN_JSX: "1" } });
    const list = await client.request("tools/list", {});
    assert.ok(!list.result.tools.some(t => t.name === "ae_run_jsx"));
    const result = await client.call("ae_run_jsx", { code: "1" });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /disabled/);
    assert.equal(panel.executed.length, 0);
  });

  test("executed scripts are logged", async () => {
    await setup({ panelOptions: { handler: () => ({ data: 1 }) } });
    await client.call("ae_run_jsx", { code: "app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES)" });
    const logs = await fs.readdir(path.join(dir, "logs"));
    assert.equal(logs.length, 1);
    const text = await fs.readFile(path.join(dir, "logs", logs[0]), "utf8");
    assert.match(text, /CloseOptions\.DO_NOT_SAVE_CHANGES/);
    assert.match(text, /"event":"result"/);
  });

  test("project is backed up once per session before the first mutating command, keeping 5", async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "ae proj "));
    const project = path.join(projectDir, "Тест проект.aep");
    await fs.writeFile(project, "AEP v1");
    const backups = path.join(projectDir, "backups");
    await fs.mkdir(backups);
    for (let i = 1; i <= 6; i++) await fs.writeFile(path.join(backups, `Тест проект_2020-01-0${i}_10-00-00.aep`), "old");
    await fs.writeFile(path.join(backups, "Other_2020-01-01_10-00-00.aep"), "other project");

    await setup({ env: { AE_MCP_BACKUP_DIR: backups }, panelOptions: { projectPath: project, handler: () => ({ data: 1 }) } });
    await client.call("ae_list_project"); // read-only: no backup
    let names = (await fs.readdir(backups)).filter(n => n.startsWith("Тест"));
    assert.equal(names.length, 6);

    const first = await client.call("ae_run_jsx", { code: "1" });
    assert.match(textOf(first), /Project backup:/);
    await client.call("ae_run_jsx", { code: "2" });

    names = (await fs.readdir(backups)).filter(n => n.startsWith("Тест")).sort();
    assert.equal(names.length, 5);
    assert.ok(!names.includes("Тест проект_2020-01-01_10-00-00.aep"), "oldest pruned");
    const newest = names[names.length - 1];
    assert.equal(await fs.readFile(path.join(backups, newest), "utf8"), "AEP v1");
    assert.ok(fsSync.existsSync(path.join(backups, "Other_2020-01-01_10-00-00.aep")), "other projects untouched");
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  test("AE_MCP_BACKUP=0 disables backups", async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "ae proj "));
    const project = path.join(projectDir, "p.aep");
    await fs.writeFile(project, "x");
    const backups = path.join(projectDir, "backups");
    await setup({ env: { AE_MCP_BACKUP: "0", AE_MCP_BACKUP_DIR: backups }, panelOptions: { projectPath: project, handler: () => ({ data: 1 }) } });
    await client.call("ae_run_jsx", { code: "1" });
    assert.equal(fsSync.existsSync(backups), false);
    await fs.rm(projectDir, { recursive: true, force: true });
  });
});

test("a collected command is removed from command.json", async () => {
  await setup({ panelOptions: { handler: () => ({ data: 1 }) } });
  await client.call("ae_list_project");
  assert.equal(fsSync.existsSync(path.join(dir, "command.json")), false);
});
