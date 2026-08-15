// DSH Desk 图标生成器 —— 纯 Node 实现（zlib 内置），零外部依赖
// 生成 assets/icon.png (256x256)、assets/tray.png (32x32) 与 assets/icon.ico
// （16px 仅打包进 icon.ico，不再单独输出 tray16.png）
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(__dirname, "..", "assets");
fs.mkdirSync(ASSETS, { recursive: true });

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- 绘图 ----------
const SIZE = 256;
const buf = Buffer.alloc(SIZE * SIZE * 4);

function blend(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE || a <= 0) return;
  const i = (y * SIZE + x) * 4;
  const sa = a / 255;
  const da = buf[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return;
  buf[i] = Math.round((r * sa + buf[i] * da * (1 - sa)) / oa);
  buf[i + 1] = Math.round((g * sa + buf[i + 1] * da * (1 - sa)) / oa);
  buf[i + 2] = Math.round((b * sa + buf[i + 2] * da * (1 - sa)) / oa);
  buf[i + 3] = Math.round(oa * 255);
}

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdRect(px, py, cx, cy, hw, hh) {
  const dx = Math.abs(px - cx) - hw;
  const dy = Math.abs(py - cy) - hh;
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0);
}

function fillRoundRect(cx, cy, hw, hh, r, color) {
  for (let y = Math.floor(cy - hh - 2); y <= Math.ceil(cy + hh + 2); y++) {
    for (let x = Math.floor(cx - hw - 2); x <= Math.ceil(cx + hw + 2); x++) {
      const d = sdRoundRect(x + 0.5, y + 0.5, cx, cy, hw, hh, r);
      const a = Math.max(0, Math.min(1, 0.5 - d));
      if (a > 0) blend(x, y, color[0], color[1], color[2], Math.round(a * color[3]));
    }
  }
}

function fillRect(cx, cy, hw, hh, color) {
  for (let y = Math.floor(cy - hh - 1); y <= Math.ceil(cy + hh + 1); y++) {
    for (let x = Math.floor(cx - hw - 1); x <= Math.ceil(cx + hw + 1); x++) {
      const d = sdRect(x + 0.5, y + 0.5, cx, cy, hw, hh);
      const a = Math.max(0, Math.min(1, 0.5 - d));
      if (a > 0) blend(x, y, color[0], color[1], color[2], Math.round(a * color[3]));
    }
  }
}

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

// 背景：深蓝渐变圆角方块
for (let y = 0; y < SIZE; y++) {
  const t = y / SIZE;
  const r = lerp(0x16, 0x0a, t);
  const g = lerp(0x7a, 0x3d, t);
  const b = lerp(0xf2, 0x91, t);
  for (let x = 0; x < SIZE; x++) {
    const d = sdRoundRect(x + 0.5, y + 0.5, 128, 128, 118, 118, 56);
    const a = Math.max(0, Math.min(1, 0.5 - d));
    if (a > 0) blend(x, y, r, g, b, Math.round(a * 255));
  }
}

// 白色聊天气泡
fillRoundRect(128, 128, 84, 62, 30, [255, 255, 255, 255]);
// 气泡小尾巴
fillRoundRect(94, 182, 22, 10, 8, [255, 255, 255, 255]);
fillRect(108, 196, 14, 14, [255, 255, 255, 255]);

// 内部三行消息条（深蓝）
const BAR = [0x0a, 0x3d, 0x91, 255];
fillRoundRect(128, 100, 52, 10, 10, BAR);
fillRoundRect(128, 128, 34, 10, 10, BAR);
fillRoundRect(128, 156, 52, 10, 10, BAR);

