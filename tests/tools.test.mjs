// Stage-3 tools through the real server and the mock panel: arguments, undo flags, chaining.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpClient, textOf } from "./mcp-client.mjs";
import { MockPanel, writePngSlowly } from "./mock-panel.mjs";
import { decodePng, encodePngRgb } from "../src/media.mjs";
import { TOOLS } from "../src/mcp-server.mjs";

let dir, client, panel;

async function setup(handler, env = {}) {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "ae mcp tools "));
  client = new McpClient({ AE_MCP_BRIDGE_DIR: dir, AE_MCP_TIMEOUT_MS: "3000", AE_MCP_PICKUP_TIMEOUT_MS: "1000", AE_MCP_POLL_MS: "20", AE_MCP_BACKUP: "0", ...env });
  await client.initialize();
  panel = new MockPanel(dir, { handler });
  await panel.start();
}

afterEach(async () => {
  client?.close();
  await panel?.stop();
  if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  client = panel = dir = undefined;
});

test("every tool has a description and an object schema", () => {
  for (const tool of TOOLS) {
    assert.ok(tool.description.length > 20, tool.name);
    assert.equal(tool.inputSchema.type, "object", tool.name);
    assert.match(tool.name, /^ae_[a-z_]+$/);
  }
  assert.equal(new Set(TOOLS.map(t => t.name)).size, TOOLS.length, "unique names");
});

test("template tools send args as data, with lib, and undo only when mutating", async () => {
  await setup(cmd => ({ data: { ok: true } }));
  const calls = [
    ["ae_create_comp", { name: "Комп \"1\"" }, true],
    ["ae_create_layer", { type: "text", text: "Привет" }, true],
    ["ae_set_keyframes", { layer: 1, property: "Opacity", keys: [{ time: 0, value: 0 }, { time: 1, value: 100, ease: "easy" }] }, true],
    ["ae_list_layer_effects", { layer: "Титр" }, false],
    ["ae_list_available_effects", { query: "blur" }, false],
    ["ae_get_layer_timing", { layer: 2 }, false]
  ];
  for (const [name, args, mutating] of calls) {
    const result = await client.call(name, args);
    assert.ok(!result.isError, `${name}: ${textOf(result)}`);
    const command = panel.executed.at(-1);
    assert.equal(command.tool, name);
    assert.deepEqual(command.args, args, `${name} args passed through unchanged`);
    assert.match(command.code, /^var lib = /, name);
    assert.equal(command.undo, mutating, `${name} undo flag`);
    if (mutating) assert.equal(command.undoName, `MCP: ${name}`);
  }
});

test("ae_capture_frame fills transparency with the comp background by default", async () => {
  // 1x1 fully transparent RGBA PNG
  const rgba = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  await setup(async cmd => {
    await fs.mkdir(path.dirname(cmd.args.path), { recursive: true });
    await fs.writeFile(cmd.args.path, rgba);
    return { data: { path: cmd.args.path, bgColor: [1, 0, 0] } };
  });
  const result = await client.call("ae_capture_frame", {});
  assert.ok(!result.isError, textOf(result));
  assert.match(textOf(result), /"background": "#ff0000"/);
  const image = decodePng(Buffer.from(result.content.find(c => c.type === "image").data, "base64"));
  assert.equal(image.channels, 3);

  const custom = await client.call("ae_capture_frame", { background: "#00ff00" });
  assert.match(textOf(custom), /"background": "#00ff00"/);

  const bad = await client.call("ae_capture_frame", { background: "purple-ish" });
  assert.equal(bad.isError, true);
});

test("ae_list_presets works without After Effects", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "presets "));
  await fs.writeFile(path.join(root, "Glow pulse.ffx"), "x");
  await setup(() => ({ data: null }));
  const result = await client.call("ae_list_presets", { roots: [root], query: "glow" });
  const report = JSON.parse(textOf(result));
  assert.equal(report.count, 1);
  assert.equal(report.presets[0].name, "Glow pulse");
  assert.equal(panel.executed.length, 0);
  await fs.rm(root, { recursive: true, force: true });
});

function clickWav(file, clicks) {
  const rate = 8000, frames = rate * 2, data = Buffer.alloc(frames * 2);
  for (let f = 0; f < frames; f++) {
    const t = f / rate;
    const loud = clicks.some(c => t >= c && t < c + 0.02);
    data.writeInt16LE(loud ? 30000 : 500, f * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFFxxxxWAVEfmt ", 0, "latin1");
  h.writeUInt32LE(36 + data.length, 4);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36, "latin1"); h.writeUInt32LE(data.length, 40);
  return fs.writeFile(file, Buffer.concat([h, data]));
}

test("ae_analyze_audio: layer source -> peaks in comp time -> markers, one chain", async () => {
  const wavFile = path.join(os.tmpdir(), `ae-mcp-аудио-${Date.now()}.wav`);
  await clickWav(wavFile, [0.5, 1.5]);
  await setup(cmd => {
    if (cmd.tool === "ae_get_audio_info") {
      return { data: { comp: "Main", layer: "Music", startTime: 10, inPoint: 10, outPoint: 12, stretch: 100, source: { file: wavFile } } };
    }
    if (cmd.tool === "ae_add_markers") return { data: { added: cmd.args.markers.length, errors: [] } };
    return { error: "unexpected " + cmd.tool };
  });
  const result = await client.call("ae_analyze_audio", { comp: "Main", layer: "Music", addMarkers: true, envelope: false });
  assert.ok(!result.isError, textOf(result));
  const report = JSON.parse(result.content[0].text);
  assert.deepEqual(report.peaks.map(p => Math.round(p.compTime * 10) / 10), [10.5, 11.5]);
  assert.equal(report.envelope, undefined);
  assert.equal(report.markers.added, 2);
  const markerCommand = panel.executed.find(c => c.tool === "ae_add_markers");
  assert.equal(markerCommand.undo, true);
  assert.equal(markerCommand.args.layer, "Music");
  assert.deepEqual(markerCommand.args.markers.map(m => m.comment), ["peak", "peak"]);
  await fs.rm(wavFile, { force: true });
});

test("ae_analyze_audio rejects non-WAV sources with a clear message", async () => {
  await setup(() => ({ data: { layer: "Song", startTime: 0, inPoint: 0, outPoint: 5, stretch: 100, source: { file: "E:\\music\\song.mp3" } } }));
  const result = await client.call("ae_analyze_audio", { layer: "Song" });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Only WAV/);
});

