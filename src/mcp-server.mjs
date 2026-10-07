#!/usr/bin/env node
// AE MCP Bridge v0.2.0 — MCP stdio server for Adobe After Effects.
//
// Inspired by "After Effects MCP by Ruslan Tsapenko" v0.1.0
//   YouTube: https://www.youtube.com/@RuslanTsapenko  Site: https://tsapenko.com/
// Ideas and tools ported from TheLlamainator/after-effects-mcp (MIT, (c) 2025 Dakkshin).
// Made by Claude Code & Yuriy Martyniuk. MIT License, see LICENSE.
//
// Zero dependencies, no build step: `node mcp-server.mjs`.
// Talks to ae-mcp-panel.jsx through files in the bridge folder (see the panel header).
// Tools are JSX templates evaluated by the panel; user data is passed separately as `args`.

import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { JSX, withLib } from "./jsx.mjs";
import { analyzeWav, contactSheet, decodePng, defaultPresetRoots, findPresets, flattenPng, parseColor, toRgb8 } from "./media.mjs";

export const VERSION = "0.2.0";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---- configuration -----------------------------------------------------------

// Must match resolveBridgeDir() in ae-mcp-panel.jsx.
export function defaultBridgeDir(platform = process.platform, home = os.homedir()) {
  if (platform === "win32") return "C:\\MCP\\ae-bridge";
  if (platform === "darwin") return path.posix.join(home, "Library", "Application Support", "ae-mcp-bridge");
  return path.posix.join(home, ".ae-mcp-bridge");
}

const CLOUD_MARKERS = [
  /onedrive/i, /google ?drive/i, /googledrive/i, /my drive/i, /dropbox/i, /icloud ?drive/i,
  /mobile documents/i, /[\\/]cloudstorage[\\/]/i, /yandex\.?disk/i, /box sync/i, /pcloud/i, /mega(sync)?[\\/]/i
];

export function cloudSyncWarning(dir, env = process.env) {
  const normalized = path.resolve(dir);
  const roots = [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial].filter(Boolean).map(p => path.resolve(p).toLowerCase());
  const insideRoot = roots.some(root => normalized.toLowerCase().startsWith(root));
  if (!insideRoot && !CLOUD_MARKERS.some(re => re.test(normalized))) return null;
  return `Bridge folder ${normalized} looks like a cloud-synced folder. Sync clients lock and delay files, ` +
    "which breaks the bridge. Set AE_MCP_BRIDGE_DIR to a local folder (for both the server and After Effects).";
}

const truthy = value => /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
const number = (value, fallback) => (value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : fallback);

export function loadConfig(env = process.env) {
  const bridgeDir = path.resolve(env.AE_MCP_BRIDGE_DIR || defaultBridgeDir());
  return {
    bridgeDir,
    timeoutMs: number(env.AE_MCP_TIMEOUT_MS, 30000),
    pickupTimeoutMs: number(env.AE_MCP_PICKUP_TIMEOUT_MS, 10000),
    pollMs: number(env.AE_MCP_POLL_MS, 50),
    runJsxEnabled: !truthy(env.AE_MCP_DISABLE_RUN_JSX),
    backupEnabled: env.AE_MCP_BACKUP === undefined ? true : truthy(env.AE_MCP_BACKUP),
    backupKeep: Math.max(1, number(env.AE_MCP_BACKUP_KEEP, 5)),
    backupDir: path.resolve(env.AE_MCP_BACKUP_DIR || path.join(bridgeDir, "backups")),
    logEnabled: env.AE_MCP_LOG === undefined ? true : truthy(env.AE_MCP_LOG),
    logRetentionDays: number(env.AE_MCP_LOG_DAYS, 30)
  };
}

// ---- file helpers ------------------------------------------------------------

// Windows: rename/unlink over a file another process (the panel, antivirus) holds open
// fails with EPERM/EBUSY/EACCES for a few milliseconds. Retry instead of failing.
const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES", "EMFILE", "ENFILE", "ENOTEMPTY"]);

export async function withRetry(fn, { attempts = 25, delayMs = 20 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!RETRY_CODES.has(error.code) || attempt >= attempts) throw error;
      await sleep(delayMs * Math.min(attempt, 5));
    }
  }
}

