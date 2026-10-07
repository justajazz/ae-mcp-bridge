// Node-side media helpers for AE MCP Bridge (zero dependencies):
// PNG flattening onto a background color, WAV analysis, .ffx preset discovery.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

// ---- PNG ---------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

export function decodePng(buffer) {
  let pos = 8, width, height, depth, colorType, interlace;
  const idat = [];
  while (pos + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString("latin1", pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + length;
  }
  const channels = CHANNELS[colorType];
  if (!channels || (depth !== 8 && depth !== 16) || interlace) {
    throw new Error(`Unsupported PNG (color type ${colorType}, depth ${depth}, interlace ${interlace})`);
  }
  const bpp = channels * depth / 8;
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
    prev = cur;
  }
  return { width, height, depth, channels, pixels };
}

export function encodePngRgb(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 1; // Sub filter: compresses flat backgrounds well
    for (let x = 0; x < stride; x++) {
      const v = rgb[y * stride + x];
      raw[y * (stride + 1) + 1 + x] = (v - (x >= 3 ? rgb[y * stride + x - 3] : 0)) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

// Parses '#RRGGBB', '#RGB', [r,g,b] in 0..1 or 0..255. Returns 0..1 floats.
export function parseColor(value) {
  if (Array.isArray(value) && value.length >= 3) {
    const c = value.slice(0, 3).map(Number);
    if (c.some(v => !Number.isFinite(v))) throw new Error(`Bad color: ${JSON.stringify(value)}`);
    return c.some(v => v > 1) ? c.map(v => v / 255) : c;
  }
  if (typeof value === "string") {
    let hex = value.trim().replace(/^#/, "");
    if (hex.length === 3) hex = [...hex].map(ch => ch + ch).join("");
    if (/^[0-9a-f]{6}$/i.test(hex)) return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  }
  throw new Error(`Bad color: ${JSON.stringify(value)} (use '#RRGGBB' or [r,g,b])`);
}

// Composites a PNG with alpha onto a solid color (straight alpha). Opaque PNGs are returned as-is.
export function flattenPng(buffer, color) {
  const img = decodePng(buffer);
  if (img.channels !== 2 && img.channels !== 4) return buffer;
  const [br, bg, bb] = color.map(c => c * 255);
  const n = img.width * img.height;
  const rgb = Buffer.alloc(n * 3);
  const wide = img.depth === 16;
  const max = wide ? 65535 : 255;
  const sample = (i) => (wide ? img.pixels.readUInt16BE(i * 2) : img.pixels[i]);
  for (let p = 0; p < n; p++) {
    const base = p * img.channels;
    const alpha = sample(base + img.channels - 1) / max;
    const scale = 255 / max;
    let r, g, b;
    if (img.channels === 4) { r = sample(base) * scale; g = sample(base + 1) * scale; b = sample(base + 2) * scale; }
    else { r = g = b = sample(base) * scale; }
    rgb[p * 3] = Math.round(r * alpha + br * (1 - alpha));
    rgb[p * 3 + 1] = Math.round(g * alpha + bg * (1 - alpha));
    rgb[p * 3 + 2] = Math.round(b * alpha + bb * (1 - alpha));
  }
  return encodePngRgb(img.width, img.height, rgb);
}

// Any decoded PNG (8/16-bit, gray/RGB, with or without alpha) -> 8-bit RGB, alpha ignored.
export function toRgb8(img) {
  const n = img.width * img.height;
  const rgb = Buffer.alloc(n * 3);
  const wide = img.depth === 16;
  const at = i => (wide ? img.pixels[i * 2] : img.pixels[i]); // high byte is enough for 8-bit output
  for (let p = 0; p < n; p++) {
    const base = p * img.channels;
    if (img.channels >= 3) { rgb[p * 3] = at(base); rgb[p * 3 + 1] = at(base + 1); rgb[p * 3 + 2] = at(base + 2); }
    else { rgb[p * 3] = rgb[p * 3 + 1] = rgb[p * 3 + 2] = at(base); }
  }
  return { width: img.width, height: img.height, rgb };
}

// Area-average downscale (or nearest upscale) of an RGB buffer.
export function resizeRgb({ width, height, rgb }, newWidth, newHeight) {
  const out = Buffer.alloc(newWidth * newHeight * 3);
  const sx = width / newWidth, sy = height / newHeight;
  for (let y = 0; y < newHeight; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.min(height, Math.floor((y + 1) * sy)));
    for (let x = 0; x < newWidth; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.min(width, Math.floor((x + 1) * sx)));
      let r = 0, g = 0, b = 0, count = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * width + xx) * 3;
          r += rgb[i]; g += rgb[i + 1]; b += rgb[i + 2]; count++;
        }
      }
      const o = (y * newWidth + x) * 3;
      out[o] = Math.round(r / count); out[o + 1] = Math.round(g / count); out[o + 2] = Math.round(b / count);
    }
  }
  return { width: newWidth, height: newHeight, rgb: out };
}

