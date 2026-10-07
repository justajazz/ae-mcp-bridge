# AE MCP Bridge

**Let Claude (or Codex) work inside Adobe After Effects:** build compositions, shapes, text, effects and animation,
look at the result as frames or a storyboard, and fix it, while you keep a normal, fully editable AE project.

Version 0.2.0 · zero dependencies · Windows and macOS · Claude Code, Claude Desktop, Cowork, Codex

Inspired by **"After Effects MCP by Ruslan Tsapenko"** (v0.1.0) from
[Ruslan Tsapenko](https://www.youtube.com/@RuslanTsapenko) ([tsapenko.com](https://tsapenko.com/)), with tools and
ideas ported from [TheLlamainator/after-effects-mcp](https://github.com/TheLlamainator/after-effects-mcp) (MIT).

[Manual](docs/MANUAL.md) · [Tool reference](docs/TOOLS.md) · [Changelog](CHANGELOG.md)

## What it can do

- **Build:** compositions, text / shape / solid / adjustment / null layers, transforms, parenting, track mattes,
  motion blur, effects with settings, `.ffx` presets, markers, audio levels.
- **Animate:** keyframes with real easing (Easy Ease, ease in/out, custom influence, hold), expressions, text
  animators with a soft per-letter wave, copying animators and effects between layers with a stagger.
- **See:** a frame as an image, a **storyboard** of the animation in one image, side-by-side comparison with a
  reference, MP4 previews, what you selected in AE, the full property tree with keyframes.
- **Script:** run any ExtendScript (`ae_run_jsx`) or your own `.jsx` files; the specialized tools are conveniences
  on top, not a replacement.
- **Stay safe:** every call is one Ctrl+Z, the project is backed up before the first change, scripts are logged,
  arbitrary code can be switched off.
- **Teach good motion:** built-in motion-design guidelines (asymmetric easing, bounce, text animators, stagger,
  track mattes, motion blur, review loop) available as a tool and as MCP prompts, plus an optional Claude skill
  ([`skills/after-effects-motion`](skills/after-effects-motion/SKILL.md)) with the working loop and recipes.

34 tools in total, see the [reference](docs/TOOLS.md).

## Quick start

**With an AI agent:** in Claude Code (or Codex) say *"Install AE MCP Bridge from https://github.com/justajazz/ae-mcp-bridge
into C:\MCP\ae-mcp, following docs/INSTALL-AGENT.md"*. It runs and checks everything and asks you only for the UAC
prompt, one AE preference, starting the panel and restarting apps. See [INSTALL-AGENT.md](docs/INSTALL-AGENT.md).

**By hand (Windows):**

1. Install [Node.js](https://nodejs.org) LTS and put this repository in a local folder, e.g. `C:\MCP\ae-mcp`.
2. In After Effects enable **Preferences > Scripting & Expressions > Allow Scripts to Write Files and Access Network**.
3. Install the panel and restart After Effects:
   ```bash
   node C:\MCP\ae-mcp\src\install-panel.mjs --link
   ```
4. Open **Window > ae-mcp-panel.jsx**, click **Start bridge**, tick *Start automatically*.
5. Connect your client, e.g. Claude Code:
   ```bash
   claude mcp add --scope project after-effects -- node "C:\MCP\ae-mcp\src\mcp-server.mjs"
   ```
   Claude Desktop / Cowork and Codex: see the [manual](docs/MANUAL.md#4-connecting-an-ai-client).
6. Check without any client: `node C:\MCP\ae-mcp\scripts\check-install.mjs` ends with `RESULT: connected`.
7. Ask your assistant: *"Check the connection to After Effects. Don't change anything."*

## How it works

```
AI client --MCP stdio--> src/mcp-server.mjs --files--> bridge folder <--polls-- src/ae-mcp-panel.jsx (in AE)
```

The server is plain Node.js with no packages. The panel inside After Effects executes ExtendScript templates sent by
the server; user data travels separately from code. Requests are synchronous with unique ids, long commands can be
collected later without being run twice. Details: [manual](docs/MANUAL.md#1-how-it-works).

## Development

```bash
npm test
```

runs the protocol, serializer, media and documentation tests against a mock panel, no After Effects needed.
Every tool was also verified against a real After Effects 2026.

## Credits and license

- Inspiration: **Ruslan Tsapenko** and his "After Effects MCP by Ruslan Tsapenko" v0.1.0
  ([YouTube](https://www.youtube.com/@RuslanTsapenko), [tsapenko.com](https://tsapenko.com/)).
- Ported tools and ideas: [TheLlamainator/after-effects-mcp](https://github.com/TheLlamainator/after-effects-mcp),
  based on [Dakkshin/after-effects-mcp](https://github.com/Dakkshin/after-effects-mcp), MIT License © 2025 Dakkshin.
- Made by **Claude Code** & **Yuriy Martyniuk** (assistant, consultant and producer).
- License: [MIT](LICENSE).