export async function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  await withRetry(() => fs.writeFile(tmp, text, "utf8"));
  try {
    await withRetry(() => fs.rename(tmp, file));
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

export async function readJson(file) {
  try {
    const text = await withRetry(() => fs.readFile(file, "utf8"));
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

// JSON with every non-ASCII character escaped, so the panel decodes it correctly
// whatever encoding ExtendScript assumes for the file (Cyrillic paths and names).
export function asciiJson(value) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, ch => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isCompletePng(buffer) {
  return buffer.length >= 20 &&
    buffer.subarray(0, 8).equals(PNG_SIGNATURE) &&
    buffer.subarray(buffer.length - 8, buffer.length - 4).toString("latin1") === "IEND";
}

// saveFrameToPng is undocumented and may return before the file is fully written:
// wait until the PNG exists, its size is stable and it ends with the IEND chunk.
export async function waitForCompletePng(file, timeoutMs = 15000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  let lastSize = -1;
  while (Date.now() < deadline) {
    try {
      const buffer = await fs.readFile(file);
      if (buffer.length > 0 && buffer.length === lastSize && isCompletePng(buffer)) return buffer;
      lastSize = buffer.length;
    } catch (error) {
      if (error.code !== "ENOENT" && !RETRY_CODES.has(error.code)) throw error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`PNG was not fully written within ${timeoutMs} ms: ${file}`);
}

async function removeOlderThan(dir, maxAgeMs, filter = () => true) {
  let names;
  try { names = await fs.readdir(dir); } catch { return; }
  const now = Date.now();
  for (const name of names) {
    if (!filter(name)) continue;
    const file = path.join(dir, name);
    try {
      const stat = await fs.stat(file);
      if (stat.isFile() && now - stat.mtimeMs > maxAgeMs) await withRetry(() => fs.rm(file, { force: true }));
    } catch { /* ignore races */ }
  }
}

function timestamp(date = new Date()) {
  const p = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;
}

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---- bridge --------------------------------------------------------------------

export class BridgeError extends Error {}

export class Bridge {
  constructor(config) {
    this.config = config;
    const dir = config.bridgeDir;
    this.paths = {
      dir,
      command: path.join(dir, "command.json"),
      ack: path.join(dir, "ack.json"),
      status: path.join(dir, "panel-status.json"),
      results: path.join(dir, "results"),
      frames: path.join(dir, "frames"),
      logs: path.join(dir, "logs")
    };
    this.pending = new Map();    // commandId -> entry, until its result is collected
    this.completed = new Map();  // commandId -> text content, for repeated ae_get_result calls
    this.backedUp = new Set();   // project paths backed up during this session
    this.lastProjectPath = undefined;
  }

  resultFile(commandId) {
    return path.join(this.paths.results, `${commandId}.json`);
  }

  async init() {
    for (const dir of [this.paths.dir, this.paths.results, this.paths.frames, this.paths.logs]) {
      await fs.mkdir(dir, { recursive: true });
    }
    await removeOlderThan(this.paths.results, 60 * 60 * 1000);
    await removeOlderThan(this.paths.frames, 10 * 60 * 1000);
    await removeOlderThan(this.paths.dir, 10 * 60 * 1000, name => name.endsWith(".tmp"));
    await removeOlderThan(this.paths.logs, this.config.logRetentionDays * 24 * 60 * 60 * 1000);
  }

  readPanelStatus() {
    return readJson(this.paths.status);
  }

  // The command the panel is executing right now, or null.
  async busyState() {
    const ack = await readJson(this.paths.ack);
    if (!ack || !ack.commandId) return null;
    if (fsSync.existsSync(this.resultFile(ack.commandId))) return null;
    const status = await this.readPanelStatus();
    // A heartbeat newer than the ack means the panel restarted and the ack is stale.
    if (status && status.heartbeat > ack.startedAt) return null;
    return ack;
  }

  async log(record) {
    if (!this.config.logEnabled) return;
    const line = JSON.stringify({ time: new Date().toISOString(), ...record }, (key, value) =>
      typeof value === "string" && value.length > 20000 ? value.slice(0, 20000) + "...[truncated]" : value) + "\n";
    const file = path.join(this.paths.logs, `ae-mcp-${timestamp().slice(0, 10)}.log`);
    try { await withRetry(() => fs.appendFile(file, line, "utf8")); }
    catch (error) { process.stderr.write(`ae-mcp: cannot write log: ${error.message}\n`); }
  }

  // Copies the current .aep before the first mutating command for that project in this session.
  async ensureBackup() {
    const { backupEnabled, backupDir, backupKeep } = this.config;
    if (!backupEnabled) return null;
    const status = await this.readPanelStatus();
    const projectPath = status?.projectPath ?? this.lastProjectPath;
    if (!projectPath) return null;
    const key = path.resolve(projectPath).toLowerCase();
    if (this.backedUp.has(key)) return null;
    this.backedUp.add(key);
    try {
      await fs.access(projectPath);
      await fs.mkdir(backupDir, { recursive: true });
      const base = path.basename(projectPath, path.extname(projectPath));
      const target = path.join(backupDir, `${base}_${timestamp()}${path.extname(projectPath) || ".aep"}`);
      await withRetry(() => fs.copyFile(projectPath, target));
      const pattern = new RegExp(`^${escapeRegExp(base)}_\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}\\.aep$`, "i");
      const old = (await fs.readdir(backupDir)).filter(name => pattern.test(name)).sort().reverse().slice(backupKeep);
      for (const name of old) await withRetry(() => fs.rm(path.join(backupDir, name), { force: true }));
      await this.log({ event: "backup", projectPath, backup: target });
      return { backup: target };
    } catch (error) {
      await this.log({ event: "backup-failed", projectPath, error: error.message });
      return { warning: `Project backup failed (${error.message}); the command ran anyway.` };
    }
  }

  // Sends a command and waits up to timeoutMs. Returns { entry, envelope } where envelope
  // is null if After Effects is still executing it.
  async dispatch(tool, { code, args = {}, undo = false, timeoutMs, meta = {} }) {
    const busy = await this.busyState();
    if (busy) {
      const seconds = Math.round((Date.now() - busy.startedAt) / 1000);
      throw new BridgeError(`After Effects is still executing ${busy.tool} (commandId ${busy.commandId}, ${seconds}s). ` +
        "Nothing was sent. Call ae_get_result with that commandId, or retry later.");
    }
    const commandId = crypto.randomUUID();
    const createdAt = Date.now();
    const command = {
      commandId, tool, code, args, undo, undoName: `MCP: ${tool}`,
      createdAt, pickupDeadline: createdAt + this.config.pickupTimeoutMs
    };
    const entry = { commandId, tool, createdAt, pickupDeadline: command.pickupDeadline, picked: false, ...meta };
    this.pending.set(commandId, entry);
    await this.log({ event: "command", commandId, tool, args, code: meta.logCode });
    await writeFileAtomic(this.paths.command, asciiJson(command));
    const envelope = await this.waitFor(entry, timeoutMs ?? this.config.timeoutMs);
    return { entry, envelope };
  }

  // Polls for the result. Returns the envelope, or null when waitMs elapses while the
  // command is still running. Throws if the panel never picked the command up.
  async waitFor(entry, waitMs) {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const envelope = await this.takeResult(entry.commandId);
      if (envelope) return envelope;
      if (!entry.picked) {
        const ack = await readJson(this.paths.ack);
        if (ack && ack.commandId === entry.commandId) {
          entry.picked = true;
        } else if (Date.now() > entry.pickupDeadline) {
          if (await this.withdraw(entry)) throw new BridgeError(await this.notRespondingMessage());
          continue;
        }
      }
      if (Date.now() >= deadline) return null;
      await sleep(this.config.pollMs);
    }
  }

  // Removes a command the panel did not pick up in time. False if it started after all.
  async withdraw(entry) {
    const command = await readJson(this.paths.command);
    if (command && command.commandId === entry.commandId) {
      await withRetry(() => fs.rm(this.paths.command, { force: true }));
    }
    const ack = await readJson(this.paths.ack);
    if (ack && ack.commandId === entry.commandId) {
      entry.picked = true;
      return false;
    }
    if (fsSync.existsSync(this.resultFile(entry.commandId))) return false;
    this.pending.delete(entry.commandId);
    await this.log({ event: "not-picked-up", commandId: entry.commandId, tool: entry.tool });
    return true;
  }

  async takeResult(commandId) {
    const file = this.resultFile(commandId);
    const envelope = await readJson(file);
    if (!envelope) return null;
    await withRetry(() => fs.rm(file, { force: true }));
    // Do not leave a finished command behind: a restarted panel would see it as new (and report it expired).
    const command = await readJson(this.paths.command);
    if (command && command.commandId === commandId) await withRetry(() => fs.rm(this.paths.command, { force: true })).catch(() => {});
    if (envelope.project !== undefined) this.lastProjectPath = envelope.project;
    return envelope;
  }

  async notRespondingMessage() {
    const status = await this.readPanelStatus();
    const where = `Bridge folder: ${this.paths.dir}.`;
    const fix = "In After Effects open Window > ae-mcp-panel.jsx (or File > Scripts > Run Script File) and click Start bridge.";
    if (!status) return `After Effects bridge panel has never run in this bridge folder. ${fix} ${where} Nothing was executed.`;
    if (!status.running) return `After Effects bridge panel is stopped. ${fix} Nothing was executed.`;
    const age = Math.round((Date.now() - status.heartbeat) / 1000);
    return `After Effects did not pick up the command within ${this.config.pickupTimeoutMs} ms ` +
      `(last panel heartbeat ${age}s ago). AE may be busy (rendering, a modal dialog is open) or the panel was closed. ` +
      `Nothing was executed. ${where}`;
  }
}

// ---- tools ---------------------------------------------------------------------

const compRefSchema = {
  type: ["string", "number"],
  description: "Composition name or numeric item id. Omit to use the active composition."
};

const jsonText = data => (typeof data === "string" ? data : JSON.stringify(data ?? null, null, 2));

function checkBackground(value) {
  const background = value ?? "comp";
  if (background !== "comp" && background !== "transparent") {
    try { parseColor(background); } catch (error) { throw new BridgeError(error.message); }
  }
  return background;
}

const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
const imageMime = file => IMAGE_TYPES[path.extname(file).toLowerCase()];

function clampTimeout(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return Math.min(Math.max(Number(value) || fallback, 1000), 60 * 60 * 1000);
}

const layerRefSchema = { type: ["string", "number"], description: "Layer name or 1-based index." };
const propertySchema = {
  type: ["string", "array"],
  description: "Property path: 'Transform/Position', 'Opacity', 'Source Text', 'Effects/Gaussian Blur/Blurriness' " +
    "(names, matchNames or 1-based indices, '/'-separated or as an array)."
};
const colorSchema = { type: ["string", "array"], description: "Color: '#RRGGBB' or [r, g, b] in 0..1 (0..255 also accepted)." };
const timeSchema = { type: "number", description: "Time in seconds (composition time)." };

// Builds a tool whose work is one JSX template. mutating: back up the project and use one undo group.
function templateTool(name, description, properties, { code, mutating = false, required = [], timeoutMs } = {}) {
  return {
    name,
    description: description + (mutating ? " One undo step." : " Changes nothing."),
    inputSchema: { type: "object", properties, ...(required.length ? { required } : {}) },
    run: (bridge, args) => runCommand(bridge, name, { code: withLib(code), args, undo: mutating, mutating, timeoutMs })
  };
}

export const TOOLS = [
  {
    name: "ae_health",
    description: "Check the After Effects bridge: server and panel versions, AE version, open project, active composition, panel status. Changes nothing.",
    inputSchema: { type: "object", properties: {} },
    run: health
  },
  {
    name: "ae_run_jsx",
    description: "Run arbitrary ExtendScript (ES3 JavaScript) inside After Effects. The value of the last expression is returned " +
      "(AE objects come back as short summaries). Pass data through `args` (available as the `args` variable) instead of " +
      "pasting it into the code. Helpers: mcp.findComp(nameOrId?), mcp.findLayer(comp, nameOrIndex), mcp.activeComp(), " +
      "mcp.layerType(layer), mcp.projectInfo(); lib.prop(layer, 'Transform/Position'), lib.setValue(prop, value, time?), " +
      "lib.color('#ff8800'), lib.tree(propertyGroup, depth, withValues). The whole call is one undo step. If it runs longer " +
      "than the timeout, a commandId is returned: fetch the result with ae_get_result, do not re-send the code.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "ExtendScript code. ES3 only: var, no arrow functions, no let/const." },
        args: { type: "object", description: "Optional data exposed to the code as `args`." },
        timeoutMs: { type: "number", description: "How long to wait before returning a commandId (default 30000, max 3600000)." }
      },
      required: ["code"]
    },
    run: (bridge, args) => {
      const code = String(args.code ?? "");
      return runCommand(bridge, "ae_run_jsx", {
        code: withLib(code), args: args.args ?? {}, undo: true, mutating: true,
        timeoutMs: clampTimeout(args.timeoutMs, bridge.config.timeoutMs), meta: { logCode: code }
      });
    }
  },
  {
    name: "ae_get_result",
    description: "Fetch the result of a command that was still running when its tool call timed out. Never re-sends the command.",
    inputSchema: {
      type: "object",
      properties: {
        commandId: { type: "string" },
        waitMs: { type: "number", description: "Wait up to this long for the result (default 0, max 600000)." }
      },
      required: ["commandId"]
    },
    run: getResult
  },
  templateTool("ae_list_project", "List the open project: compositions with their layers (index, name, type, in/out points) " +
    "and all other items (folders, footage, solids) with their folder and usedIn count (0 = unused).",
    { items: { type: "boolean", description: "Include non-composition items (default true)." } }, { code: JSX.listProject }),
  {
    name: "ae_guidelines",
    description: "Read the full motion-design and workflow guidelines for this bridge (easing, bounce, text animators, " +
      "stagger, track mattes, motion blur, review loop, ExtendScript pitfalls). Call it once before designing or animating. " +
      "Does not contact After Effects.",
    inputSchema: { type: "object", properties: {} },
    run: async () => ({ content: [{ type: "text", text: MOTION_GUIDELINES }] })
  },
  {
    name: "ae_save_project",
    description: "Save the open project. With no path saves to its current file; with an absolute .aep path saves there (Save As).",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Optional absolute .aep path." } } },
    run: (bridge, args) => runCommand(bridge, "ae_save_project", { code: JSX.saveProject, args: { path: args.path }, mutating: true })
  },
  {
    name: "ae_open_project",
    description: "Open an .aep project in After Effects (closing the current one). If the current project has unsaved changes " +
      "you must choose save: true or discard: true. Use this instead of opening/closing projects in ae_run_jsx, which breaks AE's undo history.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the .aep file." },
        save: { type: "boolean", description: "Save the current project's changes before closing it." },
        discard: { type: "boolean", description: "Close the current project without saving its changes." }
      },
      required: ["path"]
    },
    run: (bridge, args) => {
      if (args.save && args.discard) throw new BridgeError("Pass either save or discard, not both.");
      return runCommand(bridge, "ae_open_project", {
        code: withLib(JSX.openProject), args: { path: path.resolve(String(args.path ?? "")), save: args.save, discard: args.discard },
        mutating: Boolean(args.save), timeoutMs: Math.max(bridge.config.timeoutMs, 120000)
      });
    }
  },
  {
    name: "ae_capture_frame",
    description: "Render one frame of a composition to PNG and return it as an image for visual inspection. " +
      "Transparent areas are filled with the composition background color by default. Changes nothing.",
    inputSchema: {
      type: "object",
      properties: {
        comp: compRefSchema,
        time: { type: "number", description: "Time in seconds. Omit to use the composition's current time." },
        background: { type: ["string", "array"], description: "'comp' (default: composition background color), 'transparent', or a color '#RRGGBB' / [r,g,b]." },
        path: { type: "string", description: "Optional absolute PNG path to keep the file (saved as rendered). By default a temporary file is used and deleted." },
        compareWith: { type: "string", description: "Optional absolute path to a reference image (PNG/JPEG/WebP/GIF), returned next to the frame for comparison." }
      }
    },
    run: (bridge, args) => {
      const keep = Boolean(args.path);
      const background = checkBackground(args.background);
      const reference = args.compareWith ? path.resolve(args.compareWith) : null;
      if (reference && !imageMime(reference)) throw new BridgeError(`compareWith must be a PNG, JPEG, WebP or GIF image: ${reference}`);
      const file = keep ? path.resolve(args.path) : path.join(bridge.paths.frames, `frame-${crypto.randomUUID()}.png`);
      return runCommand(bridge, "ae_capture_frame", {
        code: JSX.captureFrame,
        args: { comp: args.comp, time: args.time, path: file },
        timeoutMs: clampTimeout(undefined, Math.max(bridge.config.timeoutMs, 60000)),
        meta: { post: "frame", keepFrame: keep, background, reference }
      });
    }
  },
  {
    name: "ae_capture_frames",
    description: "Render several frames of a composition into ONE contact-sheet image (grid with time labels) to judge an " +
      "animation: timing, easing, overlaps, elements appearing outside their containers. Give explicit times, or start/end " +
      "with count (default 9 evenly spaced) or step. Changes nothing.",
    inputSchema: {
      type: "object",
      properties: {
        comp: compRefSchema,
        times: { type: "array", items: { type: "number" }, description: "Explicit times in seconds." },
        start: { type: "number", description: "Default 0." },
        end: { type: "number", description: "Default: last frame of the comp." },
        count: { type: "number", description: "Number of frames between start and end (default 9, max 36)." },
        step: { type: "number", description: "Seconds between frames, instead of count." },
        columns: { type: "number", description: "Grid columns (default: square-ish)." },
        maxWidth: { type: "number", description: "Sheet width limit in pixels (default 2048)." },
        background: { type: ["string", "array"], description: "'comp' (default), 'transparent' (shown as gray) or a color." }
      }
    },
    run: (bridge, args) => {
      const background = checkBackground(args.background);
      const prefix = path.join(bridge.paths.frames, `sheet-${crypto.randomUUID()}-`);
      return runCommand(bridge, "ae_capture_frames", {
        code: withLib(JSX.captureFrames),
        args: { comp: args.comp, times: args.times, start: args.start, end: args.end, count: args.count, step: args.step, prefix, maxFrames: 36 },
        timeoutMs: Math.max(bridge.config.timeoutMs, 120000),
        meta: { post: "sheet", background, columns: args.columns, maxWidth: Math.min(Math.max(Number(args.maxWidth) || 2048, 256), 4096) }
      });
    }
  },
  templateTool("ae_get_selection", "What the user selected in After Effects: project items, layers of the active comp, and selected " +
    "properties with their paths, values, keyframes (time, value, interpolation, ease) and property trees for selected groups " +
    "(e.g. a text animator). Use it when the user says 'this', 'the selected layer', 'look at what I selected'.", {
    depth: { type: "number", description: "Tree depth for selected groups (default 3)." }
  }, { code: JSX.selection }),
  templateTool("ae_inspect", "Deep property tree of a layer or of one of its groups, with values, keyframes and easing, " +
    "expressions. By default only modified properties are listed (modifiedOnly: false lists everything).", {
    comp: compRefSchema,
    layer: layerRefSchema,
    property: { ...propertySchema, description: "Optional group or property path to start from, e.g. 'Text/Animators/Animator 1'." },
    depth: { type: "number", description: "Default 6." },
    modifiedOnly: { type: "boolean", description: "Default true." },
    values: { type: "boolean", description: "Default true." },
    keys: { type: "boolean", description: "Include keyframe details (default true)." },
    maxNodes: { type: "number", description: "Default 800." }
  }, { code: JSX.inspect, required: ["layer"] }),
  templateTool("ae_set_comp", "Change composition settings: name, size, duration, frame rate, background color, motion blur switch " +
    "and shutter angle, work area, current time; open: true opens it in the viewer.", {
    comp: compRefSchema,
    name: { type: "string" },
    width: { type: "number" },
    height: { type: "number" },
    duration: { type: "number" },
    frameRate: { type: "number" },
    bgColor: colorSchema,
    motionBlur: { type: "boolean", description: "Composition motion blur switch." },
    shutterAngle: { type: "number" },
    workAreaStart: { type: "number" },
    workAreaDuration: { type: "number" },
    time: { type: "number", description: "Move the current-time indicator." },
    open: { type: "boolean" }
  }, { code: JSX.setComp, mutating: true }),
  templateTool("ae_copy_animation", "Copy a property or a whole property group with its keyframes, easing and expressions from one " +
    "layer to other layers (like Ctrl+C / Ctrl+V), optionally staggered. Works for text animators " +
    "('Text/Animators/Animator 1'), effects ('Effects/Gaussian Blur'), masks and single properties ('Transform/Position'). " +
    "Target n (1-based in the given order) is shifted by offset + n * stagger frames.", {
    comp: compRefSchema,
    from: { ...layerRefSchema, description: "Source layer." },
    property: { ...propertySchema, description: "Property or group to copy." },
    to: { type: ["array", "string", "number"], description: "Target layers. Omit to use the selected layers." },
    stagger: { type: "number", description: "Frames between consecutive targets (default 0)." },
    offset: { type: "number", description: "Extra time shift in seconds (default 0)." },
    replace: { type: "boolean", description: "For indexed groups (animators, effects): remove a same-named one on the target first." }
  }, { code: JSX.copyAnimation, mutating: true, required: ["from", "property"] }),
  templateTool("ae_add_text_animator", "Add a text animator reveal (the motion-design way, instead of animating Transform): " +
    "offsets such as position [0, 40], opacity 0, blur 16 are applied through a Range Selector that is animated away. " +
    "shape 'rampUp' (default for characters/words) slides a soft window over the text so letters overlap in a wave; " +
    "'square' (default for lines) animates Start 0 -> 100 with strong ease. mode 'out' mirrors the reveal (last units " +
    "leave first). Several layers can be staggered.", {
    comp: compRefSchema,
    layers: { type: ["array", "string", "number"], description: "Text layers. Omit to use the selected layers." },
    offsets: { type: "object", description: "{ position, anchorPoint, scale, rotation, opacity, blur, tracking, fillColor, skew }. Default { position: [0, 40], opacity: 0, blur: 16 }." },
    basedOn: { type: "string", enum: ["characters", "charactersExcludingSpaces", "words", "lines"], description: "Default characters." },
    shape: { type: "string", enum: ["rampUp", "square"], description: "rampUp = overlapping wave, square = one unit after another." },
    waveWidth: { type: "number", description: "rampUp: width of the soft window in % of the text (default 40; larger = more overlap)." },
    start: { type: "number", description: "Start time in seconds (default: layer in-point)." },
    duration: { type: "number", description: "Default 1." },
    stagger: { type: "number", description: "Frames between layers (default 0)." },
    influence: { type: "number", description: "Ease influence of the selector keys (default 85 for square, 50 for rampUp)." },
    ease: { type: "object", description: "Range Selector Advanced ease: { high, low } in percent." },
    mode: { type: "string", enum: ["in", "out"] },
    name: { type: "string", description: "Animator name (default 'MCP Reveal')." }
  }, { code: JSX.addTextAnimator, mutating: true }),
  {
    name: "ae_render_preview",
    description: "Render a composition (or a time range) through the Render Queue to an H.264 MP4 or a PNG sequence for the " +
      "user to watch. Other queued items are paused during the render and restored. Blocks After Effects while rendering; " +
      "long renders return a commandId for ae_get_result.",
    inputSchema: {
      type: "object",
      properties: {
        comp: compRefSchema,
        format: { type: "string", enum: ["mp4", "png"], description: "Default mp4." },
        start: { type: "number" },
        duration: { type: "number" },
        half: { type: "boolean", description: "Render at half resolution (faster)." },
        path: { type: "string", description: "Output file (mp4) or folder (png). Default: <bridge>/renders." },
        timeoutMs: { type: "number", description: "Default 600000." }
      }
    },
    run: (bridge, args) => {
      const format = args.format === "png" ? "png" : "mp4";
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      let file;
      if (format === "mp4") file = args.path ? path.resolve(args.path) : path.join(bridge.paths.dir, "renders", `render-${stamp}.mp4`);
      else file = path.join(args.path ? path.resolve(args.path) : path.join(bridge.paths.dir, "renders", `render-${stamp}`), "frame_[#####].png");
      return runCommand(bridge, "ae_render_preview", {
        code: withLib(JSX.renderPreview),
        args: { comp: args.comp, format, start: args.start, duration: args.duration, half: args.half, path: file },
        timeoutMs: clampTimeout(args.timeoutMs ?? 600000, 600000)
      });
    }
  },
  {
    name: "ae_run_jsx_file",
    description: "Run an ExtendScript .jsx/.js file from disk (a library of reusable scripts) with optional `args`, like ae_run_jsx. " +
      "One undo step.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the script." },
        args: { type: "object" },
        timeoutMs: { type: "number" }
      },
      required: ["path"]
    },
    run: async (bridge, args) => {
      if (!bridge.config.runJsxEnabled) throw new BridgeError("ae_run_jsx_file is disabled on this server (AE_MCP_DISABLE_RUN_JSX).");
      const file = path.resolve(String(args.path ?? ""));
      let code;
      try { code = (await fs.readFile(file, "utf8")).replace(/^﻿/, ""); }
      catch (error) { throw new BridgeError(`Cannot read ${file}: ${error.message}`); }
      return runCommand(bridge, "ae_run_jsx_file", {
        code: withLib(code), args: args.args ?? {}, undo: true, mutating: true,
        timeoutMs: clampTimeout(args.timeoutMs, bridge.config.timeoutMs), meta: { logCode: `// ${file}\n${code}` }
      });
    }
  },

  // ---- compositions and layers
  templateTool("ae_create_comp", "Create a composition (and open it in the viewer unless open: false).", {
    name: { type: "string" },
    width: { type: "number", description: "Default 1920." },
    height: { type: "number", description: "Default 1080." },
    duration: { type: "number", description: "Seconds, default 10." },
    frameRate: { type: "number", description: "Default 30." },
    pixelAspect: { type: "number", description: "Default 1." },
    bgColor: colorSchema,
    motionBlur: { type: "boolean", description: "Composition motion blur switch." },
    open: { type: "boolean" }
  }, { code: JSX.createComp, mutating: true }),
  templateTool("ae_create_layer", "Create a text, shape, solid, adjustment or null layer. Text is center-justified by default; " +
    "use ae_center_layers to center any layer visually.", {
    comp: compRefSchema,
    type: { type: "string", enum: ["text", "shape", "solid", "adjustment", "null"] },
    name: { type: "string" },
    text: { type: "string", description: "text: the text." },
    font: { type: "string", description: "text: PostScript font name, e.g. 'Arial-BoldMT'." },
    fontSize: { type: "number" },
    justification: { type: "string", enum: ["left", "center", "right"] },
    color: { ...colorSchema, description: "text fill / shape fill / solid color." },
    strokeColor: colorSchema,
    strokeWidth: { type: "number" },
    shape: { type: "string", enum: ["rectangle", "ellipse", "polygon", "star"], description: "shape: default rectangle." },
    size: { type: ["array", "number"], description: "shape: [w, h] (default 200x200); solid/adjustment: [w, h] (default comp size)." },
    roundness: { type: "number", description: "shape rectangle corner roundness." },
    points: { type: "number", description: "shape polygon/star points." },
    fill: { type: "boolean", description: "shape: add a fill (default true)." },
    position: { type: "array", description: "[x, y] in comp pixels. Default: center." },
    startTime: timeSchema,
    duration: { type: "number", description: "Layer duration in seconds (default: to the end of the comp)." }
  }, { code: JSX.createLayer, mutating: true, required: ["type"] }),
  templateTool("ae_set_layer", "Change layer settings and transform: name, enabled, 3D, label, parent, timing, anchorPoint, position, " +
    "scale, rotation, opacity, and text (text, font, fontSize, fillColor, strokeColor, strokeWidth, justification, tracking, leading). " +
    "Pass time to write keyframes instead of static values.", {
    comp: compRefSchema,
    layer: layerRefSchema,
    name: { type: "string" },
    enabled: { type: "boolean" },
    threeD: { type: "boolean" },
    label: { type: "number", description: "Label color index 0..16." },
    parent: { type: ["string", "number", "null"], description: "Parent layer, or null to unparent." },
    startTime: timeSchema,
    inPoint: timeSchema,
    outPoint: timeSchema,
    anchorPoint: { type: "array" },
    position: { type: "array" },
    scale: { type: ["array", "number"], description: "Percent: 50 or [50, 50]." },
    rotation: { type: "number", description: "Degrees (Z rotation for 3D layers)." },
    opacity: { type: "number", description: "0..100." },
    text: { type: "string" },
    font: { type: "string" },
    fontSize: { type: "number" },
    fillColor: colorSchema,
    strokeColor: colorSchema,
    strokeWidth: { type: "number" },
    justification: { type: "string", enum: ["left", "center", "right"] },
    tracking: { type: "number" },
    leading: { type: "number" },
    motionBlur: { type: "boolean", description: "Layer motion blur switch; turning it on also enables the comp switch." },
    trackMatte: { type: ["string", "number", "null"], description: "Matte layer (AE 2023+), or null to remove the track matte." },
    trackMatteType: { type: "string", enum: ["alpha", "alphaInverted", "luma", "lumaInverted"], description: "Default alpha." },
    matteVisible: { type: "boolean", description: "Show (true) or hide the matte layer itself after assigning it." },
    time: { type: "number", description: "Optional: set transform/text values as keyframes at this time." }
  }, { code: JSX.setLayer, mutating: true, required: ["layer"] }),
  templateTool("ae_center_layers", "Center layers in the composition. By default the anchor point is moved to the visual center " +
    "of the layer content first (sourceRectAtTime), so text and shapes end up truly centered.", {
    comp: compRefSchema,
    layers: { type: ["array", "string", "number"], description: "Layer names/indices. Omit to use the selected layers." },
    all: { type: "boolean", description: "Center every layer." },
    axis: { type: "string", enum: ["both", "horizontal", "vertical"] },
    anchor: { type: "boolean", description: "Move the anchor point to the content center first (default true)." }
  }, { code: JSX.centerLayers, mutating: true }),
  templateTool("ae_get_layer_timing", "Layer timing in seconds and frames: start, in/out points, duration, source in/out, stretch.", {
    comp: compRefSchema, layer: layerRefSchema
  }, { code: JSX.layerTiming, required: ["layer"] }),

  // ---- properties and animation
  templateTool("ae_set_property", "Set any property of a layer or of its effects by path. With time, sets a keyframe; " +
    "without time the property must have no keyframes.", {
    comp: compRefSchema,
    layer: layerRefSchema,
    property: propertySchema,
    value: { description: "Number, array, color ('#RRGGBB' for color properties), text or text-style object for Source Text." },
    time: timeSchema
  }, { code: JSX.setProperty, mutating: true, required: ["layer", "property", "value"] }),
  templateTool("ae_set_keyframes", "Add keyframes to a layer or effect property and set their interpolation. " +
    "ease: linear | hold | bezier | easy (Easy Ease) | easyIn | easyOut; influence 0.1..100 (default 33.3); " +
    "easeIn/easeOut: { speed, influence } for custom temporal ease; spatial props also accept spatialAutoBezier, " +
    "spatialContinuous, roving, inTangent, outTangent.", {
    comp: compRefSchema,
    layer: layerRefSchema,
    property: propertySchema,
    keys: {
      type: "array",
      description: "[{ time, value, ease?, influence?, easeIn?, easeOut?, ... }]. Omit value to only change an existing key's ease.",
      items: { type: "object" }
    },
    ease: { type: "string", enum: ["linear", "hold", "bezier", "easy", "easyIn", "easyOut"], description: "Default ease for all keys." },
    influence: { type: "number", description: "Default influence for all keys." },
    replace: { type: "boolean", description: "Remove existing keyframes of this property first." }
  }, { code: JSX.setKeyframes, mutating: true, required: ["layer", "property", "keys"] }),
  templateTool("ae_set_expression", "Set an expression on a layer or effect property, or remove it with an empty string. " +
    "Reports expressionError if AE rejects it.", {
    comp: compRefSchema,
    layer: layerRefSchema,
    property: propertySchema,
    expression: { type: "string" }
  }, { code: JSX.setExpression, mutating: true, required: ["layer", "property", "expression"] }),

  // ---- effects and presets
  templateTool("ae_list_available_effects", "Search effects installed in After Effects by display name, matchName or category.", {
    query: { type: "string" },
    max: { type: "number", description: "Default 200." },
    includeObsolete: { type: "boolean" }
  }, { code: JSX.listAvailableEffects }),
  templateTool("ae_apply_effect", "Apply an effect to a layer by display name or matchName and optionally set its properties. " +
    "Returns the effect's properties so they can be adjusted next.", {
    comp: compRefSchema,
    layer: layerRefSchema,
    effect: { type: "string", description: "e.g. 'Gaussian Blur' or 'ADBE Gaussian Blur 2'." },
    name: { type: "string", description: "Optional new name for the effect instance." },
    settings: { type: "object", description: "{ propertyNameOrPath: value }, e.g. { Blurriness: 20 }." }
  }, { code: JSX.applyEffect, mutating: true, required: ["layer", "effect"] }),
  templateTool("ae_list_layer_effects", "List the effects on a layer with their property tree and current values.", {
    comp: compRefSchema,
    layer: layerRefSchema,
    depth: { type: "number", description: "Property tree depth (default 2)." },
    values: { type: "boolean", description: "Include values (default true)." }
  }, { code: JSX.listLayerEffects, required: ["layer"] }),
  templateTool("ae_remove_effects", "Remove effects from a layer by name, matchName or index (or an array of them), or all.", {
    comp: compRefSchema,
    layer: layerRefSchema,
    effect: { type: ["string", "number", "array"] },
    all: { type: "boolean" }
  }, { code: JSX.removeEffects, mutating: true, required: ["layer"] }),
  {
    name: "ae_list_presets",
    description: "Find animation presets (.ffx) in the standard Adobe preset folders or given folders. Words in query must all " +
      "match the preset path, e.g. 'blur in'. Changes nothing.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        roots: { type: "array", items: { type: "string" }, description: "Folders to search instead of the defaults." },
        max: { type: "number", description: "Default 200." }
      }
    },
    run: async (bridge, args) => {
      const roots = args.roots?.length ? args.roots.map(r => path.resolve(r)) : await defaultPresetRoots();
      const presets = await findPresets(roots, { query: args.query ?? "", max: Math.min(Number(args.max) || 200, 2000) });
      return { content: [{ type: "text", text: jsonText({ roots, count: presets.length, presets }) }] };
    }
  },
  templateTool("ae_apply_preset", "Apply an animation preset (.ffx) to a layer. Find presets with ae_list_presets.", {
    comp: compRefSchema,
    layer: layerRefSchema,
    path: { type: "string", description: "Absolute path to the .ffx file." }
  }, { code: JSX.applyPreset, mutating: true, required: ["layer", "path"] }),

  // ---- markers and audio
  templateTool("ae_add_markers", "Add one or many markers to a layer, or to the composition when layer is omitted.", {
    comp: compRefSchema,
    layer: { ...layerRefSchema, description: "Layer name or index. Omit for composition markers." },
    markers: {
      type: "array",
      items: { type: "object" },
      description: "[{ time, comment?, duration?, label? (0..16), chapter?, url? }]"
    }
  }, { code: JSX.addMarkers, mutating: true, required: ["markers"] }),
  templateTool("ae_get_audio_info", "Audio info of a layer: source file path, audio levels and their keyframes, existing markers.", {
    comp: compRefSchema, layer: layerRefSchema
  }, { code: JSX.audioInfo, required: ["layer"] }),
  templateTool("ae_set_audio_levels", "Set Audio Levels (dB) of a layer: static, at a time, or as a list of keyframes.", {
    comp: compRefSchema,
    layer: layerRefSchema,
    level: { type: "number", description: "dB for both channels." },
    left: { type: "number" },
    right: { type: "number" },
    time: timeSchema,
    keys: { type: "array", items: { type: "object" }, description: "[{ time, level } or { time, left, right }]" }
  }, { code: JSX.setAudioLevels, mutating: true, required: ["layer"] }),
  {
    name: "ae_analyze_audio",
    description: "Analyze a WAV file: peak envelope and transient peaks (beats, hits). Pass path, or comp + layer to use the layer's " +
      "source file (times are then converted to composition time). With addMarkers: true, places a marker at every peak " +
      "(on that layer, or on the composition when only path is given; one undo step). Only uncompressed PCM/float WAV.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to a .wav file." },
        comp: compRefSchema,
        layer: layerRefSchema,
        points: { type: "number", description: "Envelope resolution (default 200, max 5000)." },
        threshold: { type: "number", description: "Peak threshold relative to the loudest point, 0..1 (default 0.6)." },
        minGap: { type: "number", description: "Minimum seconds between peaks (default 0.1)." },
        addMarkers: { type: "boolean" },
        markerComment: { type: "string", description: "Comment for created markers (default 'peak')." },
        envelope: { type: "boolean", description: "Include the envelope in the answer (default true)." }
      }
    },
    run: analyzeAudio
  }
];