test("encodePngRgb output is a valid PNG for the flatten path", () => {
  const png = encodePngRgb(3, 2, Buffer.alloc(18, 7));
  assert.equal(decodePng(png).width, 3);
});

test("ae_capture_frames builds one contact sheet and cleans up", async () => {
  const red = encodePngRgb(64, 36, Buffer.alloc(64 * 36 * 3, 200));
  await setup(async cmd => {
    const frames = [];
    for (let i = 0; i < 4; i++) {
      const file = `${cmd.args.prefix}${i}.png`;
      await writePngSlowly(file, 30);
      await fs.writeFile(file, red);
      frames.push({ time: i * 0.5, frame: i * 12, path: file });
    }
    return { data: { composition: "Main", frameRate: 24, bgColor: [0, 0, 0], frames } };
  });
  const result = await client.call("ae_capture_frames", { count: 4 });
  assert.ok(!result.isError, textOf(result));
  const info = JSON.parse(result.content[0].text);
  assert.equal(info.grid, "2x2");
  assert.equal(info.frames.length, 4);
  const images = result.content.filter(c => c.type === "image");
  assert.equal(images.length, 1, "one sheet image");
  assert.equal(panel.executed[0].undo, false);
  assert.equal(panel.executed[0].args.maxFrames, 36);
  assert.deepEqual((await fs.readdir(path.join(dir, "frames"))).filter(n => n.startsWith("sheet-")), []);
});

test("ae_capture_frame compareWith returns the reference next to the frame", async () => {
  const ref = path.join(os.tmpdir(), `референс-${Date.now()}.png`);
  await fs.writeFile(ref, encodePngRgb(2, 2, Buffer.alloc(12, 9)));
  await setup(async cmd => {
    await fs.mkdir(path.dirname(cmd.args.path), { recursive: true });
    await fs.writeFile(cmd.args.path, encodePngRgb(2, 2, Buffer.alloc(12, 1)));
    return { data: { path: cmd.args.path, bgColor: [0, 0, 0] } };
  });
  const result = await client.call("ae_capture_frame", { compareWith: ref });
  assert.equal(result.content.filter(c => c.type === "image").length, 2);
  assert.match(textOf(result), /Reference image/);
  const bad = await client.call("ae_capture_frame", { compareWith: "C:/x/ref.psd" });
  assert.equal(bad.isError, true);
  await fs.rm(ref, { force: true });
});

test("ae_run_jsx_file sends the file content with lib and logs the path", async () => {
  const script = path.join(os.tmpdir(), `скрипт ${Date.now()}.jsx`);
  await fs.writeFile(script, "\uFEFFvar x = args.n * 2; x");
  await setup(cmd => ({ data: cmd.code.slice(-20) }));
  const result = await client.call("ae_run_jsx_file", { path: script, args: { n: 2 } });
  assert.ok(!result.isError, textOf(result));
  const command = panel.executed[0];
  assert.ok(command.code.endsWith(" var x = args.n * 2; x"), "BOM stripped, lib prepended");
  assert.equal(command.undo, true);
  const logs = await fs.readdir(path.join(dir, "logs"));
  assert.match(await fs.readFile(path.join(dir, "logs", logs[0]), "utf8"), /скрипт/);
  await fs.rm(script, { force: true });
});

test("AE_MCP_DISABLE_RUN_JSX also hides ae_run_jsx_file", async () => {
  await setup(() => ({ data: 1 }), { AE_MCP_DISABLE_RUN_JSX: "1" });
  const list = await client.request("tools/list", {});
  const names = list.result.tools.map(t => t.name);
  assert.ok(!names.includes("ae_run_jsx_file") && !names.includes("ae_run_jsx"));
  assert.ok(names.includes("ae_create_layer"), "template tools stay available");
  const result = await client.call("ae_run_jsx_file", { path: "C:/x.jsx" });
  assert.match(textOf(result), /disabled/);
});

test("prompts: list and get the motion guidelines", async () => {
  await setup(() => ({ data: 1 }));
  const init = client.messages.find(m => m.result?.serverInfo);
  assert.ok(init.result.capabilities.prompts);
  assert.match(init.result.instructions, /ae_capture_frames/);
  const list = await client.request("prompts/list", {});
  assert.deepEqual(list.result.prompts.map(p => p.name), ["motion-design-guidelines", "review-animation"]);
  const got = await client.request("prompts/get", { name: "review-animation", arguments: { comp: "Intro" } });
  const text = got.result.messages[0].content.text;
  assert.match(text, /track matte/);
  assert.match(text, /composition "Intro"/);
  const missing = await client.request("prompts/get", { name: "nope" });
  assert.equal(missing.error.code, -32602);
});
