# Installing AE MCP Bridge: instructions for an AI agent

You are installing AE MCP Bridge for the user: an MCP server (Node.js, no dependencies) that runs
scripts in the open Adobe After Effects; nothing has to be installed or started inside After Effects. Work through the steps in order. Every step ends with a **Done when** check: run it and reach
it before moving on. Steps marked **HUMAN** are actions only the user can perform; ask for them in plain words,
wait for the user's confirmation, then run the check yourself. Talk to the user in their language.

The human manual with background and troubleshooting: [MANUAL.md](MANUAL.md).

`<bridge>` below means the installation folder, `<node>` the full path printed by step 2.

## 1. Agree on the plan

Ask the user, in one message:

- Installation folder. Default: `C:\MCP\ae-mcp` on Windows, `~/MCP/ae-mcp` on macOS. It must be local, outside
  OneDrive / Google Drive / Dropbox / iCloud.
- Which clients to connect: Claude Code (for one project folder, or for all sessions), Claude Desktop with Cowork,
  Codex.
- Whether to install the optional Claude skill `after-effects-motion`.

**Done when** you have the folder and the list of clients.

## 2. Node.js

Run `node --version` (and `where node` on Windows or `which node` on macOS to get `<node>`).

- Version 18.17 or newer: continue.
- Missing or older: **HUMAN** installs the LTS version from https://nodejs.org, then reopens the terminal.

**Done when** `node --version` prints v18.17 or newer.

## 3. Get the files

If `<bridge>/src/mcp-server.mjs` already exists, use that folder. Otherwise clone the repository into `<bridge>`
(`git clone https://github.com/justajazz/ae-mcp-bridge.git <bridge>`) or unpack the ZIP the user gives you.

Then run the offline self-test inside `<bridge>`:

```bash
npm test
```

**Done when** it ends with `fail 0`. No `npm install` is needed: the bridge has no dependencies.

## 4. After Effects preference

**HUMAN**: in After Effects open **Edit > Preferences > Scripting & Expressions** (macOS: *After Effects > Settings >
Scripting & Expressions*), enable **Allow Scripts to Write Files and Access Network**, click OK.

**Done when** the user confirms.

## 5. Optional: the status panel

Skip this step unless the user wants to see a log of commands inside After Effects; the bridge works without it.

```bash
node <bridge>/src/install-panel.mjs --link
```

It finds every installed After Effects and writes a small loader into its `ScriptUI Panels` folder. Writing into
Program Files triggers a Windows UAC prompt: tell the user beforehand that it will appear and that they should
confirm it (**HUMAN**). On macOS run it as `sudo "$(which node)" <bridge>/src/install-panel.mjs --link` (the full Node path keeps it
working when Node comes from nvm or Homebrew; the user types the password, **HUMAN**).

**Done when** the output ends with `done` for each After Effects version (or the step was skipped). If After
Effects is not found, ask the user for its folder and pass `--ae "<folder>"`.

## 6. Check the bridge

**HUMAN**: start After Effects (restart it if the panel was installed) and open a project. If an old 0.2 AE MCP panel
is open, close it: it polls the bridge folder and can break scripting in After Effects when a dialog opens.

Then verify the whole chain yourself:

```bash
node <bridge>/scripts/check-install.mjs
```

**Done when** it prints `RESULT: connected`. If it says After Effects is not running, ask the user to start it; if a
dialog is open, ask them to close it; if the command was not started, ask them to check **Allow Scripts to Write
Files and Access Network** (step 4).

## 7. Connect the clients

Do only the clients chosen in step 1.

- **Claude Code, one project folder** (recommended to start): in that folder run
  `claude mcp add --scope project after-effects -- node "<bridge>/src/mcp-server.mjs"`.
  **HUMAN**: the next time `claude` starts in that folder, choose **Use this MCP server**.
- **Claude Code, all sessions**: `claude mcp add --scope user after-effects -- node "<bridge>/src/mcp-server.mjs"`.
  Tell the user the trade-off: the tool descriptions load into every session and After Effects is reachable from
  any project (every call still asks permission unless allowed).
- **Claude Desktop and Cowork**: `node <bridge>/scripts/configure-client.mjs claude-desktop`.
  **HUMAN**: quit Claude Desktop completely (tray / menu bar icon > Quit) and start it again. Cowork uses the same
  connectors.
- **Codex**: `node <bridge>/scripts/configure-client.mjs codex` (registers the server as `ae_mcp_bridge`).
  If the script reports another `after_effects` server (the original "After Effects MCP by Ruslan Tsapenko"),
  **HUMAN** turns it off in Codex Settings > MCP and stops its panel: both offer tools with the same names.
  **HUMAN**: restart Codex completely.

The script backs the config file up, adds only the `after-effects` entry and leaves an existing entry untouched.

**Done when** each chosen client is configured: `claude mcp get after-effects` lists the server for Claude Code;
the script printed `added` or `already configured` for Claude Desktop and Codex.

## 8. Optional: the Claude skill

If the user wants it, copy `<bridge>/skills/after-effects-motion` to `~/.claude/skills/after-effects-motion`
(Windows: `%USERPROFILE%\.claude\skills\after-effects-motion`). For Claude Desktop / Cowork the user uploads the
zipped folder in **Settings > Capabilities > Skills** (**HUMAN**).

**Done when** the folder is in place, or the user declined.

## 9. Hand over

Tell the user:

- what was installed and where (`<bridge>`, the bridge folder `C:\MCP\ae-bridge`, the panel if installed);
- which clients are configured and which restarts or approvals are still theirs;
- the first request to try after restarting the client: *"Check the connection to After Effects. Don't change anything."*;
- that every tool call is one Ctrl+Z, and the project is backed up to `C:\MCP\ae-bridge\backups` before the first change.

**Done when** the user has this summary. Keep their After Effects projects untouched throughout: the installation
never opens, saves or edits a project.