// Runs one template and returns its data; for tools that chain several AE calls.
async function callData(bridge, tool, { code, args }) {
  const { entry, envelope } = await bridge.dispatch(tool, { code, args });
  if (!envelope) throw new BridgeError(`${tool} is still running in After Effects (commandId ${entry.commandId}); try again later.`);
  await checkEnvelope(bridge, entry, envelope);
  return envelope.data;
}

async function analyzeAudio(bridge, args) {
  let file = args.path;
  let info = null;
  if (!file) {
    if (args.layer === undefined) throw new BridgeError("Pass path to a WAV file, or comp + layer.");
    info = await callData(bridge, "ae_get_audio_info", { code: withLib(JSX.audioInfo), args: { comp: args.comp, layer: args.layer } });
    file = info.source?.file;
    if (!file) throw new BridgeError(`Layer '${info.layer}' has no source file.`);
  }
  if (!/\.wav$/i.test(file)) throw new BridgeError(`Only WAV files can be analyzed: ${file}. Convert it to WAV first.`);
  let analysis;
  try {
    analysis = analyzeWav(await fs.readFile(file), {
      points: Math.min(Math.max(Number(args.points) || 200, 10), 5000),
      threshold: args.threshold === undefined ? 0.6 : Number(args.threshold),
      minGap: args.minGap === undefined ? 0.1 : Number(args.minGap)
    });
  } catch (error) {
    throw new BridgeError(`Cannot analyze ${file}: ${error.message}`);
  }
  const toComp = info ? t => info.startTime + t * (info.stretch / 100) : t => t;
  const peaks = analysis.peaks
    .map(p => (info ? { ...p, compTime: +toComp(p.time).toFixed(3) } : p))
    .filter(p => !info || (p.compTime >= info.inPoint && p.compTime < info.outPoint));
  const report = { file, ...analysis, peaks };
  if (args.envelope === false) delete report.envelope;
  if (info) report.layer = { comp: info.comp, name: info.layer, startTime: info.startTime, inPoint: info.inPoint, outPoint: info.outPoint };

  const extra = [];
  if (args.addMarkers && peaks.length) {
    const markers = peaks.map(p => ({ time: info ? p.compTime : p.time, comment: args.markerComment ?? "peak" }));
    const result = await runCommand(bridge, "ae_add_markers", {
      code: withLib(JSX.addMarkers), args: { comp: args.comp, layer: info ? args.layer : undefined, markers }, undo: true, mutating: true
    });
    report.markers = JSON.parse(result.content[0].text);
    extra.push(...result.content.slice(1));
  }
  return { content: [{ type: "text", text: jsonText(report) }, ...extra] };
}

