// Node imitation of ae-mcp-panel.jsx: same file protocol, scripted responses.
// Lets the protocol be tested without After Effects.
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

export class MockPanel {
  // handler(command) -> { data } | { error } , may be async; `delayMs` simulates a long command.
  constructor(bridgeDir, { handler, pollMs = 20, projectPath = null, panelVersion = "0.2.0" } = {}) {
    this.dir = bridgeDir;
    this.handler = handler ?? (() => ({ data: null }));
    this.pollMs = pollMs;
    this.projectPath = projectPath;
    this.panelVersion = panelVersion;
    this.executed = [];
    this.expired = [];
    this.seenCommands = [];
    this.lastCommandId = "";
    this.busy = false;
    this.timer = null;
  }

  async start() {
    await fs.mkdir(path.join(this.dir, "results"), { recursive: true });
    await fs.rm(path.join(this.dir, "ack.json"), { force: true });
    this.running = true;
    await this.writeStatus();
    this.timer = setInterval(() => this.tick().catch(error => { this.error = error; }), this.pollMs);
  }

  async stop() {
    this.running = false;
    clearInterval(this.timer);
    while (this.busy) await sleep(10);
    await this.writeStatus();
  }

  async writeAtomic(file, value) {
    const tmp = file + ".mock.tmp";
    await fs.writeFile(tmp, JSON.stringify(value), "utf8");
    await fs.rename(tmp, file);
  }

  writeStatus() {
    return this.writeAtomic(path.join(this.dir, "panel-status.json"), {
      running: this.running, busy: this.busy, panelVersion: this.panelVersion,
      heartbeat: Date.now(), projectPath: this.projectPath, lastCommandId: this.lastCommandId
    });
  }

  async tick() {
    if (this.busy || !this.running) return;
    this.busy = true;
    try {
      await this.writeStatus();
      let raw;
      try { raw = await fs.readFile(path.join(this.dir, "command.json"), "utf8"); } catch { return; }
      const command = JSON.parse(raw);
      if (!command.commandId || command.commandId === this.lastCommandId) return;
      this.lastCommandId = command.commandId;
      this.seenCommands.push({ raw, command });
      const resultFile = path.join(this.dir, "results", `${command.commandId}.json`);
      if (fsSync.existsSync(resultFile)) return;
      const startedAt = Date.now();
      if (!command.pickupDeadline || startedAt > command.pickupDeadline) {
        this.expired.push(command);
        await this.writeAtomic(resultFile, { commandId: command.commandId, ok: false, expired: true, error: "expired" });
        return;
      }
      await this.writeAtomic(path.join(this.dir, "ack.json"), { commandId: command.commandId, tool: command.tool, startedAt });
      this.executed.push(command);
      const envelope = { commandId: command.commandId, tool: command.tool, startedAt, panelVersion: this.panelVersion };
      try {
        const outcome = (await this.handler(command, this)) ?? {};
        if (outcome.delayMs) await sleep(outcome.delayMs);
        if (outcome.error) { envelope.ok = false; envelope.error = outcome.error; }
        else { envelope.ok = true; envelope.data = outcome.data ?? null; }
      } catch (error) {
        envelope.ok = false;
        envelope.error = String(error);
      }
      envelope.finishedAt = Date.now();
      envelope.project = this.projectPath;
      await fs.rm(path.join(this.dir, "ack.json"), { force: true });
      await this.writeAtomic(resultFile, envelope);
    } finally {
      this.busy = false;
    }
  }
}

// Writes the PNG in two chunks with a pause, like an asynchronous saveFrameToPng.
export async function writePngSlowly(file, delayMs = 150) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const half = Math.floor(TINY_PNG.length / 2);
  await fs.writeFile(file, TINY_PNG.subarray(0, half));
  setTimeout(() => fs.appendFile(file, TINY_PNG.subarray(half)).catch(() => {}), delayMs);
}