// 5x7 bitmap glyphs for frame labels such as "1.25s f31".
const GLYPHS = {
  "0": [14, 17, 19, 21, 25, 17, 14], "1": [4, 12, 4, 4, 4, 4, 14], "2": [14, 17, 1, 2, 4, 8, 31],
  "3": [30, 1, 1, 14, 1, 1, 30], "4": [2, 6, 10, 18, 31, 2, 2], "5": [31, 16, 30, 1, 1, 17, 14],
  "6": [6, 8, 16, 30, 17, 17, 14], "7": [31, 1, 2, 4, 8, 8, 8], "8": [14, 17, 17, 14, 17, 17, 14],
  "9": [14, 17, 17, 15, 1, 2, 12], ".": [0, 0, 0, 0, 0, 12, 12], "s": [0, 0, 14, 16, 14, 1, 30],
  "f": [6, 9, 8, 28, 8, 8, 8], "-": [0, 0, 0, 31, 0, 0, 0], ":": [0, 12, 12, 0, 12, 12, 0], " ": [0, 0, 0, 0, 0, 0, 0]
};

function drawText(canvas, canvasWidth, text, x, y, scale, color) {
  let cx = x;
  for (const ch of text) {
    const glyph = GLYPHS[ch] ?? GLYPHS[" "];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (!(glyph[row] & (16 >> col))) continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const px = cx + col * scale + dx, py = y + row * scale + dy;
            const i = (py * canvasWidth + px) * 3;
            if (i >= 0 && i + 2 < canvas.length) { canvas[i] = color[0]; canvas[i + 1] = color[1]; canvas[i + 2] = color[2]; }
          }
        }
      }
    }
    cx += 6 * scale;
  }
}

// Grid of frames with a label strip under each one. frames: [{ width, height, rgb, label }].
export function contactSheet(frames, { columns, maxWidth = 2048, gap = 8, background = [24, 24, 24] } = {}) {
  if (!frames.length) throw new Error("No frames for the contact sheet");
  const cols = Math.max(1, Math.min(columns || Math.ceil(Math.sqrt(frames.length)), frames.length));
  const rows = Math.ceil(frames.length / cols);
  const first = frames[0];
  const cellWidth = Math.min(first.width, Math.floor((maxWidth - gap * (cols + 1)) / cols));
  const cellHeight = Math.max(1, Math.round(first.height * cellWidth / first.width));
  const scale = cellWidth >= 400 ? 3 : 2;
  const labelHeight = 7 * scale + 8;
  const width = gap + cols * (cellWidth + gap);
  const height = gap + rows * (cellHeight + labelHeight + gap);
  const canvas = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) canvas.set(background, i * 3);
  frames.forEach((frame, index) => {
    const cell = resizeRgb(frame, cellWidth, cellHeight);
    const x0 = gap + (index % cols) * (cellWidth + gap);
    const y0 = gap + Math.floor(index / cols) * (cellHeight + labelHeight + gap);
    for (let y = 0; y < cellHeight; y++) {
      cell.rgb.copy(canvas, ((y0 + y) * width + x0) * 3, y * cellWidth * 3, (y + 1) * cellWidth * 3);
    }
    if (frame.label) drawText(canvas, width, frame.label, x0 + 2, y0 + cellHeight + 4, scale, [230, 230, 230]);
  });
  return { png: encodePngRgb(width, height, canvas), width, height, columns: cols, rows, cellWidth, cellHeight };
}

// ---- WAV -----------------------------------------------------------------------

function readWavFormat(buffer) {
  if (buffer.toString("latin1", 0, 4) !== "RIFF" || buffer.toString("latin1", 8, 12) !== "WAVE") {
    throw new Error("Not a WAV file (RIFF/WAVE header missing). Convert the audio to WAV first.");
  }
  let pos = 12, fmt = null, dataStart = -1, dataLength = 0;
  while (pos + 8 <= buffer.length) {
    const id = buffer.toString("latin1", pos, pos + 4);
    const size = buffer.readUInt32LE(pos + 4);
    if (id === "fmt ") {
      let format = buffer.readUInt16LE(pos + 8);
      if (format === 0xfffe && size >= 26) format = buffer.readUInt16LE(pos + 8 + 24); // WAVE_FORMAT_EXTENSIBLE subformat
      fmt = { format, channels: buffer.readUInt16LE(pos + 10), sampleRate: buffer.readUInt32LE(pos + 12), bits: buffer.readUInt16LE(pos + 22) };
    } else if (id === "data") {
      dataStart = pos + 8;
      dataLength = Math.min(size, buffer.length - dataStart);
      break;
    }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || dataStart < 0) throw new Error("WAV file has no fmt or data chunk");
  const supported = (fmt.format === 1 && [8, 16, 24, 32].includes(fmt.bits)) || (fmt.format === 3 && [32, 64].includes(fmt.bits));
  if (!supported) throw new Error(`Unsupported WAV encoding (format ${fmt.format}, ${fmt.bits} bit). Use PCM or float WAV.`);
  return { ...fmt, dataStart, dataLength };
}

