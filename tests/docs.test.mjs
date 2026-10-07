// Documentation stays in sync with the code. Works in every distribution (English-only or Russian):
// only the documents that exist are checked.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "../scripts/gen-tools-doc.mjs";
import { TOOLS, VERSION } from "../src/mcp-server.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const existing = files => files.filter(file => fs.existsSync(path.join(root, file)));

test("docs/TOOLS.md is generated from the current tools", () => {
  assert.equal(read("docs/TOOLS.md"), render(), "run: node scripts/gen-tools-doc.mjs");
});

test("manuals mention every tool; READMEs and changelog carry the version", () => {
  const manuals = existing(["docs/MANUAL.md", "docs/MANUAL.ru.md"]);
  assert.ok(manuals.length > 0, "at least one manual");
  for (const file of manuals) {
    const text = read(file);
    for (const tool of TOOLS) assert.ok(text.includes(tool.name), `${file} misses ${tool.name}`);
  }
  for (const file of existing(["README.md", "README.ru.md", "CHANGELOG.md"])) {
    assert.ok(read(file).includes(VERSION), `${file} misses version ${VERSION}`);
  }
});

test("READMEs credit Ruslan Tsapenko as the inspiration", () => {
  for (const file of existing(["README.md", "README.ru.md"])) assert.match(read(file), /Ruslan Tsapenko|Руслан(а)? Цапенко/);
});

test("relative links and images in the documents point to existing files", () => {
  const docs = existing(["README.md", "README.ru.md", "CHANGELOG.md", "docs/MANUAL.md", "docs/MANUAL.ru.md",
    "docs/TOOLS.md", "docs/INSTALL-AGENT.md", "skills/after-effects-motion/SKILL.md", "skills/after-effects-motion/RECIPES.md"]);
  for (const file of docs) {
    for (const [, target] of read(file).matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const resolved = path.join(root, path.dirname(file), target.split("#")[0]);
      assert.ok(fs.existsSync(resolved), `${file} links to missing ${target}`);
    }
  }
});
