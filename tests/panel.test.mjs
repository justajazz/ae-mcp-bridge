// Static checks of the ExtendScript side + the panel's serializer run in a Node VM.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { JSX, LIB } from "../src/jsx.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const panelSource = fs.readFileSync(path.join(root, "src", "ae-mcp-panel.jsx"), "utf8");

// ExtendScript is ES3: these constructs throw a syntax error or do not exist in AE.
const ES5_PLUS = [
  [/\blet\s/, "let"], [/\bconst\s/, "const"], [/=>/, "arrow function"], [/`/, "template literal"],
  [/\.forEach\(/, "forEach"], [/\.map\(/, "map"], [/\.filter\(/, "filter"], [/\.reduce\(/, "reduce"],
  [/\.some\(/, "some"], [/\.every\(/, "every"], [/\.trim\(/, "trim"], [/Object\.keys/, "Object.keys"],
  [/Array\.isArray/, "Array.isArray"], [/\.padStart\(/, "padStart"], [/\.includes\(/, "includes"],
  [/\.startsWith\(/, "startsWith"], [/\.endsWith\(/, "endsWith"], [/\bclass\s/, "class"]
];

function stripComments(source) {
  return source.split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");
}

function assertEs3(source, label) {
  const code = stripComments(source);
  for (const [pattern, name] of ES5_PLUS) {
    assert.ok(!pattern.test(code), `${label}: ES3 violation (${name})`);
  }
  assert.doesNotThrow(() => new Function(code), `${label}: syntax error`);
}

test("panel is valid ES3", () => {
  assertEs3(panelSource, "ae-mcp-panel.jsx");
});

test("JSX templates and lib are valid ES3", () => {
  assertEs3(LIB, "lib");
  assert.ok(!LIB.includes("\n"), "lib must be a single line");
  for (const [name, code] of Object.entries(JSX)) assertEs3(LIB + " " + code, `template ${name}`);
});

test("panel and templates are pure ASCII (ExtendScript may not read UTF-8)", () => {
  assert.match(panelSource, /^[\x00-\x7f]*$/);
  for (const [name, code] of Object.entries(JSX)) assert.match(code, /^[\x00-\x7f]*$/, name);
  assert.match(LIB, /^[\x00-\x7f]*$/);
});

test("panel credits Ruslan Tsapenko as the inspiration", () => {
  assert.match(panelSource, /Ruslan Tsapenko/);
});

function loadSerializer() {
  const match = panelSource.match(/\/\/ @@serializer-begin([\s\S]*?)\/\/ @@serializer-end/);
  assert.ok(match, "serializer markers present");
  const context = vm.createContext({});
  vm.runInContext(match[1], context);
  return context.aeMcpSerializer;
}

const host = (type, props) => Object.assign(Object.create({ reflect: { name: type } }), props);

test("serializer: plain values, non-ASCII escaped", () => {
  const s = loadSerializer();
  const value = { name: "Слой «Титр»", n: 1.5, ok: true, nothing: null, list: [1, "два"], nan: NaN };
  const text = s.stringify(value);
  assert.match(text, /^[\x00-\x7f]*$/);
  assert.deepEqual(JSON.parse(text), { name: "Слой «Титр»", n: 1.5, ok: true, nothing: null, list: [1, "два"], nan: null });
  assert.equal(s.stringify(undefined), "null");
  assert.equal(JSON.parse(s.stringify('q"b\\s\n\t')), 'q"b\\s\n\t');
});

test("serializer: cycles and depth limit do not hang", () => {
  const s = loadSerializer();
  const a = { name: "a" };
  a.self = a;
  a.list = [a];
  assert.deepEqual(JSON.parse(s.stringify(a)), { name: "a", self: "[Circular]", list: ["[Circular]"] });

  let deep = {};
  const top = deep;
  for (let i = 0; i < 50; i++) { deep.next = {}; deep = deep.next; }
  assert.match(s.stringify(top), /\[Max depth\]/);
});

test("serializer: AE objects become short summaries", () => {
  const s = loadSerializer();
  const comp = host("CompItem", { id: 7, name: "Главная", typeName: "Composition" });
  comp.layers = { comp };
  const layer = host("TextLayer", { index: 2, name: "Титр", matchName: "ADBE Text Layer", containingComp: comp });
  const prop = host("Property", { name: "Position", matchName: "ADBE Position", propertyIndex: 2, value: [960, 540], numKeys: 0 });
  const doc = host("TextDocument", { text: "Привет", fontSize: 72, fillColor: [1, 1, 1] });
  const out = JSON.parse(s.stringify({ comp, layer, prop, doc, items: [comp] }));
  assert.deepEqual(out.comp, { _type: "CompItem", id: 7, name: "Главная", typeName: "Composition" });
  assert.deepEqual(out.layer, { _type: "TextLayer", index: 2, name: "Титр", matchName: "ADBE Text Layer", comp: "Главная" });
  assert.deepEqual(out.prop, { _type: "Property", name: "Position", matchName: "ADBE Position", propertyIndex: 2, numKeys: 0, value: [960, 540] });
  assert.deepEqual(out.doc, { _type: "TextDocument", text: "Привет", fontSize: 72, fillColor: [1, 1, 1] });
  assert.equal(out.items[0]._type, "CompItem");
});

test("serializer: functions skipped, dates as strings, big arrays truncated", () => {
  const s = loadSerializer();
  const out = JSON.parse(s.stringify({ f() {}, d: new Date(0), big: new Array(1500).fill(1) }));
  assert.equal("f" in out, false);
  assert.equal(typeof out.d, "string");
  assert.equal(out.big.length, 1001);
  assert.match(out.big[1000], /500 more items/);
});
