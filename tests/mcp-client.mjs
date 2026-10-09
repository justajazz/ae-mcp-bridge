// Minimal MCP client: spawns the server over stdio and exchanges JSON-RPC lines.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "mcp-server.mjs");

export class McpClient {
  constructor(env = {}) {
    this.child = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    this.nextId = 1;
    this.waiters = new Map();
    this.messages = [];
    this.stderr = "";
    let buffer = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", chunk => {
      buffer += chunk;
      let split;
      while ((split = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, split);
        buffer = buffer.slice(split + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        this.messages.push(message);
        const waiter = this.waiters.get(message.id);
        if (waiter) { this.waiters.delete(message.id); waiter(message); }
      }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", chunk => { this.stderr += chunk; });
  }

  request(method, params, timeoutMs = 90000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No reply to ${method} in ${timeoutMs} ms. stderr: ${this.stderr}`)), timeoutMs);
      this.waiters.set(id, message => { clearTimeout(timer); resolve(message); });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  writeRaw(text) {
    this.child.stdin.write(text);
  }

  async initialize() {
    const reply = await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return reply;
  }

  async call(name, args = {}) {
    const reply = await this.request("tools/call", { name, arguments: args });
    if (reply.error) throw new Error(reply.error.message);
    return reply.result;
  }

  close() {
    this.child.stdin.end();
    this.child.kill();
  }
}

export const textOf = result => result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
