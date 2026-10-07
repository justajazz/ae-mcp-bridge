// Unit tests for server helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  defaultBridgeDir, cloudSyncWarning, loadConfig, withRetry, asciiJson, isCompletePng, waitForCompletePng, writeFileAtomic
} from "../src/mcp-server.mjs";
import { TINY_PNG } from "./mock-panel.mjs";

test("default bridge folder per platform", () => {
  assert.equal(defaultBridgeDir("win32", "C:\\Users\\u"), "C:\\MCP\\ae-bridge");
  assert.equal(defaultBridgeDir("darwin", "/Users/u"), "/Users/u/Library/Application Support/ae-mcp-bridge");
});

test("AE_MCP_BRIDGE_DIR overrides the default; defaults are sane", () => {
  const custom = loadConfig({ AE_MCP_BRIDGE_DIR: "D:\\bridge here" });
  assert.equal(custom.bridgeDir, path.resolve("D:\\bridge here"));
  assert.equal(custom.backupDir, path.join(custom.bridgeDir, "backups"));
  const defaults = loadConfig({});
  assert.equal(defaults.backupEnabled, true);
  assert.equal(defaults.backupKeep, 5);
  assert.equal(defaults.runJsxEnabled, true);
  assert.equal(defaults.timeoutMs, 30000);
});

test("cloud-synced folders are detected", () => {
  assert.equal(cloudSyncWarning("C:\\MCP\\ae-bridge", {}), null);
  assert.match(cloudSyncWarning("C:\\Users\\u\\OneDrive\\Documents\\ae-bridge", {}), /cloud-synced/);
  assert.match(cloudSyncWarning("G:\\My Drive\\ae", {}), /cloud-synced/);
  assert.match(cloudSyncWarning("C:\\Users\\u\\Dropbox\\ae", {}), /cloud-synced/);
  assert.match(cloudSyncWarning("D:\\Sync\\Docs\\ae", { OneDrive: "D:\\Sync" }), /cloud-synced/);
});

test("withRetry retries EPERM/EBUSY and gives up on other errors", async () => {
  let calls = 0;
  const value = await withRetry(async () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error("locked"), { code: calls === 1 ? "EPERM" : "EBUSY" });
    return "ok";
  }, { delayMs: 1 });
  assert.equal(value, "ok");
  assert.equal(calls, 3);

  calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw Object.assign(new Error("nope"), { code: "ENOENT" }); }), /nope/);
  assert.equal(calls, 1);
});

test("writeFileAtomic replaces the target and leaves no temp files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "атомарно "));
  const file = path.join(dir, "command.json");
  await writeFileAtomic(file, "1");
  await writeFileAtomic(file, "2");
  assert.equal(await fs.readFile(file, "utf8"), "2");
  assert.deepEqual(await fs.readdir(dir), ["command.json"]);
  await fs.rm(dir, { recursive: true, force: true });
});

test("asciiJson escapes everything outside ASCII and round-trips", () => {
  const value = { s: "Слой «Титр» — 1\u2028", emoji: "🎬" };
  const text = asciiJson(value);
  assert.match(text, /^[\x00-\x7f]*$/);
  assert.deepEqual(JSON.parse(text), value);
});

test("PNG completeness check", async () => {
  assert.equal(isCompletePng(TINY_PNG), true);
  assert.equal(isCompletePng(TINY_PNG.subarray(0, TINY_PNG.length - 5)), false);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "png "));
  const file = path.join(dir, "f.png");
  await fs.writeFile(file, TINY_PNG.subarray(0, 30));
  setTimeout(() => fs.writeFile(file, TINY_PNG), 150);
  const buffer = await waitForCompletePng(file, 3000, 20);
  assert.equal(buffer.compare(TINY_PNG), 0);
  await assert.rejects(waitForCompletePng(path.join(dir, "missing.png"), 200, 20), /not fully written/);
  await fs.rm(dir, { recursive: true, force: true });
});
