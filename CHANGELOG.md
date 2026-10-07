# Changelog

## 0.2.0 (2026-10-07)

Compared with "After Effects MCP by Ruslan Tsapenko" 0.1.0.

### Reliability

- One bridge folder for server and panel (`C:\MCP\ae-bridge`, `~/Library/Application Support/ae-mcp-bridge`),
  override with `AE_MCP_BRIDGE_DIR`; warning when it is inside a cloud-synced folder.
- Windows-safe file exchange: atomic writes with retries on `EPERM`/`EBUSY`, ASCII-only JSON so Cyrillic names and
  paths work regardless of ExtendScript's file encoding.
- Per-tool timeouts. A command that outlives its timeout keeps running and returns a `commandId`;
  `ae_get_result` collects it later. Duplicate execution is impossible: the panel refuses commands it did not pick
  up in time, the server refuses new commands while one is running, and finished commands are cleaned up.
- Safe serialization of results: depth limit, cycle detection, After Effects objects summarized (type, name, index, id).
- Rendered frames are deleted after reading; the server waits until a PNG is completely written.
- Panel: dockable ScriptUI panel with installer (`--link` loader or copy), log, autostart, single active instance,
  heartbeat status; version check between server and panel.

### Safety

- Every changing tool call is one undo group (`MCP: <tool>`).
- Project backup before the first change in a session (last 5 kept), daily script log,
  `AE_MCP_DISABLE_RUN_JSX` for a mode without arbitrary code.
- `ae_open_project` opens projects outside undo groups and refuses to drop unsaved changes silently.

### Tools (5 -> 34)

- Kept: `ae_health` (now with server, panel, project and settings details), `ae_run_jsx` (with `args`, `lib`
  helpers, timeout), `ae_list_project` (now also folders, footage, solids), `ae_save_project`, `ae_capture_frame`
  (background fill, comp/time choice, reference comparison).
- Ported from TheLlamainator/after-effects-mcp and reworked as synchronous, data-driven templates: compositions,
  layers (text, shape, solid, adjustment, null), layer settings, centering, layer timing, properties by path,
  keyframes with easing, expressions, effects (search, apply, list, remove), presets (search, apply), markers
  (single and batch), audio info, audio levels, WAV analysis with markers.
- New: `ae_capture_frames` (storyboard), `ae_get_selection`, `ae_inspect`, `ae_copy_animation`,
  `ae_add_text_animator`, `ae_set_comp`, `ae_render_preview`, `ae_run_jsx_file`, `ae_open_project`, `ae_guidelines`.
- Motion-design guidelines in the server instructions, the `ae_guidelines` tool and two MCP prompts.

### Fixes compared with the fork's implementations

- Temporal ease of spatial properties uses one `KeyframeEase` (the fork failed on Position).
- `app.effects` is read once (each access rebuilds the whole list; applying an effect took 41 s).
- Text animator copies skip the hidden placeholder properties of named groups.

### Testing and docs

- Mock-panel protocol tests (`npm test`); every tool verified against a real After Effects 2026.
- User manual, README, generated tool reference.
- Optional Claude skill `skills/after-effects-motion` (working loop, review checklist, recipes).
- Installation by an AI agent: `docs/INSTALL-AGENT.md` with checks per step, `scripts/check-install.mjs`
  (end-to-end check without a client), `scripts/configure-client.mjs` (Claude Desktop, Codex, `.mcp.json`).