// ---------- 缩放（盒式滤波） ----------
function downscale(src, srcSize, dstSize) {
  const dst = Buffer.alloc(dstSize * dstSize * 4);
  const scale = srcSize / dstSize;
  for (let y = 0; y < dstSize; y++) {
    for (let x = 0; x < dstSize; x++) {
      const x0 = Math.floor(x * scale);
      const y0 = Math.floor(y * scale);
      const x1 = Math.min(srcSize - 1, Math.ceil((x + 1) * scale));
      const y1 = Math.min(srcSize - 1, Math.ceil((y + 1) * scale));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * srcSize + sx) * 4;
          r += src[i];
          g += src[i + 1];
          b += src[i + 2];
          a += src[i + 3];
          n++;
        }
      }
      const i = (y * dstSize + x) * 4;
      dst[i] = Math.round(r / n);
      dst[i + 1] = Math.round(g / n);
      dst[i + 2] = Math.round(b / n);
      dst[i + 3] = Math.round(a / n);
    }
  }
  return dst;
}

// ---------- ICO 打包（PNG-in-ICO，Windows Vista+ 支持） ----------
function encodeICO(pngs) {
  // pngs: [{ size, data }] — data 为已编码的 PNG Buffer
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 = 256)
    e.writeUInt8(size >= 256 ? 0 : size, 1); // height
    e.writeUInt8(0, 2); // color count
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bit count
    e.writeUInt32LE(data.length, 8); // bytes in resource
    e.writeUInt32LE(offset, 12); // image offset
    entries.push(e);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

const png256 = encodePNG(SIZE, SIZE, buf);
const png48 = encodePNG(48, 48, downscale(buf, SIZE, 48));
const png32 = encodePNG(32, 32, downscale(buf, SIZE, 32));
const png16 = encodePNG(16, 16, downscale(buf, SIZE, 16));

// ---------- 托盘状态角标变体（32x32） ----------
function blendPixel(b, size, x, y, r, g, bl, a) {
  if (x < 0 || y < 0 || x >= size || y >= size || a <= 0) return;
  const i = (y * size + x) * 4;
  const sa = a / 255;
  const da = b[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return;
  b[i] = Math.round((r * sa + b[i] * da * (1 - sa)) / oa);
  b[i + 1] = Math.round((g * sa + b[i + 1] * da * (1 - sa)) / oa);
  b[i + 2] = Math.round((bl * sa + b[i + 2] * da * (1 - sa)) / oa);
  b[i + 3] = Math.round(oa * 255);
}

function badgeCircle(b, size, color, r = 8) {
  const cx = size - r - 1;
  const cy = size - r - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - r;
      const a = Math.max(0, Math.min(1, 0.5 - d));
      if (a > 0) blendPixel(b, size, x, y, color[0], color[1], color[2], Math.round(a * 255));
    }
  }
}

function grayify(b, size) {
  for (let i = 0; i < b.length; i += 4) {
    if (b[i + 3] === 0) continue;
    const g = Math.round(b[i] * 0.299 + b[i + 1] * 0.587 + b[i + 2] * 0.114);
    b[i] = Math.round(g * 0.85);
    b[i + 1] = Math.round(g * 0.85);
    b[i + 2] = Math.round(g * 0.85);
  }
}

const trayBase = downscale(buf, SIZE, 32);
const trayOnline = Buffer.from(trayBase);
const trayError = Buffer.from(trayBase);
const trayOffline = Buffer.from(trayBase);
badgeCircle(trayOnline, 32, [0x22, 0xc5, 0x5e]); // 绿点：在线
badgeCircle(trayError, 32, [0xef, 0x44, 0x44]); // 红点：出错
grayify(trayOffline, 32); // 灰化：服务不在线/端口被占用

fs.writeFileSync(path.join(ASSETS, "icon.png"), png256);
fs.writeFileSync(path.join(ASSETS, "tray.png"), png32);
fs.writeFileSync(path.join(ASSETS, "tray-online.png"), encodePNG(32, 32, trayOnline));
fs.writeFileSync(path.join(ASSETS, "tray-error.png"), encodePNG(32, 32, trayError));
fs.writeFileSync(path.join(ASSETS, "tray-offline.png"), encodePNG(32, 32, trayOffline));
fs.writeFileSync(
  path.join(ASSETS, "icon.ico"),
  encodeICO([
    { size: 16, data: png16 },
    { size: 32, data: png32 },
    { size: 48, data: png48 },
    { size: 256, data: png256 },
  ])
);
console.log("图标已生成:", ASSETS);