async function runCommand(bridge, tool, { code, args = {}, undo = false, mutating = false, timeoutMs, meta = {} }) {
  const notes = [];
  if (mutating) {
    const backup = await bridge.ensureBackup();
    if (backup?.backup) {
      notes.push(`Project backup: ${backup.backup} (the saved .aep as it was before this server session's first change; ` +
        `made once per project per session, last ${bridge.config.backupKeep} kept).`);
    }
    if (backup?.warning) notes.push(backup.warning);
  }
  const { entry, envelope } = await bridge.dispatch(tool, { code, args, undo, timeoutMs, meta: { ...meta, notes } });
  if (!envelope) return stillRunning(entry);
  return finalize(bridge, entry, envelope);
}

function stillRunning(entry) {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        status: "running",
        commandId: entry.commandId,
        tool: entry.tool,
        elapsedMs: Date.now() - entry.createdAt,
        message: "After Effects is still executing this command. It was not cancelled: do NOT send it again. " +
          "Call ae_get_result with this commandId (optionally with waitMs) to collect the result."
      }, null, 2)
    }]
  };
}

// Logs the outcome and throws if the command failed or expired.
async function checkEnvelope(bridge, entry, envelope) {
  bridge.pending.delete(entry.commandId);
  await bridge.log({
    event: "result", commandId: entry.commandId, tool: entry.tool, ok: Boolean(envelope.ok),
    ms: (envelope.finishedAt ?? Date.now()) - (envelope.startedAt ?? entry.createdAt), error: envelope.error
  });
  if (envelope.expired) throw new BridgeError(`Command ${entry.commandId} expired before the panel picked it up; it was not executed.`);
  if (!envelope.ok) {
    const line = envelope.errorLine ? ` (line ${envelope.errorLine})` : "";
    throw new BridgeError(`${entry.tool} failed in After Effects: ${envelope.error}${line}`);
  }
}

