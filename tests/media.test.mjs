// PNG flattening, WAV analysis, preset discovery.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { analyzeWav, decodePng, encodePngRgb, findPresets, flattenPng, parseColor } from "../src/media.mjs";

// Minimal RGBA / gray+alpha PNG writer for test inputs (filter 0).
function rgbaPng(width, height, pixels, { channels = 4, depth = 8 } = {}) {
  const bytes = depth / 8;
  const stride = width * channels * bytes;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width * channels; x++) {
      const v = pixels[y * width * channels + x];
      if (depth === 16) raw.writeUInt16BE(v, y * (stride + 1) + 1 + x * 2);
      else raw[y * (stride + 1) + 1 + x] = v;
    }
  }
  const png = encodePngRgb(1, 1, Buffer.from([0, 0, 0])); // borrow signature + chunk layout
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;
  ihdr[9] = channels === 4 ? 6 : 4;
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    return Buffer.concat([head, data, Buffer.alloc(4)]); // CRC not checked by our decoder
  };
  return Buffer.concat([png.subarray(0, 8), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

test("parseColor accepts hex and arrays", () => {
  assert.deepEqual(parseColor("#ff0000"), [1, 0, 0]);
  assert.deepEqual(parseColor("0f0"), [0, 1, 0]);
  assert.deepEqual(parseColor([0, 0, 255]), [0, 0, 1]);
  assert.deepEqual(parseColor([0.5, 0.5, 0.5]), [0.5, 0.5, 0.5]);
  assert.throws(() => parseColor("red"), /Bad color/);
});

test("flattenPng composites straight alpha onto the background", () => {
  // 2x1: opaque red, fully transparent
  const src = rgbaPng(2, 1, [255, 0, 0, 255, 0, 255, 0, 0]);
  const out = decodePng(flattenPng(src, [0, 0, 1]));
  assert.equal(out.channels, 3);
  assert.deepEqual([...out.pixels], [255, 0, 0, 0, 0, 255]);

  // half-transparent white over black -> mid gray
  const half = decodePng(flattenPng(rgbaPng(1, 1, [255, 255, 255, 128]), [0, 0, 0]));
  assert.ok(Math.abs(half.pixels[0] - 128) <= 1);
});

test("flattenPng handles 16-bit and gray+alpha, leaves opaque PNGs alone", () => {
  const wide = decodePng(flattenPng(rgbaPng(1, 1, [65535, 0, 0, 65535], { depth: 16 }), [0, 0, 0]));
  assert.deepEqual([...wide.pixels], [255, 0, 0]);
  const gray = decodePng(flattenPng(rgbaPng(1, 1, [200, 0], { channels: 2 }), [1, 1, 1]));
  assert.deepEqual([...gray.pixels], [255, 255, 255]);
  const opaque = encodePngRgb(1, 1, Buffer.from([1, 2, 3]));
  assert.equal(flattenPng(opaque, [0, 0, 0]), opaque);
});

test("encodePngRgb round-trips through decodePng", () => {
  const rgb = Buffer.from([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]);
  const out = decodePng(encodePngRgb(2, 2, rgb));
  assert.deepEqual([...out.pixels], [...rgb]);
});

function wav({ seconds = 2, rate = 8000, channels = 1, bits = 16, format = 1, clicks = [] }) {
  const frames = seconds * rate;
  const bytes = bits / 8;
  const data = Buffer.alloc(frames * channels * bytes);
  const write = (value, offset) => {
    if (format === 3) data.writeFloatLE(value, offset);
    else if (bits === 16) data.writeInt16LE(Math.round(value * 32767), offset);
    else if (bits === 24) data.writeIntLE(Math.round(value * 8388607), offset, 3);
    else if (bits === 8) data[offset] = Math.round(value * 127 + 128);
  };
  for (let f = 0; f < frames; f++) {
    const t = f / rate;
    let v = 0.05 * Math.sin(2 * Math.PI * 220 * t);
    for (const c of clicks) if (t >= c && t < c + 0.02) v = 0.9 * Math.sin(2 * Math.PI * 1000 * t) || 0.9;
    for (let ch = 0; ch < channels; ch++) write(v, (f * channels + ch) * bytes);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(format, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * bytes, 28);
  header.writeUInt16LE(channels * bytes, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

test("analyzeWav finds clicks in 16-bit, 24-bit and float WAV", () => {
  for (const spec of [{ bits: 16 }, { bits: 24, channels: 2 }, { bits: 32, format: 3 }, { bits: 8 }]) {
    const result = analyzeWav(wav({ ...spec, clicks: [0.5, 1.25] }), { points: 400 });
    assert.equal(result.duration, 2);
    const times = result.peaks.map(p => p.time);
    assert.equal(times.length, 2, `${JSON.stringify(spec)}: ${JSON.stringify(times)}`);
    assert.ok(Math.abs(times[0] - 0.5) < 0.02 && Math.abs(times[1] - 1.25) < 0.02, JSON.stringify(times));
    assert.equal(result.envelope.length, 400);
  }
});

test("analyzeWav rejects non-WAV and compressed data", () => {
  assert.throws(() => analyzeWav(Buffer.from("ID3 not a wav file at all.......")), /Not a WAV/);
  const adpcm = wav({});
  adpcm.writeUInt16LE(2, 20);
  assert.throws(() => analyzeWav(adpcm), /Unsupported WAV/);
});

test("findPresets searches recursively with all query words", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "пресеты "));
  await fs.mkdir(path.join(root, "Transitions - Dissolves"), { recursive: true });
  await fs.mkdir(path.join(root, "Blurs"), { recursive: true });
  await fs.writeFile(path.join(root, "Transitions - Dissolves", "Dissolve - blur in.ffx"), "x");
  await fs.writeFile(path.join(root, "Blurs", "Fast blur out.ffx"), "x");
  await fs.writeFile(path.join(root, "Blurs", "readme.txt"), "x");
  const all = await findPresets([root]);
  assert.equal(all.length, 2);
  const hits = await findPresets([root], { query: "blur in" });
  assert.deepEqual(hits.map(h => h.name), ["Dissolve - blur in"]);
  assert.equal(hits[0].category, "Transitions - Dissolves");
  await fs.rm(root, { recursive: true, force: true });
});

test("contactSheet lays frames out in a grid with labels", async () => {
  const { contactSheet, resizeRgb, toRgb8 } = await import("../src/media.mjs");
  const frame = color => ({ width: 40, height: 20, rgb: Buffer.alloc(40 * 20 * 3, color), label: "1.25s f31" });
  const sheet = contactSheet([frame(255), frame(0), frame(128)], { columns: 2, maxWidth: 200, gap: 4 });
  assert.equal(sheet.columns, 2);
  assert.equal(sheet.rows, 2);
  const img = decodePng(sheet.png);
  assert.equal(img.width, sheet.width);
  // top-left pixel of the first cell is the frame color (white)
  const i = (4 * img.width + 4) * 3;
  assert.deepEqual([...img.pixels.subarray(i, i + 3)], [255, 255, 255]);
  // label pixels exist below the first cell
  const labelRow = 4 + sheet.cellHeight + 4;
  let lit = 0;
  for (let x = 0; x < sheet.cellWidth; x++) if (img.pixels[(labelRow * img.width + 4 + x) * 3] === 230) lit++;
  assert.ok(lit > 0, "label drawn");

  const small = resizeRgb({ width: 4, height: 2, rgb: Buffer.from([0, 0, 0, 255, 255, 255, 0, 0, 0, 255, 255, 255, 0, 0, 0, 255, 255, 255, 0, 0, 0, 255, 255, 255]) }, 2, 1);
  assert.deepEqual([...small.rgb], [128, 128, 128, 128, 128, 128]);
  const gray16 = toRgb8({ width: 1, height: 1, depth: 16, channels: 2, pixels: Buffer.from([0x80, 0x00, 0xff, 0xff]) });
  assert.deepEqual([...gray16.rgb], [128, 128, 128]);
});
