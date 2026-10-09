// AE MCP Bridge — starting the runner inside the running After Effects (no panel, no polling).
//
// Windows: `AfterFX.exe -s "<code>"` hands a script to the running AE in about a second and exits
// (only -r shows the "Warn User When Executing Files" dialog). While a modal dialog is open AE rejects
// the script with an error dialog, so before every trigger we check whether AE's main window is
// disabled (src/win-probe.ps1, one PowerShell process kept for the session).
// macOS (untested): osascript `tell application "<AE app>" to DoScriptFile "<runner>"`; no modal check.
import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// ExtendScript string literal for a path: forward slashes, single quotes, non-ASCII as \uXXXX.
export function jsxPathLiteral(file) {
  const text = file.replace(/\\/g, "/").replace(/[\\']/g, ch => "\\" + ch)
    .replace(/[^\x20-\x7e]/g, ch => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
  return `'${text}'`;
}

export function runnerCode(runnerPath) {
  return `$.evalFile(${jsxPathLiteral(runnerPath)})`;
}

const appleQuote = text => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// One long-lived PowerShell answering "probe" lines (Add-Type compiles once, then ~10 ms per probe).
class WinProbe {
  constructor() { this.child = null; this.queue = []; this.buffer = ""; }

  start() {
    if (this.child) return this.ready;
    const script = path.join(here, "win-probe.ps1");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
      { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (!line) continue;
        const waiter = this.queue.shift();
        if (waiter) waiter.resolve(line);
      }
    });
    const fail = error => {
      this.child = null;
      for (const waiter of this.queue.splice(0)) waiter.reject(error);
    };
    child.on("error", fail);
    child.on("exit", () => fail(new Error("AE probe process exited")));
    child.unref();
    child.stdout.unref?.();
    child.stdin.unref?.();
    this.ready = this.read(20000);
    return this.ready;
  }

  read(timeoutMs) {
    return new Promise((resolve, reject) => {
      const waiter = { resolve: line => { clearTimeout(timer); resolve(line); }, reject: error => { clearTimeout(timer); reject(error); } };
      const timer = setTimeout(() => {
        const i = this.queue.indexOf(waiter);
        if (i >= 0) this.queue.splice(i, 1);
        reject(new Error("AE probe did not answer"));
      }, timeoutMs);
      this.queue.push(waiter);
    });
  }

  async probe() {
    await this.start();
    const answer = this.read(5000);
    this.child.stdin.write("probe\n");
    const state = JSON.parse(await answer);
    if (state.error) throw new Error(state.error);
    return state;
  }

  stop() { try { this.child?.kill(); } catch { /* ignore */ } this.child = null; }
}

function run(file, args, timeoutMs = 5000) {
  return new Promise(resolve => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => resolve(error ? null : String(stdout).trim()));
  });
}

// Finds and triggers After Effects. `afterFx` (AE_MCP_AFTERFX) overrides the executable / app path.
export class Launcher {
  constructor({ afterFx = "", platform = process.platform } = {}) {
    this.afterFx = afterFx;
    this.platform = platform;
    this.winProbe = platform === "win32" ? new WinProbe() : null;
  }

  // { running, modal, dialogs, exe, pid, startTime }. `modal` is null when it cannot be detected.
  async probe() {
    if (this.winProbe) return this.winProbe.probe();
    if (this.platform === "darwin") {
      const out = await run("/bin/ps", ["-axo", "pid=,lstart=,comm="]);
      const line = (out || "").split("\n").find(l => /After Effects\.app\/Contents\/MacOS\//.test(l));
      if (!line) return { running: false };
      const app = line.slice(line.indexOf("/"), line.indexOf(".app/") + 4);
      return { running: true, exe: app, modal: null, dialogs: [] };
    }
    return { running: false, unsupported: true };
  }

  // Starts the runner once. Resolves when the trigger was handed over, not when the command ran.
  async trigger(runnerPath, state) {
    if (this.platform === "win32") {
      const exe = this.afterFx || state?.exe;
      if (!exe) throw new Error("AfterFX.exe not found; set AE_MCP_AFTERFX to its full path");
      const child = spawn(exe, ["-s", runnerCode(runnerPath)], { detached: true, stdio: "ignore", windowsHide: true });
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
      return;
    }
    if (this.platform === "darwin") {
      const app = this.afterFx || state?.exe;
      if (!app) throw new Error("After Effects app not found; set AE_MCP_AFTERFX to its .app path");
      const script = `tell application ${appleQuote(app)} to DoScriptFile ${appleQuote(runnerPath)}`;
      const child = spawn("/usr/bin/osascript", ["-e", script], { detached: true, stdio: "ignore" });
      child.unref();
      return;
    }
    throw new Error(`Starting After Effects scripts is not supported on ${this.platform}`);
  }

  stop() { this.winProbe?.stop(); }
}

export const RUNNER_SOURCE = path.join(here, "ae-mcp-runner.jsx");

export function readRunnerSource() {
  return fs.readFileSync(RUNNER_SOURCE);
}