async function finalize(bridge, entry, envelope) {
  await checkEnvelope(bridge, entry, envelope);
  const content = [];
  if (entry.post === "frame") {
    let buffer = await waitForCompletePng(envelope.data.path);
    if (!entry.keepFrame) await withRetry(() => fs.rm(envelope.data.path, { force: true })).catch(() => {});
    const info = { ...envelope.data, bytes: buffer.length };
    if (!entry.keepFrame) delete info.path;
    const background = entry.background ?? "comp";
    if (background !== "transparent") {
      try {
        const color = background === "comp" ? parseColor(envelope.data.bgColor ?? [0, 0, 0]) : parseColor(background);
        buffer = flattenPng(buffer, color);
        info.background = "#" + color.map(c => Math.round(c * 255).toString(16).padStart(2, "0")).join("");
      } catch (error) {
        info.backgroundWarning = `Could not fill the background: ${error.message}`;
      }
    }
    content.push({ type: "text", text: jsonText(info) });
    content.push({ type: "image", mimeType: "image/png", data: buffer.toString("base64") });
    if (entry.reference) {
      try {
        const ref = await fs.readFile(entry.reference);
        if (ref.length > 15 * 1024 * 1024) throw new Error("larger than 15 MB");
        content.push({ type: "text", text: `Reference image for comparison: ${entry.reference}` });
        content.push({ type: "image", mimeType: imageMime(entry.reference), data: ref.toString("base64") });
      } catch (error) {
        content.push({ type: "text", text: `Could not read the reference image ${entry.reference}: ${error.message}` });
      }
    }
  } else if (entry.post === "sheet") {
    const { frames, bgColor } = envelope.data;
    const background = entry.background ?? "comp";
    const color = background === "comp" ? parseColor(bgColor ?? [0, 0, 0]) : background === "transparent" ? [0.5, 0.5, 0.5] : parseColor(background);
    const images = [];
    try {
      for (const frame of frames) {
        const png = flattenPng(await waitForCompletePng(frame.path), color);
        images.push({ ...toRgb8(decodePng(png)), label: `${frame.time.toFixed(2)}s f${frame.frame}` });
      }
    } finally {
      for (const frame of frames) await withRetry(() => fs.rm(frame.path, { force: true })).catch(() => {});
    }
    const sheet = contactSheet(images, { columns: entry.columns, maxWidth: entry.maxWidth });
    const info = {
      composition: envelope.data.composition, frameRate: envelope.data.frameRate,
      grid: `${sheet.columns}x${sheet.rows}`, cell: [sheet.cellWidth, sheet.cellHeight],
      frames: frames.map(({ time, frame }) => ({ time, frame })),
      note: "Frames are ordered left to right, top to bottom; each label is time in seconds and frame number."
    };
    content.push({ type: "text", text: jsonText(info) });
    content.push({ type: "image", mimeType: "image/png", data: sheet.png.toString("base64") });
  } else {
    content.push({ type: "text", text: jsonText(envelope.data) });
  }
  for (const note of entry.notes ?? []) content.push({ type: "text", text: note });

  bridge.completed.set(entry.commandId, content.filter(item => item.type === "text"));
  while (bridge.completed.size > 20) bridge.completed.delete(bridge.completed.keys().next().value);
  return { content };
}

