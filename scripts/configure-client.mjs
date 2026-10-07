#!/usr/bin/env node
// Registers the bridge in an MCP client config. Backs the file up first, adds only the bridge entry,
// keeps everything else, and does nothing if the entry is already there.
//
//   node scripts/configure-client.mjs claude-desktop     %APPDATA%\Claude\claude_desktop_config.json (macOS: ~/Library/...)
//   node scripts/configure-client.mjs codex              ~/.codex/config.toml
//   node scripts/configure-client.mjs mcp-json <folder>  <folder>/.mcp.json (Claude Code project scope, without the claude CLI)
//   add --dry-run to print the change without writing
//
// For Claude Code prefer: claude mcp add --scope project|user after-effects -- node "<bridge>\src\mcp-server.mjs"
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "mcp-server.mjs");
const node = process.execPath;
const [target, folder] = process.argv.slice(2).filter(a => !a.startsWith("--"));
const dryRun = process.argv.includes("--dry-run");

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const copy = `${file}.backup-${stamp()}`;
  if (!dryRun) fs.copyFileSync(file, copy);
  return copy;
}

function writeAtomic(file, text) {
  if (dryRun) { console.log(`--- would write ${file} ---\n${text}`); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
}

function addJsonEntry(file, entry) {
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "") || "{}") : {};
  config.mcpServers ??= {};
  const existing = config.mcpServers["after-effects"];
  if (existing) {
    const ours = (existing.args ?? []).some(a => path.resolve(String(a)).toLowerCase() === serverFile.toLowerCase());
    console.log(`${ours ? "already configured" : "WARNING: a different server is registered as \"after-effects\""} in ${file}:\n` +
      JSON.stringify(existing, null, 2) + (ours ? "" : "\nNothing was changed. Remove or rename that entry, then run this again."));
    return;
  }
  const copy = backup(file);
  config.mcpServers["after-effects"] = entry;
  writeAtomic(file, JSON.stringify(config, null, 2) + "\n");
  console.log(`added "after-effects" to ${file}${copy ? ` (backup: ${copy})` : ""}`);
}

if (target === "claude-desktop") {
  const file = process.platform === "win32"
    ? path.join(process.env.APPDATA, "Claude", "claude_desktop_config.json")
    : path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  addJsonEntry(file, { command: node, args: [serverFile] });
  console.log("next: quit Claude Desktop completely (tray / menu bar icon > Quit) and start it again");
} else if (target === "mcp-json") {
  if (!folder) { console.error("usage: configure-client.mjs mcp-json <project folder>"); process.exit(1); }
  addJsonEntry(path.join(path.resolve(folder), ".mcp.json"), { type: "stdio", command: node, args: [serverFile], env: {} });
  console.log("next: start `claude` in that folder and choose 'Use this MCP server'");
} else if (target === "codex") {
  // Named ae_mcp_bridge: "after_effects" is the name the original "After Effects MCP by Ruslan Tsapenko" uses in Codex.
  const file = path.join(os.homedir(), ".codex", "config.toml");
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (/^\[mcp_servers\.ae_mcp_bridge\]/m.test(current)) {
    console.log(`already configured in ${file}`);
  } else {
    const copy = backup(file);
    // TOML literal strings (single quotes) keep Windows backslashes as they are.
    const block = `\n[mcp_servers.ae_mcp_bridge]\ncommand = '${node}'\nargs = ['${serverFile}']\n`;
    writeAtomic(file, current.replace(/\s*$/, "\n") + block);
    console.log(`added [mcp_servers.ae_mcp_bridge] to ${file}${copy ? ` (backup: ${copy})` : ""}`);
  }
  if (/^\[mcp_servers\.after_effects\]/m.test(current)) {
    console.log("NOTE: another After Effects MCP server ('after_effects', e.g. the original by Ruslan Tsapenko) is configured.\n" +
      "      Both offer tools with the same names (ae_health, ae_run_jsx, ...). Turn it off while using this bridge:\n" +
      "      Codex Settings > MCP > after_effects off (it stays configured and can be turned on again).");
  }
  console.log("next: restart Codex completely");
} else {
  console.error("usage: node scripts/configure-client.mjs claude-desktop | codex | mcp-json <folder> [--dry-run]");
  process.exit(1);
}
