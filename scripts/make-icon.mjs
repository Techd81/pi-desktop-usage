#!/usr/bin/env node
/**
 * Draw the plugin icon as a PNG, with no dependencies.
 *
 * The host only checks that `manifest.icon` exists and renders it at small
 * sizes, so the shape is drawn as plain geometry at 4× and box-filtered down:
 * deterministic, reproducible, and easy to tweak without an image editor.
 *
 * Usage: node scripts/make-icon.mjs [out.png]
 */

import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 512;
const SCALE = 4;
const W = SIZE * SCALE;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outPath = process.argv[2] ?? path.join(root, "views", "assets", "icon.png");

// ---------------------------------------------------------------- geometry

const radiusMask = (x, y, left, top, right, bottom, radius) => {
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
};


const distanceToSegment = (px, py, ax, ay, bx, by) => {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const lengthSq = vx * vx + vy * vy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / lengthSq));
  const dx = px - (ax + t * vx);
  const dy = py - (ay + t * vy);
  return Math.sqrt(dx * dx + dy * dy);
};

const mix = (a, b, t) => a + (b - a) * t;

// Canvas coordinates are 512-based; sampling multiplies by SCALE.
const PAD = 96;
const BASE_Y = 400;
const BAR_WIDTH = 48;
const BAR_GAP = 24;
const BAR_RADIUS = 12;
const heights = [80, 128, 176, 224, 288];
const barCount = heights.length;
const totalWidth = barCount * BAR_WIDTH + (barCount - 1) * BAR_GAP;
const startX = (SIZE - totalWidth) / 2;

const bars = heights.map((height, index) => {
  const left = startX + index * (BAR_WIDTH + BAR_GAP);
  return { left, top: BASE_Y - height, right: left + BAR_WIDTH, bottom: BASE_Y, height };
});

const linePoints = bars.map((bar) => ({
  x: (bar.left + bar.right) / 2,
  y: bar.top - 26,
}));

// ------------------------------------------------------------------- paint

const buffer = Buffer.alloc(W * W * 3);

for (let py = 0; py < W; py += 1) {
  for (let px = 0; px < W; px += 1) {
    const x = (px + 0.5) / SCALE;
    const y = (py + 0.5) / SCALE;
    let r = 0;
    let g = 0;
    let b = 0;

    // Rounded dark plate: keeps the mark readable on both light and dark hosts.
    if (radiusMask(x, y, PAD * 0.28, PAD * 0.28, SIZE - PAD * 0.28, SIZE - PAD * 0.28, 112)) {
      const t = (x + y) / (2 * SIZE);
      r = mix(0x23, 0x0b, t);
      g = mix(0x2a, 0x0e, t);
      b = mix(0x36, 0x13, t);
    }

    // Bars: the accent ramp, brighter as the value grows.
    for (const bar of bars) {
      if (!radiusMask(x, y, bar.left, bar.top, bar.right, bar.bottom, BAR_RADIUS)) continue;
      const t = (bar.height - 80) / (288 - 80);
      r = mix(0x1f, 0x62, t);
      g = mix(0x6f, 0xcf, t);
      b = mix(0xeb, 0xa4, t);
    }

    // Trend line over the bars, plus a dot on the last point.
    for (let index = 0; index < linePoints.length - 1; index += 1) {
      const a = linePoints[index];
      const c = linePoints[index + 1];
      if (distanceToSegment(x, y, a.x, a.y, c.x, c.y) <= 7) {
        r = 0xf5;
        g = 0xf7;
        b = 0xff;
      }
    }
    const last = linePoints[linePoints.length - 1];
    const dotX = x - last.x;
    const dotY = y - last.y;
    if (dotX * dotX + dotY * dotY <= 15 * 15) {
      r = 0xff;
      g = 0xff;
      b = 0xff;
    }

    const offset = (py * W + px) * 3;
    buffer[offset] = Math.round(r);
    buffer[offset + 1] = Math.round(g);
    buffer[offset + 2] = Math.round(b);
  }
}

// ------------------------------------------------------------- downsample

const out = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SCALE; sy += 1) {
      for (let sx = 0; sx < SCALE; sx += 1) {
        const px = x * SCALE + sx;
        const py = y * SCALE + sy;
        const offset = (py * W + px) * 3;
        const covered = buffer[offset] + buffer[offset + 1] + buffer[offset + 2] > 0 ? 1 : 0;
        r += buffer[offset] * covered;
        g += buffer[offset + 1] * covered;
        b += buffer[offset + 2] * covered;
        a += covered;
      }
    }
    const samples = SCALE * SCALE;
    const target = (y * SIZE + x) * 4;
    if (a > 0) {
      out[target] = Math.round(r / a);
      out[target + 1] = Math.round(g / a);
      out[target + 2] = Math.round(b / a);
      out[target + 3] = Math.round((a / samples) * 255);
    } else {
      out[target + 3] = 0;
    }
  }
}

// ------------------------------------------------------------- png writer

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

const crc32 = (bytes) => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
};

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // bit depth
header[9] = 6; // RGBA
header[10] = 0;
header[11] = 0;
header[12] = 0;

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (SIZE * 4 + 1)] = 0; // no filter
  out.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", header),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

writeFileSync(outPath, png);
console.log(`icon ${SIZE}x${SIZE} → ${outPath}`);
console.log(`bytes ${png.length}`);
console.log(`sha256 ${createHash("sha256").update(png).digest("hex")}`);
