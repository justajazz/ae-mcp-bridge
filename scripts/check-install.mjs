#!/usr/bin/env node
// Checks an installation end to end, the way an MCP client would use it: starts the server over stdio,
// initializes, lists tools and calls ae_health. Changes nothing in After Effects.
//   node scripts/check-install.mjs
// Exit code 0 when After Effects answered, 1 otherwise. Environment variables (AE_MCP_*) are passed through.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const server = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "mcp-server.mjs");
const child = spawn(process.execPath, [server], { stdio: ["pipe", "pipe", "pipe"] });
const waiters = new Map();
let buffer = "", nextId = 1, stderr = "";

child.stderr.on("data", chunk => { stderr += chunk; });
child.stdout.setEncoding("utf8");
child.stdout.on("data", chunk => {
  buffer += chunk;
  let split;
  while ((split = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, split);
    buffer = buffer.slice(split + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    waiters.get(message.id)?.(message);
  }
});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer to ${method}; server output: ${stderr}`)), 30000);
    waiters.set(id, message => { clearTimeout(timer); resolve(message); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

let ok = false;
try {
  const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "check-install", version: "1" } });
  console.log(`server:      ${init.result.serverInfo.name} ${init.result.serverInfo.version} (node ${process.version})`);
  const tools = await request("tools/list", {});
  console.log(`tools:       ${tools.result.tools.length}`);
  const health = await request("tools/call", { name: "ae_health", arguments: {} });
  const report = JSON.parse(health.result.content[0].text);
  console.log(`bridge dir:  ${report.server.bridgeDir}`);
  if (report.server.cloudSyncWarning) console.log(`WARNING:     ${report.server.cloudSyncWarning}`);
  if (report.connected) {
    const project = report.ae.project?.path ?? "(unsaved or no project)";
    console.log(`after effects: ${report.ae.version}, panel ${report.ae.panelVersion}, project ${project}`);
    if (report.warning) console.log(`WARNING:     ${report.warning}`);
    console.log("RESULT:      connected");
    ok = true;
  } else {
    console.log(`panel:       ${report.panel ? JSON.stringify(report.panel) : "never started in this bridge folder"}`);
    console.log(`RESULT:      not connected: ${report.error ?? report.message}`);
  }
} catch (error) {
  console.log(`RESULT:      server failed: ${error.message}`);
} finally {
  child.kill();
  process.exit(ok ? 0 : 1);
}
