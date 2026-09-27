'use strict';

/**
 * make-icon.js — генератор иконок Kitsune Browser без внешних зависимостей.
 *
 * Рисует голову лисы (символ Kitsune) в двух размерах:
 *   build/icon.png  — 256×256, для окна и Linux
 *   build/icon.ico  — ICO с PNG-полезной нагрузкой, для Windows/electron-builder
 *
 * Запуск: npm run icon
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'build');

/* ─────────────────────────── Цвета ─────────────────────────── */

const BG = [20, 22, 26, 255];        // #14161a — фон окна
const FOX = [255, 122, 41, 255];     // #ff7a29 — лисий акцент
const FOX_LIGHT = [255, 154, 82, 255]; // #ff9a52 — подсветка
const EYE = [20, 22, 26, 255];

/* ─────────────────────────── CRC32 для PNG ─────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ─────────────────────────── Сборка PNG ─────────────────────────── */

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(pixels, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter: none
    pixels.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ─────────────────────────── Растровые примитивы ─────────────────────────── */

function createCanvas(size) {
  return { size, data: Buffer.alloc(size * size * 4, 0) };
}

function blendPixel(canvas, x, y, color, alpha = 1) {
  if (x < 0 || y < 0 || x >= canvas.size || y >= canvas.size || alpha <= 0) return;
  const i = (y * canvas.size + x) * 4;
  const a = Math.min(1, alpha);
  for (let c = 0; c < 3; c++) {
    canvas.data[i + c] = Math.round(canvas.data[i + c] * (1 - a) + color[c] * a);
  }
  canvas.data[i + 3] = Math.round(canvas.data[i + 3] * (1 - a) + (color[3] ?? 255) * a);
}

/** Заливка многоугольника методом сканирующих строк со сглаживанием */
function fillPolygon(canvas, points, color) {
  const size = canvas.size;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minY = Math.min(minY, p[1]);
    maxY = Math.max(maxY, p[1]);
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(size - 1, Math.ceil(maxY));
  const SS = 4; // супер-сэмплинг по вертикали для сглаживания
  const coverage = new Float64Array(size);

  for (let y = y0; y <= y1; y++) {
    coverage.fill(0);
    for (let sy = 0; sy < SS; sy++) {
      const scanY = y + (sy + 0.5) / SS;
      const xs = [];
      for (let i = 0; i < points.length; i++) {
        const [x1, y1p] = points[i];
        const [x2, y2p] = points[(i + 1) % points.length];
        if ((y1p <= scanY && y2p > scanY) || (y2p <= scanY && y1p > scanY)) {
          xs.push(x1 + ((scanY - y1p) / (y2p - y1p)) * (x2 - x1));
        }
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const from = xs[i];
        const to = xs[i + 1];
        const xStart = Math.max(0, Math.floor(from));
        const xEnd = Math.min(size - 1, Math.ceil(to));
        for (let x = xStart; x <= xEnd; x++) {
          const left = Math.max(from, x);
          const right = Math.min(to, x + 1);
          if (right > left) coverage[x] += (right - left) / SS;
        }
      }
    }
    // Смешиваем один раз за строку, иначе полное покрытие не достигается
    for (let x = 0; x < size; x++) {
      if (coverage[x] > 0) blendPixel(canvas, x, y, color, Math.min(1, coverage[x]));
    }
  }
}

/** Заливка круга со сглаживанием */
function fillCircle(canvas, cx, cy, r, color) {
  const size = canvas.size;
  const x0 = Math.max(0, Math.floor(cx - r - 1));
  const x1 = Math.min(size - 1, Math.ceil(cx + r + 1));
  const y0 = Math.max(0, Math.floor(cy - r - 1));
  const y1 = Math.min(size - 1, Math.ceil(cy + r + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d <= r + 1) blendPixel(canvas, x, y, color, Math.max(0, Math.min(1, r + 0.5 - d)));
    }
  }
}

/** Закруглённый прямоугольник */
function fillRoundRect(canvas, x, y, w, h, radius, color) {
  const pts = [];
  const steps = 8;
  const corners = [
    [x + w - radius, y + radius, -Math.PI / 2, 0],
    [x + w - radius, y + h - radius, 0, Math.PI / 2],
    [x + radius, y + h - radius, Math.PI / 2, Math.PI],
    [x + radius, y + radius, Math.PI, Math.PI * 1.5]
  ];
  for (const [ccx, ccy, a0, a1] of corners) {
    for (let s = 0; s <= steps; s++) {
      const a = a0 + ((a1 - a0) * s) / steps;
      pts.push([ccx + radius * Math.cos(a), ccy + radius * Math.sin(a)]);
    }
  }
  fillPolygon(canvas, pts, color);
}

/* ─────────────────────────── Рисунок лисы ─────────────────────────── */

/** Точки головы лисы в системе координат 32×32 (как в SVG-логотипе) */
function foxOutline() {
  const pts = [
    [6, 4], [11, 11], [16, 8], [21, 11], [26, 4], [26, 17]
  ];
  // нижняя часть — половина эллипса от (26,17) через (16,28) к (6,17)
  const steps = 28;
  for (let i = 0; i <= steps; i++) {
    const t = (Math.PI * i) / steps;
    pts.push([16 + 10 * Math.cos(t), 17 + 11 * Math.sin(t)]);
  }
  return pts;
}

function drawIcon(size) {
  const canvas = createCanvas(size);
  const s = size / 32;

  // Фон — закруглённый квадрат цвета лисьего акцента
  fillRoundRect(canvas, 0.5 * s, 0.5 * s, 31 * s, 31 * s, 7 * s, FOX);

  // Мягкая подсветка сверху
  fillCircle(canvas, 16 * s, 2 * s, 14 * s, FOX_LIGHT);

  // Голова лисы — тёмным цветом поверх акцента
  fillPolygon(canvas, foxOutline().map(([x, y]) => [x * s, y * s]), BG);

  // Глаза
  fillCircle(canvas, 12.5 * s, 17 * s, 1.7 * s, FOX);
  fillCircle(canvas, 19.5 * s, 17 * s, 1.7 * s, FOX);

  return canvas;
}

/* ─────────────────────────── Сборка ICO ─────────────────────────── */

function encodeIco(pngBuffers) {
  const count = pngBuffers.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const entries = [];
  let offset = 6 + count * 16;

  for (const { size, data } of pngBuffers) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size; // 0 означает 256
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // палитра не используется
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4);  // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }

  return Buffer.concat([header, ...entries, ...pngBuffers.map((p) => p.data)]);
}

/* ─────────────────────────── Точка входа ─────────────────────────── */

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const sizes = [16, 32, 48, 64, 128, 256];
  const rendered = sizes.map((size) => ({ size, data: encodePng(drawIcon(size).data, size) }));

  const pngPath = path.join(OUT_DIR, 'icon.png');
  const icoPath = path.join(OUT_DIR, 'icon.ico');

  const big = rendered.find((r) => r.size === 256);
  fs.writeFileSync(pngPath, big.data);
  fs.writeFileSync(icoPath, encodeIco(rendered));

  console.log(`[Kitsune] Иконка создана: ${pngPath} (${big.data.length} байт)`);
  console.log(`[Kitsune] Иконка создана: ${icoPath} (${fs.statSync(icoPath).size} байт, ${sizes.length} размеров)`);
}

if (require.main === module) {
  main();
}

module.exports = { drawIcon, encodePng, encodeIco };
