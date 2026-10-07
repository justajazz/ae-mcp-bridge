#!/usr/bin/env node
// Generates docs/TOOLS.md (parameter reference) from the tool definitions in src/mcp-server.mjs.
//   node scripts/gen-tools-doc.mjs          write the file
//   node scripts/gen-tools-doc.mjs --check  exit 1 if the file is out of date (used by tests)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS, VERSION } from "../src/mcp-server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "docs", "TOOLS.md");

export const CATEGORIES = [
  ["Bridge and project", ["ae_health", "ae_guidelines", "ae_list_project", "ae_open_project", "ae_save_project", "ae_get_result"]],
  ["Scripting", ["ae_run_jsx", "ae_run_jsx_file"]],
  ["Looking at the result", ["ae_capture_frame", "ae_capture_frames", "ae_render_preview", "ae_get_selection", "ae_inspect"]],
  ["Compositions and layers", ["ae_create_comp", "ae_set_comp", "ae_create_layer", "ae_set_layer", "ae_center_layers", "ae_get_layer_timing"]],
  ["Properties and animation", ["ae_set_property", "ae_set_keyframes", "ae_set_expression", "ae_add_text_animator", "ae_copy_animation"]],
  ["Effects and presets", ["ae_list_available_effects", "ae_apply_effect", "ae_list_layer_effects", "ae_remove_effects", "ae_list_presets", "ae_apply_preset"]],
  ["Markers and audio", ["ae_add_markers", "ae_get_audio_info", "ae_set_audio_levels", "ae_analyze_audio"]]
];

const typeOf = schema => {
  if (!schema.type) return "any";
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  return types.join(" | ") + (schema.enum ? `: ${schema.enum.map(v => `\`${v}\``).join(", ")}` : "");
};
const cell = text => String(text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

export function render() {
  const byName = new Map(TOOLS.map(t => [t.name, t]));
  const listed = CATEGORIES.flatMap(([, names]) => names);
  const missing = TOOLS.map(t => t.name).filter(n => !listed.includes(n));
  const unknown = listed.filter(n => !byName.has(n));
  if (missing.length || unknown.length) throw new Error(`Categories out of sync. Missing: ${missing} Unknown: ${unknown}`);

  const out = [
    "# Tool reference",
    "",
    `AE MCP Bridge ${VERSION}: ${TOOLS.length} tools. Generated from \`src/mcp-server.mjs\` by \`scripts/gen-tools-doc.mjs\`; do not edit by hand.`,
    "",
    "Common conventions:",
    "",
    "- `comp`: composition name or numeric item id; omitted = the active composition.",
    "- `layer`: layer name or 1-based index.",
    "- `property`: a path such as `Transform/Position`, `Opacity`, `Effects/Gaussian Blur/Blurriness`, " +
      "`Text/Animators/Animator 1` (names, matchNames or indices).",
    "- Colors: `#RRGGBB` or `[r, g, b]` in 0..1 (0..255 is accepted too). Times are in seconds.",
    "- Tools marked *one undo step* change the project and are undone with a single Ctrl+Z.",
    "",
    "![Property paths through a layer's property tree](images/property-paths.svg)",
    "",
    "## Contents",
    ""
  ];
  for (const [title, names] of CATEGORIES) {
    out.push(`- **${title}**: ${names.map(n => `[${n}](#${n})`).join(", ")}`);
  }
  for (const [title, names] of CATEGORIES) {
    out.push("", `## ${title}`);
    for (const name of names) {
      const tool = byName.get(name);
      const props = tool.inputSchema.properties ?? {};
      const required = new Set(tool.inputSchema.required ?? []);
      out.push("", `### ${name}`, "", tool.description);
      if (Object.keys(props).length) {
        out.push("", "| Parameter | Type | Description |", "|---|---|---|");
        for (const [key, schema] of Object.entries(props)) {
          out.push(`| \`${key}\`${required.has(key) ? " *(required)*" : ""} | ${cell(typeOf(schema))} | ${cell(schema.description)} |`);
        }
      } else {
        out.push("", "No parameters.");
      }
    }
  }
  return out.join("\n") + "\n";
}

const entry = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : "";
if (entry === fileURLToPath(import.meta.url).toLowerCase()) {
  const text = render();
  if (process.argv.includes("--check")) {
    const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
    if (current !== text) { console.error("docs/TOOLS.md is out of date: run node scripts/gen-tools-doc.mjs"); process.exit(1); }
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
    console.log(`Wrote ${target}`);
  }
}