async function getResult(bridge, args) {
  const commandId = String(args.commandId ?? "");
  if (!commandId) throw new BridgeError("commandId is required");
  if (bridge.completed.has(commandId)) {
    return { content: [...bridge.completed.get(commandId), { type: "text", text: "(This result was already returned earlier.)" }] };
  }
  const entry = bridge.pending.get(commandId) ??
    { commandId, tool: "unknown", createdAt: Date.now(), pickupDeadline: Infinity, picked: true };
  const waitMs = Math.min(Math.max(Number(args.waitMs) || 0, 0), 600000);
  const envelope = await bridge.waitFor(entry, waitMs);
  if (envelope) return finalize(bridge, entry, envelope);

  const ack = await readJson(bridge.paths.ack);
  if ((ack && ack.commandId === commandId) || bridge.pending.has(commandId)) return stillRunning(entry);
  throw new BridgeError(`Unknown commandId ${commandId}: no result found. It may have been collected already, ` +
    "expired (results are kept for 1 hour), or belong to another server session.");
}

async function health(bridge) {
  const { config } = bridge;
  const server = {
    serverVersion: VERSION,
    bridgeDir: config.bridgeDir,
    cloudSyncWarning: cloudSyncWarning(config.bridgeDir),
    runJsxEnabled: config.runJsxEnabled,
    backup: config.backupEnabled ? { enabled: true, keep: config.backupKeep, dir: config.backupDir } : { enabled: false },
    log: config.logEnabled ? bridge.paths.logs : false,
    timeoutMs: config.timeoutMs,
    node: process.version,
    platform: process.platform
  };
  const panelStatus = await bridge.readPanelStatus();
  const panel = panelStatus && {
    running: panelStatus.running,
    panelVersion: panelStatus.panelVersion,
    lastHeartbeatSecondsAgo: Math.round((Date.now() - panelStatus.heartbeat) / 1000)
  };
  const report = { connected: false, server, panel };

  const busy = await bridge.busyState();
  if (busy) {
    report.busy = { tool: busy.tool, commandId: busy.commandId, seconds: Math.round((Date.now() - busy.startedAt) / 1000) };
    report.message = "After Effects is executing another command.";
    return { content: [{ type: "text", text: jsonText(report) }] };
  }
  try {
    const { entry, envelope } = await bridge.dispatch("ae_health", { code: JSX.health, timeoutMs: 10000 });
    if (!envelope) {
      report.message = "Panel picked up the health check but did not answer within 10 s (AE busy?).";
      report.commandId = entry.commandId;
    } else {
      bridge.pending.delete(entry.commandId);
      if (!envelope.ok) throw new BridgeError(envelope.error);
      report.connected = true;
      report.ae = envelope.data;
      if (envelope.data.panelVersion !== VERSION) {
        report.warning = `Version mismatch: server ${VERSION}, panel ${envelope.data.panelVersion}. Reinstall the panel.`;
      }
    }
  } catch (error) {
    report.error = error.message;
  }
  return { content: [{ type: "text", text: jsonText(report) }], ...(report.connected ? {} : { isError: true }) };
}

