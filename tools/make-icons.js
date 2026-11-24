'use strict';
// Génère les icônes d'écran d'accueil (76 et 152 px) : jauge cyan sur fond marine, marine et cyan.
const zlib = require('zlib'), fs = require('fs'), path = require('path');
function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function png(size) {
  const S = 4, N = size * S, px = Buffer.alloc(size * size * 4);
  const bg = [10, 31, 68], cyan = [0, 196, 217], pink = [255, 79, 154], track = [25, 52, 98];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const acc = [0, 0, 0];
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const u = (x * S + sx + 0.5) / N - 0.5, v = (y * S + sy + 0.5) / N - 0.5;
      let c = bg;
      const r = Math.sqrt(u * u + (v - 0.04) * (v - 0.04));
      let a = Math.atan2(v - 0.04, u) * 180 / Math.PI; if (a < 0) a += 360;
      const inArc = a >= 135 || a <= 45;          // arc de 270° ouvert en bas
      const pos = a >= 135 ? a - 135 : a + 225;     // 0..270
      if (r > 0.27 && r < 0.36 && inArc) c = pos < 190 ? cyan : track;
      if (r < 0.07) c = pink;
      // aiguille vers 190°
      const ang = (135 + 190) * Math.PI / 180, nx = Math.cos(ang), ny = Math.sin(ang);
      const t = u * nx + (v - 0.04) * ny, d = Math.abs(u * ny - (v - 0.04) * nx);
      if (t > 0 && t < 0.25 && d < 0.022) c = pink;
      acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2];
    }
    const i = (y * size + x) * 4;
    px[i] = acc[0] / (S * S); px[i + 1] = acc[1] / (S * S); px[i + 2] = acc[2] / (S * S); px[i + 3] = 255;
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
[76, 152].forEach(function (s) { fs.writeFileSync(path.join(__dirname, '..', 'public', 'icon-' + s + '.png'), png(s)); });
console.log('icônes générées');
