/* zip.js — minimal ZIP writer (store / no compression), UTF-8 filenames, no dependencies. */
'use strict';

var CRC_TABLE = (function () {
  var t = new Uint32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  var c = 0xFFFFFFFF;
  for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function u16(dv, off, v) { dv.setUint16(off, v, true); }
function u32(dv, off, v) { dv.setUint32(off, v >>> 0, true); }

function dosTime(d) {
  return ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31);
}
function dosDate(d) {
  return (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
}

export function makeZip(entries) {
  var enc = new TextEncoder();
  var localParts = [], centralParts = [], offset = 0, count = 0;
  var d = new Date(), tm = dosTime(d), dt = dosDate(d);

  entries.forEach(function (e) {
    if (!e || !e.name) return;
    var name = enc.encode(e.name);
    var data = (e.data instanceof Uint8Array) ? e.data : enc.encode(String(e.data == null ? '' : e.data));
    var crc = crc32(data);

    var lh = new Uint8Array(30 + name.length);
    var lv = new DataView(lh.buffer);
    u32(lv, 0, 0x04034B50);
    u16(lv, 4, 20);            // version needed
    u16(lv, 6, 0x0800);        // UTF-8 filename flag
    u16(lv, 8, 0);             // stored
    u16(lv, 10, tm); u16(lv, 12, dt);
    u32(lv, 14, crc);
    u32(lv, 18, data.length);
    u32(lv, 22, data.length);
    u16(lv, 26, name.length);
    u16(lv, 28, 0);
    lh.set(name, 30);
    localParts.push(lh, data);

    var ch = new Uint8Array(46 + name.length);
    var cv = new DataView(ch.buffer);
    u32(cv, 0, 0x02014B50);
    u16(cv, 4, 20); u16(cv, 6, 20);
    u16(cv, 8, 0x0800);
    u16(cv, 10, 0);
    u16(cv, 12, tm); u16(cv, 14, dt);
    u32(cv, 16, crc);
    u32(cv, 20, data.length);
    u32(cv, 24, data.length);
    u16(cv, 28, name.length);
    u16(cv, 30, 0); u16(cv, 32, 0);
    u16(cv, 34, 0); u16(cv, 36, 0);
    u32(cv, 38, 0);
    u32(cv, 42, offset);
    ch.set(name, 46);
    centralParts.push(ch);

    offset += lh.length + data.length;
    count++;
  });

  var cdSize = centralParts.reduce(function (a, b) { return a + b.length; }, 0);
  var eocd = new Uint8Array(22);
  var ev = new DataView(eocd.buffer);
  u32(ev, 0, 0x06054B50);
  u16(ev, 4, 0); u16(ev, 6, 0);
  u16(ev, 8, count); u16(ev, 10, count);
  u32(ev, 12, cdSize);
  u32(ev, 16, offset);
  u16(ev, 20, 0);

  var all = localParts.concat(centralParts, [eocd]);
  var total = all.reduce(function (a, b) { return a + b.length; }, 0);
  var out = new Uint8Array(total), pos = 0;
  all.forEach(function (p) { out.set(p, pos); pos += p.length; });
  return out;
}

export function bytesToBase64(bytes) {
  var chunk = 0x8000, s = '';
  for (var i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(s);
}

export function utf8(str) { return new TextEncoder().encode(str); }