// ---- MCP stdio server (JSON-RPC 2.0, newline-delimited) ----------------------

const RUN_CODE_TOOLS = ["ae_run_jsx", "ae_run_jsx_file"];

// Motion-design defaults distilled from real sessions: models tend to animate only opacity/position,
// forget motion blur and track mattes, and cannot see motion in a single frame.
export const MOTION_GUIDELINES = `After Effects motion-design guidelines for this bridge

Working loop
- Start with ae_health and ae_list_project. If the user refers to "this" or "the selected", call ae_get_selection.
- Build the static design first, check it with ae_capture_frame, and agree on it before animating.
- After animating, ALWAYS check motion with ae_capture_frames (6-12 frames over the animated range), not with one frame.
  Look for: elements visible before their container opens, overlaps, things leaving the frame, uneven timing, dead pauses.
- Prefer native tools (ae_set_keyframes, ae_add_text_animator, ae_copy_animation, ae_set_layer) over ae_run_jsx;
  use ae_run_jsx for anything they do not cover. Keep layer names meaningful.

Animation quality (avoid "opacity-only" animation)
- Never rely on opacity fades alone. Combine position/scale with opacity, add blur for softness.
- Ease every key, but asymmetrically. Entrances start fast and land softly: first key ease 'easyOut' with influence
  15-30 (or linear), last key ease 'easyIn' with influence 75-90. Exits mirror it (slow start, fast finish).
  Symmetric 'easy' 85/85 on both keys starts from zero speed and looks sluggish. Linear only for mechanical motion.
- Overshoot/bounce for UI cards: prefer the inertial-bounce expression below on a simple 2-key animation: it keeps
  momentum through the overshoot. If you use an explicit overshoot key (~105-110 % then 100 % over 4-8 frames), do not
  let speed drop to zero on it (no Easy Ease on the overshoot key), or the motion "stops and comes back" mechanically.
  Inertial bounce (apply with ae_set_expression to the keyed property; the last key must arrive with speed,
  i.e. linear or easyOut-only, because the overshoot is computed from the velocity just before it):
    amp = .06; freq = 2.5; decay = 6; n = 0;
    if (numKeys > 0) { n = nearestKey(time).index; if (key(n).time > time) n--; }
    t = (n == 0) ? 0 : time - key(n).time;
    if (n > 0 && t < 1) { v = velocityAtTime(key(n).time - thisComp.frameDuration / 10);
      value + v * amp * Math.sin(freq * t * 2 * Math.PI) / Math.exp(decay * t); } else { value; }
- Properties that move together must finish together (e.g. size and position of the same card).
- Overshoot should read as elasticity of the whole object: if only the height overshoots, add a slight overshoot in
  width or a 100 -> 102 -> 100 % Scale on top, otherwise the card looks stretched.
- Rounded rectangles (shape layers): reveal by animating the Rectangle Path SIZE (e.g. height 0 -> full), not layer Scale,
  so corner radii do not distort. Anchor the growth direction deliberately (from center, or from the bottom up).
- Text: animate with text animators (ae_add_text_animator) rather than Transform. Defaults: offsets position [0, 40],
  opacity 0, blur 16, ~1 s. Characters/words use a soft wave (shape rampUp: overlapping letters); a hard Square selector
  on characters looks like a typewriter. Lines use square with strong ease (influence ~85). Scale offsets/blur with the
  font size: smaller text needs smaller offsets.
- Stagger related elements by 2-6 frames (ae_copy_animation stagger / ae_add_text_animator stagger) instead of
  animating everything at once. Respect hierarchy: container first, then its content.
- Numbers: animate counters (Source Text expression from 0 to the value with ease) when showing statistics.
- Content that appears inside a card should be clipped by it: set a track matte to the card (ae_set_layer trackMatte,
  matteVisible true when the card itself must stay visible).
- Turn on motion blur for moving layers (ae_set_layer motionBlur: true also enables the comp switch).
- Keep entrances short (0.4-1.2 s per element), whole intros 1.5-3 s; hold the final state long enough to read.

Design checks
- Consistent type scale and case for secondary labels; enough padding inside cards; one clear focal element.
- Soft shadows (low opacity, larger softness) rather than heavy black ones.
- When recreating a reference image, use ae_capture_frame with compareWith to compare side by side.

Technical notes
- ExtendScript is ES3 (var, no arrow functions, no let/const, no Array.forEach/map/indexOf). Collections are 1-based.
- Never open, close or create projects inside ae_run_jsx: it runs in an undo group and AE then shows a blocking
  "Undo group mismatch" dialog. Use ae_open_project / ae_save_project. Avoid alert()/confirm() and other modal UI too.
- Pass user data through args; every tool call is one undo step; if a call returns status "running", use ae_get_result.
- Show results to the user with ae_render_preview (MP4) when they want to watch the motion.`;