function sampleReader(buffer, fmt) {
  const { format, bits } = fmt;
  if (format === 3) return bits === 32 ? i => buffer.readFloatLE(i) : i => buffer.readDoubleLE(i);
  if (bits === 8) return i => (buffer[i] - 128) / 128;
  if (bits === 16) return i => buffer.readInt16LE(i) / 32768;
  if (bits === 24) return i => buffer.readIntLE(i, 3) / 8388608;
  return i => buffer.readInt32LE(i) / 2147483648;
}

// Peak envelope + transient peaks. threshold is relative to the loudest point (0..1).
export function analyzeWav(buffer, { points = 200, threshold = 0.6, minGap = 0.1 } = {}) {
  const fmt = readWavFormat(buffer);
  const bytes = fmt.bits / 8;
  const frameBytes = bytes * fmt.channels;
  const frames = Math.floor(fmt.dataLength / frameBytes);
  const duration = frames / fmt.sampleRate;
  const read = sampleReader(buffer, fmt);
  const count = Math.max(1, Math.min(points, frames));
  const envelope = new Array(count).fill(0);
  for (let f = 0; f < frames; f++) {
    const bucket = Math.min(count - 1, Math.floor((f * count) / frames));
    const base = fmt.dataStart + f * frameBytes;
    for (let ch = 0; ch < fmt.channels; ch++) {
      const v = Math.abs(read(base + ch * bytes));
      if (v > envelope[bucket]) envelope[bucket] = v;
    }
  }
  const step = duration / count;
  const loudest = Math.max(...envelope, 0);
  const peaks = [];
  let lastPeak = -Infinity;
  for (let i = 0; i < count; i++) {
    const v = envelope[i];
    const left = i > 0 ? envelope[i - 1] : -1;
    const right = i < count - 1 ? envelope[i + 1] : -1;
    const time = i * step;
    if (loudest > 0 && v >= loudest * threshold && v >= left && v >= right && time - lastPeak >= minGap) {
      peaks.push({ time: +time.toFixed(3), amplitude: +(v / loudest).toFixed(3) });
      lastPeak = time;
    }
  }
  return {
    duration: +duration.toFixed(4),
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bits: fmt.bits,
    format: fmt.format === 3 ? "float" : "pcm",
    peakLevel: +loudest.toFixed(4),
    step: +step.toFixed(4),
    envelope: envelope.map(v => +(loudest > 0 ? v / loudest : 0).toFixed(3)),
    peaks
  };
}

// ---- presets -------------------------------------------------------------------

export async function defaultPresetRoots(env = process.env, platform = process.platform) {
  const home = os.homedir();
  const candidates = [path.join(home, "Documents", "Adobe")];
  if (platform === "win32") {
    const programFiles = env.ProgramFiles || "C:\\Program Files";
    try {
      for (const name of await fs.readdir(path.join(programFiles, "Adobe"))) {
        if (/^Adobe After Effects/i.test(name)) candidates.push(path.join(programFiles, "Adobe", name, "Support Files", "Presets"));
      }
    } catch { /* no Adobe folder */ }
  } else if (platform === "darwin") {
    try {
      for (const name of await fs.readdir("/Applications")) {
        if (/^Adobe After Effects/i.test(name)) candidates.push(path.join("/Applications", name, "Presets"));
      }
    } catch { /* ignore */ }
  }
  const roots = [];
  for (const dir of candidates) {
    try { if ((await fs.stat(dir)).isDirectory()) roots.push(dir); } catch { /* missing */ }
  }
  return roots;
}

export async function findPresets(roots, { query = "", max = 200, maxDepth = 8 } = {}) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  const found = [];
  const seen = new Set();
  async function walk(dir, root, depth) {
    if (found.length >= max || depth > maxDepth) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (found.length >= max) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full, root, depth + 1); continue; }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".ffx")) continue;
      const key = full.toLowerCase();
      if (seen.has(key)) continue;
      const relative = path.relative(root, full);
      if (words.length && !words.every(w => relative.toLowerCase().includes(w))) continue;
      seen.add(key);
      found.push({ name: entry.name.replace(/\.ffx$/i, ""), category: path.dirname(relative) === "." ? "" : path.dirname(relative), path: full });
    }
  }
  for (const root of roots) await walk(root, root, 0);
  return found;
}