const INSTRUCTIONS = "Controls Adobe After Effects through a panel running inside AE. Loop: ae_health -> ae_list_project " +
  "(or ae_get_selection when the user points at something) -> build with the ae_* tools or ae_run_jsx (ExtendScript ES3) -> " +
  "check a still with ae_capture_frame and MOTION with ae_capture_frames -> fix. Each tool call is one undo step. Pass user " +
  "data via `args`, never by splicing it into code. If a call returns status 'running' with a commandId, use ae_get_result " +
  "instead of repeating it. Motion quality: asymmetric ease (entrances: fast start, soft landing ~85), avoid opacity-only animation, use " +
  "text animators for text, stagger elements by a few frames, reveal rounded cards through Rectangle Size not Scale, clip " +
  "content with track mattes, enable motion blur on moving layers. Read the full guide with ae_guidelines before designing.";

const PROMPTS = [
  {
    name: "motion-design-guidelines",
    title: "After Effects: motion design guidelines",
    description: "Working loop and motion-design rules for creating and animating in After Effects through this bridge.",
    arguments: [],
    text: () => MOTION_GUIDELINES
  },
  {
    name: "review-animation",
    title: "After Effects: review the animation",
    description: "Capture a contact sheet of the animation and critique timing, easing, hierarchy and clipping before changing anything.",
    arguments: [{ name: "comp", description: "Composition name (default: active)", required: false }],
    text: args => `${MOTION_GUIDELINES}\n\nTask: review the animation of ${args.comp ? `composition "${args.comp}"` : "the active composition"}. ` +
      "Call ae_capture_frames over its animated range (and ae_inspect on key layers if needed). Do not change anything yet: " +
      "list concrete problems (timing, easing, overlaps, clipping, hierarchy, motion blur, typography) with suggested fixes, " +
      "ordered by impact, and ask which to apply."
  }
];

export class McpServer {
  constructor(bridge, output = process.stdout) {
    this.bridge = bridge;
    this.output = output;
    this.queue = Promise.resolve();
    this.buffer = Buffer.alloc(0);
    this.tools = TOOLS.filter(tool => bridge.config.runJsxEnabled || !RUN_CODE_TOOLS.includes(tool.name));
  }

  send(message) {
    this.output.write(JSON.stringify(message) + "\n");
  }

  reply(id, result) { this.send({ jsonrpc: "2.0", id, result }); }
  fail(id, code, message) { this.send({ jsonrpc: "2.0", id, error: { code, message } }); }

  feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const split = this.buffer.indexOf(0x0a);
      if (split < 0) return;
      const body = this.buffer.subarray(0, split).toString("utf8").trim();
      this.buffer = this.buffer.subarray(split + 1);
      if (!body) continue;
      let message;
      try { message = JSON.parse(body); }
      catch { this.fail(null, -32700, "Parse error"); continue; }
      this.dispatch(message);
    }
  }

  dispatch(message) {
    const { id, method, params } = message ?? {};
    const isRequest = id !== undefined && id !== null;
    if (method === "tools/call") {
      // One After Effects command at a time.
      this.queue = this.queue.then(() => this.callTool(id, params)).catch(error => process.stderr.write(`${error.stack}\n`));
      return;
    }
    if (method === "initialize") {
      return this.reply(id, {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: "ae-mcp-bridge", version: VERSION },
        instructions: INSTRUCTIONS
      });
    }
    if (method === "tools/list") {
      return this.reply(id, { tools: this.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    }
    if (method === "prompts/list") {
      return this.reply(id, { prompts: PROMPTS.map(({ name, title, description, arguments: args }) => ({ name, title, description, arguments: args })) });
    }
    if (method === "prompts/get") {
      const prompt = PROMPTS.find(p => p.name === params?.name);
      if (!prompt) return this.fail(id, -32602, `Unknown prompt: ${params?.name}`);
      return this.reply(id, { description: prompt.description, messages: [{ role: "user", content: { type: "text", text: prompt.text(params?.arguments ?? {}) } }] });
    }
    if (method === "ping") return this.reply(id, {});
    if (isRequest && method) return this.fail(id, -32601, `Method not found: ${method}`);
    // Notifications (notifications/initialized, cancelled, ...) need no answer.
  }

  async callTool(id, params) {
    const name = params?.name;
    const tool = this.tools.find(t => t.name === name);
    try {
      if (!tool) {
        const disabled = RUN_CODE_TOOLS.includes(name) && !this.bridge.config.runJsxEnabled;
        throw new BridgeError(disabled ? `${name} is disabled on this server (AE_MCP_DISABLE_RUN_JSX).` : `Unknown tool: ${name}`);
      }
      this.reply(id, await tool.run(this.bridge, params?.arguments ?? {}));
    } catch (error) {
      if (!(error instanceof BridgeError)) process.stderr.write(`ae-mcp: ${name}: ${error.stack}\n`);
      this.reply(id, { isError: true, content: [{ type: "text", text: error.message }] });
    }
  }

  listen(input = process.stdin) {
    input.on("data", chunk => this.feed(chunk));
    input.resume();
  }
}

export async function main(env = process.env) {
  const config = loadConfig(env);
  const bridge = new Bridge(config);
  await bridge.init();
  const warning = cloudSyncWarning(config.bridgeDir, env);
  if (warning) process.stderr.write(`ae-mcp: WARNING: ${warning}\n`);
  process.stderr.write(`ae-mcp-bridge ${VERSION}: bridge folder ${config.bridgeDir}\n`);
  new McpServer(bridge).listen();
}

const entryFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entryFile && entryFile.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main().catch(error => {
    process.stderr.write(`ae-mcp: fatal: ${error.stack}\n`);
    process.exit(1);
  });
}
