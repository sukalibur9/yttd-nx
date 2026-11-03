// ============================================================================
// Your Turn To Die -Death Game By Majority-  |  nx.js Switch loader
// Boots the RPG Maker MV web build inside the nx.js homebrew runtime.
//
// Strategy:
//  - Game files are mirrored 1:1 from the web deployment into romfs/
//    (romfs:/3/..., romfs:/audio/..., romfs:/fonts/...), so every relative
//    URL the game uses resolves without rewriting.
//  - A minimal `document` / `XMLHttpRequest` shim covers what MV needs.
//  - Forced 2D canvas renderer (nx.js only offers WebGL2, MV's Pixi v4 wants
//    WebGL1) via `?canvas`, then the game canvas is blitted letterboxed to
//    the 1280x720 Switch screen every frame.
// ============================================================================

/* global screen, OffscreenCanvas, FontFace, fonts, fetch, Image, URL,
   TextDecoder, localStorage, navigator, console */

const TAG = '[yttd]';
const T0 = Date.now();
const ts = () => ((Date.now() - T0) / 1000).toFixed(1) + 's';

// --- Game assets: SD card ZIP (no extraction), not romfs ----------------------
const ASSETS_BASE = 'sdmc:/switch/yourturntodie/assets';
function gameUrl(url) {
  url = String(url == null ? '' : url);
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) || url.startsWith('blob:') || url.startsWith('data:')) return url;
  return ASSETS_BASE + '/' + url.replace(/^\.\//, '').replace(/^\/+/, '');
}

// --- ZIP-backed game assets -------------------------------------------------
// The game ships either as the official vgperson ZIP (YourTurnToDie.zip,
// standard MV layout under www/ with .rpgmvp-encrypted images) or as the
// earlier custom your-turn-to-die-assets.zip (site layout under assets/3/).
// Both live at sdmc:/switch/yourturntodie/ — no extraction needed.
// Files are read on demand: central directory -> local header -> inflate.
const ZIP_PATHS = [
  'sdmc:/switch/yourturntodie/YourTurnToDie.zip',
  'sdmc:/switch/yourturntodie/your-turn-to-die-assets.zip',
];
let ZIP_PATH = ZIP_PATHS[0];
const ZIP_URL_PREFIX = 'sdmc:/switch/yourturntodie/'; // entry name = path minus this
let zipEntries = null;

function zipDv(u8) { return new DataView(u8.buffer, u8.byteOffset, u8.byteLength); }
function zipReadRange(start, end) {
  const ab = Switch.readFileSync(ZIP_PATH, { start, end });
  return ab ? new Uint8Array(ab) : null;
}
async function zipOpen() {
  let size = 0;
  for (const candidate of ZIP_PATHS) {
    try {
      const st = Switch.statSync(candidate);
      if (st && Number(st.size) > 0) { ZIP_PATH = candidate; size = Number(st.size); break; }
    } catch (e) { /* try next */ }
  }
  if (!size) return false;
  const tailSize = Math.min(65558, size);
  const tail = zipReadRange(size - tailSize, size);
  if (!tail) return false;
  const t = zipDv(tail);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (t.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return false;
  const cdCount = t.getUint16(eocd + 10, true);
  const cdSize = t.getUint32(eocd + 12, true);
  const cdOff = t.getUint32(eocd + 16, true);
  const cd = zipReadRange(cdOff, cdOff + cdSize);
  if (!cd) return false;
  const c = zipDv(cd);
  const dec = new TextDecoder();
  zipEntries = new Map();
  let p = 0;
  for (let n = 0; n < cdCount; n++) {
    if (c.getUint32(p, true) !== 0x02014b50) break;
    const method = c.getUint16(p + 10, true);
    const compSize = c.getUint32(p + 20, true);
    const localOff = c.getUint32(p + 42, true);
    const nameLen = c.getUint16(p + 28, true);
    const extraLen = c.getUint16(p + 30, true);
    const commentLen = c.getUint16(p + 32, true);
    const name = dec.decode(cd.subarray(p + 46, p + 46 + nameLen));
    if (!name.endsWith('/')) zipEntries.set(name, { offset: localOff, compSize, method });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return zipEntries.size > 0;
}
async function zipInflateRaw(u8) {
  const ds = new DecompressionStream('deflate-raw');
  const w = ds.writable.getWriter();
  const r = ds.readable.getReader();
  const wp = w.write(u8).then(() => w.close());
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    chunks.push(value); total += value.byteLength;
  }
  await wp;
  const out = new Uint8Array(total);
  let o = 0;
  for (const ch of chunks) { out.set(ch, o); o += ch.byteLength; }
  return out;
}
async function zipRead(name) {
  const e = zipEntries.get(name);
  if (!e) return null;
  const lh = zipReadRange(e.offset, e.offset + 30);
  if (!lh || zipDv(lh).getUint32(0, true) !== 0x04034b50) return null;
  const d = zipDv(lh);
  const dataOff = e.offset + 30 + d.getUint16(26, true) + d.getUint16(28, true);
  const comp = zipReadRange(dataOff, dataOff + e.compSize);
  if (!comp || comp.byteLength !== e.compSize) return null;
  if (e.method === 0) return comp;
  if (e.method === 8) { try { return await zipInflateRaw(comp); } catch (err) { return null; } }
  return null;
}

// Resolve one game path to ZIP entry candidates, in order:
//  1. legacy custom ZIP layout ('assets/3/...')
//  2. bare path ('3/...', 'img/...', ...)
//  3. official ZIP layout ('www/...' — '3/js/x' -> 'www/js/x',
//     'game/3/js/x' -> 'www/js/x', 'img/x' -> 'www/img/x')
//  4. same as (3) with .png -> .rpgmvp (official ZIP encrypts images).
function zipCandidates(entryName) {
  let p = entryName;
  if (p.startsWith('assets/')) p = p.slice('assets/'.length);
  // The CTE uses 'languages/X' but the real path is '3/languages/X'.
  if (p.startsWith('languages/')) p = '3/' + p;
  const out = [];
  const push = (c) => { if (c && !out.includes(c)) out.push(c); };
  push('assets/' + p);
  push(p);
  let wwwP;
  if (p.startsWith('3/')) wwwP = 'www/' + p.slice(2);
  else if (p.startsWith('game/3/')) wwwP = 'www/' + p.slice(7);
  else wwwP = 'www/' + p;
  push(wwwP);
  if (/\.png$/i.test(wwwP)) push(wwwP.replace(/\.png$/i, '.rpgmvp'));
  return out;
}

async function zipReadAny(entryName) {
  for (const cand of zipCandidates(entryName)) {
    const data = await zipRead(cand);
    if (data) return { data, entry: cand };
  }
  return null;
}

// MV .rpgmvp decryption (mirrors rpg_core Decrypter.decryptArrayBuffer):
// 16-byte header (RPGMV signature) stripped, first 16 data bytes XORed with
// the encryption key bytes from System.json.
let _encKeyPromise = null;
async function encryptionKey() {
  if (!_encKeyPromise) {
    _encKeyPromise = (async () => {
      try {
        const res = await globalThis.fetch(gameUrl('3/data/System.json'));
        if (!res.ok) return null;
        const sys = await res.json();
        return sys && sys.encryptionKey ? String(sys.encryptionKey) : null;
      } catch (e) { return null; }
    })();
  }
  return _encKeyPromise;
}

function decryptRpgmvp(u8, keyHex) {
  if (!u8 || u8.length <= 16 || !keyHex) return u8;
  const keyBytes = [];
  for (let i = 0; i + 2 <= keyHex.length; i += 2) keyBytes.push(parseInt(keyHex.substr(i, 2), 16));
  if (keyBytes.length < 16) return u8;
  const out = u8.slice(16);
  for (let i = 0; i < 16 && i < out.length; i++) out[i] ^= keyBytes[i];
  return out;
}
// CRC-32 (IEEE) table for PNG chunk CRCs.
const _crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function _crc32(bytes, start, len) {
  let c = 0xFFFFFFFF;
  for (let i = start; i < start + len; i++) c = _crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
// Paletted PNGs whose fully-transparent palette entries carry non-zero RGB
// render visibly on Switch: the decoded straight-alpha pixels are treated
// as premultiplied somewhere in the nx.js/Skia chain, so (RGB, alpha=0)
// adds RGB to the backdrop instead of nothing (455 of 3091 pictures have
// this pattern; Mishima's cara12 files use a green (71,112,76) for the
// transparent index, which is why only he showed a light-teal panel,
// while other characters' transparent entries are already (0,0,0) and
// stay invisible). Zero the RGB of every fully-transparent palette entry
// (PLTE CRC recomputed): fully-transparent pixels then stay invisible
// under either interpretation, and no visible pixel changes, since only
// alpha=0 entries are touched. Returns null when nothing needs changing.
function fixPngPaletteTransparency(u8) {
  try {
    if (!u8 || u8.length < 33) return null;
    if (u8[0] !== 0x89 || u8[1] !== 0x50 || u8[2] !== 0x4E || u8[3] !== 0x47) return null;
    if (u8[25] !== 3) return null; // palette color type only
    let off = 8, plteOff = -1, plteLen = 0, trns = null;
    while (off + 8 <= u8.length) {
      const len = (u8[off] << 24) | (u8[off + 1] << 16) | (u8[off + 2] << 8) | u8[off + 3];
      const type = String.fromCharCode(u8[off + 4], u8[off + 5], u8[off + 6], u8[off + 7]);
      if (type === 'PLTE') { plteOff = off + 8; plteLen = len; }
      else if (type === 'tRNS') { trns = u8.slice(off + 8, off + 8 + len); }
      else if (type === 'IDAT' || type === 'IEND') break;
      off += 12 + len;
    }
    if (plteOff < 0 || !trns) return null;
    let dirty = false;
    for (let i = 0; i < trns.length; i++) {
      if (trns[i] === 0) {
        const p = plteOff + i * 3;
        if (p + 2 < plteOff + plteLen && (u8[p] !== 0 || u8[p + 1] !== 0 || u8[p + 2] !== 0)) dirty = true;
      }
    }
    if (!dirty) return null;
    const out = u8.slice();
    for (let i = 0; i < trns.length; i++) {
      if (trns[i] === 0) {
        const p = plteOff + i * 3;
        if (p + 2 < plteOff + plteLen) { out[p] = 0; out[p + 1] = 0; out[p + 2] = 0; }
      }
    }
    const crc = _crc32(out, plteOff - 4, 4 + plteLen);
    const crcOff = plteOff + plteLen;
    out[crcOff] = (crc >>> 24) & 0xFF; out[crcOff + 1] = (crc >>> 16) & 0xFF;
    out[crcOff + 2] = (crc >>> 8) & 0xFF; out[crcOff + 3] = crc & 0xFF;
    return out;
  } catch (e) { return null; }
}
// percent-encoded paths (e.g. spaces in filenames, which fopen can't open
// as %20) resolve correctly. Asset URLs are served from the ZIP when open.
// Everything else goes to the real fetch.
// RAM cache of audio file bytes (see fetch wrapper). Map<rawPath, ArrayBuffer>.
const _audioCache = new Map();

// 0.1s of silent Ogg Vorbis, served in place of any missing audio file so
// a missing sound can never fail a load. Decoded once, lazily.
let _silentOggBuf = null;
function silentOgg() {
  if (!_silentOggBuf) {
    const bin = atob(SILENT_OGG_B64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    _silentOggBuf = bytes.buffer;
  }
  return _silentOggBuf;
}
const SILENT_OGG_B64 =
  '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';

const _realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = function (input, init) {
  let href = null;
  try {
    href = typeof input === 'string' ? input : (input && input.url ? String(input.url) : null);
  } catch (e) { /* fall through to real fetch */ }
  if (href && /^(sdmc|romfs):/i.test(href)) {
    return (async () => {
      try {
        const u = new URL(href);
        const rawPath = u.protocol.slice(0, -1) + ':' + decodeURIComponent(u.pathname);
        // RAM cache for audio: dialogue blips re-fetch the same tiny SE on
        // every character; each fetch is a synchronous SD read on the main
        // thread, which is both slow and a freeze risk. Cache the bytes.
        const isAudio = /\/audio\/[^/]+\/[^/]+\.ogg$/i.test(rawPath);
        if (isAudio && _audioCache.has(rawPath)) {
          return new Response(_audioCache.get(rawPath).slice(0), { status: 200 });
        }
        if (zipEntries && rawPath.startsWith(ZIP_URL_PREFIX)) {
          let entryName = rawPath.slice(ZIP_URL_PREFIX.length);
          const hit = await zipReadAny(entryName);
          let data = hit ? hit.data : null;
          if (data) {
            // Direct image loads (NxImage, non-Bitmap paths) ask for .png
            // but the official ZIP only has the encrypted .rpgmvp: decrypt
            // it here. The Decrypter path asks for .rpgmvp itself and must
            // get the RAW bytes (it decrypts them itself), so never
            // decrypt when the request already ended in .rpgmvp.
            if (hit.entry.endsWith('.rpgmvp') && /\.png$/i.test(rawPath)) {
              try {
                const key = await encryptionKey();
                if (key) data = decryptRpgmvp(data, key);
              } catch (e) {}
              try {
                const fixed = fixPngPaletteTransparency(data);
                if (fixed) data = fixed;
              } catch (e) {}
            }
            if (isAudio && data.byteLength <= 2 * 1024 * 1024) _audioCache.set(rawPath, data);
            return new Response(data, { status: 200 });
          }
          // fall through to loose files on SD (lets users override zip content)
        }
        const data = Switch.readFileSync(rawPath);
        if (data) {
          let outData = data;
          if (/\.png$/i.test(rawPath)) {
            try {
              const fixed = fixPngPaletteTransparency(outData);
              if (fixed) outData = fixed;
            } catch (e) {}
          }
          if (isAudio && data.byteLength <= 2 * 1024 * 1024) _audioCache.set(rawPath, data);
          return new Response(outData, { status: 200 });
        }
        // Missing audio must never fail the load (a missing SE froze the
        // game via the ResourceHandler stop path): serve 0.1s of silence.
        if (/\/audio\/[^/]+\/[^/]+\.ogg$/i.test(rawPath)) {
          try { log('AUDIO FALLBACK (silent):', rawPath); } catch (e) {}
          return new Response(silentOgg(), { status: 200 });
        }
      } catch (e) { /* fall through to 404 */ }
      return new Response(null, { status: 404 });
    })();
  }
  return _realFetch(input, init);
};

// Image: rewrite relative game URLs to the SD-card assets folder
// (nx.js resolves relative <img> URLs against the romfs entrypoint).
// NOTE: nx.js native Image does NOT go through our fetch wrapper, so we
// intercept src sets, fetch via our wrapper (ZIP-aware), and use blob URLs.
const NxImageBase = globalThis.Image;
function NxImage() {
  const img = new NxImageBase();
  // Override src setter on the instance
  let _src = '';
  Object.defineProperty(img, 'src', {
    get() { return _src; },
    set(v) {
      _src = v;
      const abs = gameUrl(v);
      if (/\.(png|jpg|jpeg)$/i.test(abs)) {
        try { log('IMG load:', abs); } catch (e) {}
        // Fetch via our ZIP-aware wrapper, then use blob URL
        (async () => {
          try {
            const resp = await globalThis.fetch(abs);
            if (resp.ok) {
              const blob = await resp.blob();
              const blobUrl = URL.createObjectURL(blob);
              // Free the compressed copy once decoded (native heap is tight).
              const revoke = () => { try { URL.revokeObjectURL(blobUrl); } catch (e) {} };
              img.addEventListener('load', revoke);
              img.addEventListener('error', revoke);
              // Set the underlying src directly (bypass our override)
              Object.getOwnPropertyDescriptor(NxImageBase.prototype, 'src').set.call(img, blobUrl);
            } else {
              // Fallback: try direct (will 404, triggering error handler)
              Object.getOwnPropertyDescriptor(NxImageBase.prototype, 'src').set.call(img, abs);
            }
          } catch (e) {
            Object.getOwnPropertyDescriptor(NxImageBase.prototype, 'src').set.call(img, abs);
          }
        })();
      } else {
        Object.getOwnPropertyDescriptor(NxImageBase.prototype, 'src').set.call(img, abs);
      }
    },
    configurable: true
  });
  return img;
}
globalThis.Image = NxImage;

// Audio: nx.js createPanner() throws "Method not implemented", which MV's
// WebAudio hits for every sound; the resulting unhandled rejection halts the
// app ("Press + to exit") and kills input. Fall back to a GainNode (MV only
// connects through it and calls setPosition for pan).
try {
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (AC && AC.prototype && typeof AC.prototype.createPanner === 'function') {
    const origCreatePanner = AC.prototype.createPanner;
    AC.prototype.createPanner = function () {
      try { return origCreatePanner.call(this); } catch (e) {
        const g = this.createGain();
        g.setPosition = function () {};
        g.setOrientation = function () {};
        return g;
      }
    };
  }
} catch (e) { /* non-fatal */ }

// Input diagnostics: log gamepad button presses / stick moves (edge-triggered)
// so hardware tests prove whether pad input reaches JS at all.
try {
  let prevButtons = [];
  let prevAxes = [];
  setInterval(() => {
    try {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      const gp = pads && pads[0];
      if (!gp) return;
      const btns = Array.prototype.map.call(gp.buttons || [], b => (b && b.pressed) ? 1 : 0);
      for (let i = 0; i < btns.length; i++) {
        if (btns[i] && !prevButtons[i]) {
          try { log('PAD button pressed: index', i); } catch (e) {}
        }
      }
      prevButtons = btns;
      const axes = gp.axes || [];
      for (let i = 0; i < axes.length; i++) {
        const v = axes[i] || 0;
        const pv = prevAxes[i] || 0;
        if (Math.abs(v) > 0.6 && Math.abs(pv) <= 0.6) {
          try { log('PAD axis move: index', i, 'value', v.toFixed(2)); } catch (e) {}
        }
      }
      prevAxes = Array.prototype.slice.call(axes);
    } catch (e) { /* non-fatal */ }
  }, 200);
} catch (e) { /* non-fatal */ }

// --- debug config: config.txt in the game folder ----------------------------
// Generated on first run if missing (sdmc:/switch/yourturntodie/config.txt;
// also read from sdmc:/switch/config.txt as a fallback for files created by
// earlier builds). Format (comments start with #):
//   debug=0  -> debug.log OFF (default): no debug.log file is written.
//   debug=1  -> debug.log ON: file logging as before.
// Boot-screen texts always show regardless of this setting.
// A bare "0"/"1" line is also accepted. Missing/unparseable = off.
const CONFIG_PATHS = ['sdmc:/switch/yourturntodie/config.txt', 'sdmc:/switch/config.txt'];
const CONFIG_DEFAULT = '# YTTD Switch config\n# debug.log: 0 = off (default), 1 = on\ndebug=0\n';
let DEBUG_ENABLED = false;
try {
  if (typeof Switch !== 'undefined') {
    let cfgText = null, cfgFound = false;
    for (const p of CONFIG_PATHS) {
      try {
        const st = Switch.statSync(p);
        if (st && Number(st.size) >= 0) {
          cfgFound = true;
          try {
            const d = Switch.readFileSync(p);
            if (d) cfgText = (typeof d === 'string') ? d : new TextDecoder().decode(d);
          } catch (e) { /* unreadable: keep file, stay off */ }
          break;
        }
      } catch (e) { /* not present: try next */ }
    }
    if (!cfgFound) {
      try { Switch.mkdirSync('sdmc:/switch/yourturntodie'); } catch (e) { /* ignore */ }
      try { Switch.writeFileSync(CONFIG_PATHS[0], CONFIG_DEFAULT); } catch (e) { /* ignore */ }
    } else if (cfgText) {
      const m = cfgText.match(/^\s*debug\s*=\s*([01])\s*$/m) || cfgText.match(/^\s*([01])\s*$/m);
      DEBUG_ENABLED = !!m && m[1] === '1';
    }
  }
} catch (e) { DEBUG_ENABLED = false; }

// Loader build number: bump on every NRO upload, printed at boot so any
// debug.log identifies exactly which build produced it.
const LOADER_BUILD = 50;
// --- file debug log: sdmc:/switch/yourturntodie/debug.log --------------------
// Only created when debug=1 in config.txt (see above).
const DEBUG_LOG = 'sdmc:/switch/yourturntodie/debug.log';
let fileLogOk = false;
try {
  if (typeof Switch !== 'undefined' && DEBUG_ENABLED) {
    Switch.mkdirSync('sdmc:/switch/yourturntodie');
    Switch.writeFileSync(DEBUG_LOG, '=== YTTD Switch debug.log === (loader build ' + LOADER_BUILD + ')\n');
    fileLogOk = true;
  }
} catch (e) { fileLogOk = false; }
// Buffered file logging: synchronous SD writes on the main thread are a
// freeze risk (a wedged FS call blocks the whole game), and gameplay can
// produce many lines per second. Buffer in RAM, flush at most every 4s.
const _fLogBuf = [];
let _fLogTimer = null;
function _fLogFlush() {
  if (!fileLogOk || _fLogBuf.length === 0) return;
  const chunk = _fLogBuf.splice(0, _fLogBuf.length).join('');
  try { Switch.appendFileSync(DEBUG_LOG, chunk); }
  catch (e) { /* transient SD errors must not silence logging for good */ }
}
function fLog(line) {
  if (!fileLogOk) return;
  _fLogBuf.push('[' + ts() + '] ' + line + '\n');
  if (_fLogBuf.length >= 200) _fLogFlush();
  if (!_fLogTimer) {
    _fLogTimer = setInterval(_fLogFlush, 15000);
  }
}
// Mirror every console.log/error into the file as well, and draw errors on
// the boot screen so they are visible even when only the screen is seen.
const _conLog = console.log.bind(console);
const _conErr = console.error.bind(console);
console.log = (...a) => { if (DEBUG_ENABLED) _conLog(...a); fLog(a.map(String).join(' ')); };
console.error = (...a) => {
  _conErr(...a);
  const msg = a.map(String).join(' ');
  fLog('[ERR] ' + msg);
  try { drawBootLine(msg, true); } catch (e) { /* boot screen not ready */ }
};

const log = (...a) => console.log(TAG, ...a);
const logErr = (...a) => console.error(TAG, ...a);

// --- on-screen boot log (visible on hardware even if console isn't) ---------
const bootCtx = screen.getContext('2d');
let bootLine = 0;
// True until the game renders its first frame. Boot/error lines are drawn
// on screen only during boot: once the game is rendering, an error line
// drawn over a frozen frame would otherwise persist as a red overlay
// artifact at the bottom of the screen (bootLine already past the top).
let bootPhase = true;
function drawBootLine(msg, isErr) {
  if (!bootPhase) return;
  try {
    bootCtx.fillStyle = '#000';
    if (bootLine === 0) bootCtx.fillRect(0, 0, 1280, 720);
    bootCtx.fillStyle = isErr ? '#f66' : '#8f8';
    bootCtx.font = '20px monospace';
    bootCtx.fillText(String(msg).split('\n')[0].slice(0, 90), 24, 40 + bootLine * 26);
    bootLine++;
  } catch (e) { /* ignore (boot screen not ready yet) */ }
}
function bootLog(msg, isErr) {
  drawBootLine(msg, isErr);
  const line = TAG + ' ' + msg;
  if (isErr) { _conErr(line); fLog('[ERR] ' + line); }
  else { _conLog(line); fLog(line); }
}
globalThis.addEventListener('error', (e) => {
  bootLog('ERROR: ' + (e && (e.message || e.error)), true);
});
globalThis.addEventListener('unhandledrejection', (e) => {
  bootLog('REJECTED: ' + (e && e.reason && (e.reason.stack || e.reason.message || e.reason)), true);
});

// ---------------------------------------------------------------------------
// 0. Environment
// ---------------------------------------------------------------------------
// Force MV canvas renderer: SceneManager.preferableRendererType() returns
// 'canvas' when Utils.isOptionValid('canvas'), which reads location.search.
globalThis.location = {
  href: 'romfs:/main.js', protocol: 'romfs:', host: '',
  pathname: '/main.js', search: '?canvas', hash: '',
};
globalThis.innerWidth = 1280;
globalThis.innerHeight = 720;
// Never let anything believe we're running under NW.js/Electron.
delete globalThis.require;
delete globalThis.process;
delete globalThis.nw;
// Stub for iphone-inline-video (its lib isn't loaded; this game has no movies,
// and Graphics._createVideo() calls it unconditionally at boot).
globalThis.makeVideoPlayableInline = () => {};
// --- Globals from the web build's index.html inline <script> ---
// (must exist before any game script evaluates)
globalThis.$useStoragePrefix = true;
globalThis.$useDataFolder = true;
globalThis.$dataFolder = '3/';
globalThis.CTE_getLanguagesFolder = function () { return '3/languages/'; };

// ---------------------------------------------------------------------------
// 1. Minimal `document` shim
// ---------------------------------------------------------------------------
const docListeners = Object.create(null);
function nxDocOn(type, fn) {
  (docListeners[type] = docListeners[type] || []).push(fn);
}
function nxDocOff(type, fn) {
  const a = docListeners[type];
  if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
}

// Ordered <script async=false> queue (mirrors browser execution order).
let scriptChain = Promise.resolve();
function nxFetchText(url) {
  const abs = gameUrl(url);
  return fetch(abs).then((res) => {
    if (!res.ok) throw new Error('HTTP ' + res.status + ' <- ' + abs);
    return res.text();
  });
}
function nxLoadScriptFile(url) {
  // Used for core scripts: any failure is fatal.
  return nxFetchText(url).then((code) => { (0, eval)(code); });
}
function nxDrainScripts() { return scriptChain; }

function makeScriptElement() {
  return {
    __nxScript: true,
    type: '', src: '', async: true, _url: '',
    onload: null, onerror: null,
    style: {},
    setAttribute() {},
    addEventListener(t, fn) { this['on' + t] = fn; },
    removeEventListener() {},
  };
}
function nxAppendChild(el) {
  if (el && el.__nxScript) {
    const url = el.src || '';
    // Mirror browser semantics: a fetch failure fires onerror (and later
    // aborts boot via PluginManager.checkPluginErrors), but an exception
    // *inside* the script only goes to the error log - later scripts still run.
    const run = () => nxFetchText(url).then(
      (code) => {
        try { (0, eval)(code); }
        catch (e) { bootLog('script eval threw: ' + url + ' :: ' + (e && e.message), true); }
        if (typeof el.onload === 'function') el.onload({ target: el });
      },
      (e) => {
        bootLog('script fetch failed: ' + url + ' :: ' + (e && e.message), true);
        if (typeof el.onerror === 'function') el.onerror({ target: el });
      });
    if (el.async === false) scriptChain = scriptChain.then(run);
    else run();
  }
  return el;
}

function makeFakeCanvas(w, h) {
  const c = new OffscreenCanvas(w || 816, h || 624);
  c.style = {};
  c.id = '';
  c.className = '';
  c.offsetLeft = 0;
  c.offsetTop = 0;
  c.addEventListener = () => {};
  c.removeEventListener = () => {};
  c.setAttribute = () => {};
  c.getAttribute = () => null;
  return c;
}
function makeGenericElement() {
  return {
    style: {}, innerHTML: '', textContent: '',
    width: 0, height: 0,
    appendChild(c) { return c; },
    addEventListener() {}, removeEventListener() {},
    setAttribute() {}, getAttribute() { return null; },
    play() {}, pause() {}, load() {},
  };
}

const fakeBody = {
  appendChild: nxAppendChild,
  removeChild(c) { return c; },
  getElementsByTagName() { return []; },
  style: {},
};

globalThis.document = {
  createElement(tag) {
    const t = String(tag).toLowerCase();
    if (t === 'canvas') return makeFakeCanvas();
    if (t === 'img') return new Image();
    if (t === 'audio') {
      const a = makeGenericElement();
      a.canPlayType = (mime) => (String(mime).indexOf('ogg') >= 0 ? 'probably' : '');
      return a;
    }
    if (t === 'script') return makeScriptElement();
    if (t === 'video') return makeGenericElement();
    return makeGenericElement();
  },
  createTextNode() { return { textContent: '' }; },
  getElementsByTagName() { return []; },
  getElementById() { return null; },
  body: fakeBody,
  head: { style: {} },
  documentElement: { style: {} },
  title: 'Your Turn To Die',
  hidden: false,
  addEventListener: nxDocOn,
  removeEventListener: nxDocOff,
};

// ---------------------------------------------------------------------------
// 2. XMLHttpRequest shim (async via fetch; sync via preloaded cache)
// ---------------------------------------------------------------------------
const syncCache = Object.create(null);

class NxXMLHttpRequest {
  constructor() {
    this._method = 'GET';
    this._url = '';
    this._async = true;
    this.responseType = '';
    this.responseText = '';
    this.response = null;
    this.status = 0;
    this.readyState = 0;
    this.onload = null;
    this.onerror = null;
    this.onreadystatechange = null;
  }
  open(method, url, asyncFlag) {
    this._method = String(method || 'GET');
    this._url = String(url);
    this._async = asyncFlag !== false;
    this.readyState = 1;
  }
  overrideMimeType() {}
  setRequestHeader() {}
  get _abs() { return gameUrl(this._url); }
  send() {
    if (this._async) this._sendAsync();
    else this._sendSync();
  }
  _sendAsync() {
    // Diagnostic: trace database/large file loads to pinpoint OOM location.
    const diag = /3\/data\//.test(this._url || '');
    if (diag) log('XHR start:', this._url);
    fetch(this._abs).then(async (res) => {
      this.status = res.status;
      if (!res.ok) throw new Error('HTTP ' + res.status);
      if (this.responseType === 'arraybuffer') {
        this.response = await res.arrayBuffer();
        if (diag) log('XHR done:', this._url, (this.response.byteLength | 0) + 'B');
      } else {
        this.responseText = await res.text();
        this.response = this.responseText;
        if (diag) log('XHR done:', this._url, (this.responseText.length | 0) + ' chars');
      }
      this.readyState = 4;
      if (this.onreadystatechange) this.onreadystatechange();
      if (this.onload) this.onload();
    }).catch((e) => {
      logErr('XHR async failed:', this._url, e && e.message);
      this.status = 0;
      this.readyState = 4;
      if (this.onreadystatechange) this.onreadystatechange();
      if (this.onerror) this.onerror(e);
    });
  }
  _sendSync() {
    // Synchronous XHR cannot use fetch; serve from the preloaded cache.
    const body = syncCache[this._abs];
    if (body !== undefined) {
      this.status = 200;
      if (this.responseType === 'arraybuffer') {
        this.response = body;
      } else {
        this.responseText = typeof body === 'string' ? body : new TextDecoder().decode(body);
        this.response = this.responseText;
      }
    } else {
      this.status = 404;
      bootLog('sync XHR cache MISS: ' + this._url, true);
    }
    this.readyState = 4;
    if (this.onreadystatechange) this.onreadystatechange();
    if (this.status < 400) { if (this.onload) this.onload(); }
    else if (this.onerror) this.onerror();
  }
}
globalThis.XMLHttpRequest = NxXMLHttpRequest;

// ---------------------------------------------------------------------------
// 3. Letterboxed blit: game canvas (816x624) -> Switch screen (1280x720)
// ---------------------------------------------------------------------------
const GW = 816, GH = 624;
const BLIT_S = Math.min(1280 / GW, 720 / GH);
const BLIT_W = GW * BLIT_S, BLIT_H = GH * BLIT_S;
const BLIT_X = (1280 - BLIT_W) / 2, BLIT_Y = (720 - BLIT_H) / 2;
const screenCtx = screen.getContext('2d');

function blitFrame() {
  const G = globalThis.Graphics;
  const c = G && G._canvas;
  if (!c) return;
  bootPhase = false;
  const t0 = Date.now();
  // Keep MV's touch math consistent with our letterbox geometry.
  c.offsetLeft = BLIT_X;
  c.offsetTop = BLIT_Y;
  G._realScale = BLIT_S;
  screenCtx.fillStyle = '#000';
  screenCtx.fillRect(0, 0, 1280, 720);
  try {
    screenCtx.drawImage(c, BLIT_X, BLIT_Y, BLIT_W, BLIT_H);
  } catch (e) {
    bootLog('drawImage failed: ' + (e && e.message), true);
    throw e;
  } finally {
    try { globalThis.__yttdBlitMs = (globalThis.__yttdBlitMs | 0) + (Date.now() - t0); } catch (x) {}
  }
  drawCursor();
}

// ---------------------------------------------------------------------------
// 3b. Stick cursor: left stick moves an on-screen pointer (game coords),
// ZL and ZR click at the pointer by synthesizing a touch event into
// MV's document listeners (same path as real touchscreen taps).
// Confirm input is A only ('ok' via the gamepadMapper; A also fires
// touch-triggered pictures via the build #39 wrapper). ZL/ZR are
// trigger-only: they do NOT act as 'ok'.
// Game coords 816x624; page coords invert MV's pageToCanvas math exactly.
// ---------------------------------------------------------------------------
const cursor = { x: 408, y: 312, clickDown: false };
function cursorPoll() {
  try {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = pads && pads[0];
    if (!gp) return;
    const axes = gp.axes || [];
    const ax = axes[0] || 0, ay = axes[1] || 0;
    const DZ = 0.15, SPEED = 14; // game px per tick at full tilt
    const mx = Math.abs(ax) > DZ ? ax : 0;
    const my = Math.abs(ay) > DZ ? ay : 0;
    cursor.x = Math.max(0, Math.min(GW - 1, cursor.x + mx * SPEED));
    cursor.y = Math.max(0, Math.min(GH - 1, cursor.y + my * SPEED));
    const btns = gp.buttons || [];
    const pressed = (i) => !!(btns[i] && btns[i].pressed);
    // Click = ZL or ZR only (trigger at the cursor position). A is NOT a
    // cursor click: A is confirm ('ok') only. Press = touchstart, release
    // = touchend, mirroring a real finger (hold works for repeated triggers).
    const click = pressed(6) || pressed(7);
    if (click !== cursor.clickDown) {
      cursor.clickDown = click;
      cursor.clickBtn = pressed(6) ? 6 : 7;
      cursorClick(click ? 'touchstart' : 'touchend');
    }
  } catch (e) { /* non-fatal */ }
}
function cursorClick(type) {
  try {
    const handlers = docListeners[type];
    if (!handlers || !handlers.length) return;
    // Inverse of MV pageToCanvas: page = offsetLeft + gameX * realScale.
    const pageX = BLIT_X + cursor.x * BLIT_S;
    const pageY = BLIT_Y + cursor.y * BLIT_S;
    const touch = { pageX, pageY, clientX: pageX, clientY: pageY, identifier: 0 };
    const evt = { touches: type === 'touchend' ? [] : [touch], changedTouches: [touch], preventDefault() {} };
    for (const fn of handlers.slice()) {
      try { fn(evt); } catch (ex) { logErr('cursor touch handler threw:', ex); }
    }
    if (type === 'touchstart') { try { log('CURSOR CLICK btn=' + (cursor.clickBtn !== undefined ? cursor.clickBtn : '?') + ' at game coords:', Math.round(cursor.x) + ',' + Math.round(cursor.y)); } catch (e) {} }
  } catch (e) { /* non-fatal */ }
}
function drawCursor() {
  try {
    const sx = BLIT_X + cursor.x * BLIT_S, sy = BLIT_Y + cursor.y * BLIT_S;
    screenCtx.save();
    screenCtx.beginPath();
    screenCtx.moveTo(sx, sy);
    screenCtx.lineTo(sx, sy + 18);
    screenCtx.lineTo(sx + 5, sy + 14);
    screenCtx.lineTo(sx + 8, sy + 20);
    screenCtx.lineTo(sx + 11, sy + 18);
    screenCtx.lineTo(sx + 8, sy + 13);
    screenCtx.lineTo(sx + 13, sy + 13);
    screenCtx.closePath();
    screenCtx.fillStyle = '#fff';
    screenCtx.fill();
    screenCtx.lineWidth = 2;
    screenCtx.strokeStyle = '#000';
    screenCtx.stroke();
    screenCtx.restore();
  } catch (e) { /* non-fatal */ }
}
// MV maps stick axes beyond 0.5 to directions (12-15) in
// Input._updateGamepadState; replace it with an identical copy minus the
// axes section, so the left stick is exclusive to the cursor. (A previous
// masked-copy approach failed: copying nx.js native gamepad objects can
// throw, which silently fell back to the unmasked path.) Buttons,
// including D-pad, pass through untouched. Idempotent via _yttdStickMasked.
function installStickMask() {
  try {
    const II = globalThis.Input;
    if (II && typeof II._updateGamepadState === 'function' && !II._yttdStickMasked) {
      II._yttdStickMasked = true;
      II._updateGamepadState = function(gamepad) {
        var lastState = this._gamepadStates[gamepad.index] || [];
        var newState = [];
        var buttons = gamepad.buttons;
        newState[12] = false;
        newState[13] = false;
        newState[14] = false;
        newState[15] = false;
        for (var i = 0; i < buttons.length; i++) {
          newState[i] = buttons[i].pressed;
        }
        // Axes deliberately ignored: left stick is exclusive to cursor.
        for (var j = 0; j < newState.length; j++) {
          if (newState[j] !== lastState[j]) {
            var buttonName = this.gamepadMapper[j];
            if (buttonName) {
              this._currentState[buttonName] = newState[j];
            }
          }
        }
        this._gamepadStates[gamepad.index] = newState;
      };
      log('Left stick exclusive to cursor (MV axis directions removed)');
    }
  } catch (x) {}
}

// ---------------------------------------------------------------------------
// 4. Touch forwarding: nx.js screen events -> document listeners (MV TouchInput)
// ---------------------------------------------------------------------------
function nxForwardTouch() {
  const pairs = [
    ['touchstart', 'touchstart'], ['touchmove', 'touchmove'],
    ['touchend', 'touchend'], ['touchcancel', 'touchcancel'],
  ];
  for (const [nxType, docType] of pairs) {
    screen.addEventListener(nxType, (e) => {
      const handlers = docListeners[docType];
      // Diagnostics: prove screen touches arrive at all, and with what
      // coordinates (nx.js native touches may not populate pageX/pageY).
      try {
        const tl = (e.changedTouches && e.changedTouches.length) ? e.changedTouches[0] : null;
        if (nxType === 'touchstart') {
          log('TOUCH fwd:', docType, 'handlers=', handlers ? handlers.length : 0,
            tl ? ('page=' + tl.pageX + ',' + tl.pageY + ' client=' + tl.clientX + ',' + tl.clientY) : '(no touch)');
        }
      } catch (x) {}
      if (!handlers || !handlers.length) return;
      // Fall back through clientX/clientY/x/y: MV only reads pageX/pageY,
      // and a missing pageX makes isInsideCanvas reject the tap silently.
      const mk = (t) => ({
        pageX: (t.pageX !== undefined && t.pageX !== null) ? t.pageX : (t.clientX !== undefined ? t.clientX : (t.x || 0)),
        pageY: (t.pageY !== undefined && t.pageY !== null) ? t.pageY : (t.clientY !== undefined ? t.clientY : (t.y || 0)),
        clientX: t.clientX, clientY: t.clientY,
        identifier: t.identifier,
      });
      // nx.js TouchEvent.touches is a TouchList (array-like, no .map).
      const toArr = (tl) => (tl && typeof tl.length === 'number') ? Array.prototype.slice.call(tl) : [];
      const evt = {
        touches: toArr(e.touches).map(mk),
        changedTouches: toArr(e.changedTouches).map(mk),
        preventDefault() {},
      };
      for (const fn of handlers.slice()) {
        try { fn(evt); } catch (ex) { logErr('touch handler threw:', ex); }
      }
    });
  }
}

// ---------------------------------------------------------------------------
// 5. Boot
// ---------------------------------------------------------------------------
const CORE_SCRIPTS = [
  '3/js/libs/pixi.js',
  '3/js/libs/pixi-tilemap.js',
  '3/js/libs/pixi-picture.js',
  '3/js/libs/fpsmeter.js',
  '3/js/libs/lz-string.js',
  '3/js/rpg_core.js',
  '3/js/rpg_managers.js',
  '3/js/rpg_objects.js',
  '3/js/rpg_scenes.js',
  '3/js/rpg_sprites.js',
  '3/js/rpg_windows.js',
  '3/js/plugins.js',
  '3/js/main.js',
];
// Files loaded through *synchronous* XHR (CTE translation engine); preloaded
// because sync XHR cannot be backed by fetch().
const SYNC_PRELOAD = [
  '3/languages/JP.cte',
  '3/languages/EN.cte',
  '3/languages/TranslatedImages.txt',
  '3/languages/EN.decompressed.json',
];
// The CTE requests 'languages/X' (not '3/languages/X'); alias them.
const SYNC_ALIASES = {
  'languages/JP.cte': '3/languages/JP.cte',
  'languages/EN.cte': '3/languages/EN.cte',
  'languages/TranslatedImages.txt': '3/languages/TranslatedImages.txt',
};

async function boot() {
  bootLog('YTTD Switch loader starting... (build #' + LOADER_BUILD + ')');

  // The game files ship as a ZIP on the SD card (no extraction needed).
  // Fall back to an extracted folder for flexibility.
  let assetSrc = 'zip';
  try {
    if (await zipOpen()) bootLog('assets ZIP opened: ' + zipEntries.size + ' files');
    else { assetSrc = 'folder'; bootLog('assets ZIP not found, trying extracted folder...'); }
  } catch (e) {
    assetSrc = 'folder';
    bootLog('ZIP open failed (' + (e && e.message) + '), trying extracted folder...', true);
  }
  try {
    const probe = await fetch(gameUrl('3/data/System.json'));
    if (!probe.ok) throw new Error('HTTP ' + probe.status);
    bootLog('assets found (' + assetSrc + ') at ' + ASSETS_BASE);
  } catch (e) {
    bootLog('GAME ASSETS NOT FOUND at ' + ASSETS_BASE, true);
    bootLog('put YourTurnToDie.zip in /switch/yourturntodie/', true);
    return;
  }

  // Game font for canvas text.
  try {
    const res = await fetch(gameUrl('fonts/mplus-1m-regular.ttf'));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    fonts.add(new FontFace('GameFont', await res.arrayBuffer()));
    bootLog('font: GameFont registered');
  } catch (e) {
    bootLog('font load failed: ' + (e && e.message), true);
  }

  // Preload sync-XHR files (keyed by gameUrl, matching NxXMLHttpRequest._abs).
  for (const u of SYNC_PRELOAD) {
    const abs = gameUrl(u);
    try {
      const res = await fetch(abs);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      syncCache[abs] = await res.text();
      bootLog('precached: ' + u);
    } catch (e) {
      // JP.cte (base language, absent from the official ZIP) and
      // EN.decompressed.json (only in the legacy custom ZIP) are optional:
      // their absence is expected, not an error, so don't print them red.
      if (u !== '3/languages/JP.cte' && u !== '3/languages/EN.decompressed.json') {
        bootLog('precache failed: ' + u, true);
      }
    }
  }
  // Alias 'languages/X' -> '3/languages/X' for the CTE's path convention.
  for (const [alias, target] of Object.entries(SYNC_ALIASES)) {
    const aliasAbs = gameUrl(alias);
    const targetAbs = gameUrl(target);
    if (syncCache[targetAbs] !== undefined && syncCache[aliasAbs] === undefined) {
      syncCache[aliasAbs] = syncCache[targetAbs];
    }
  }

  nxForwardTouch();

  for (const s of CORE_SCRIPTS) {
    bootLog('loading ' + s);
    await nxLoadScriptFile(s);
  }
  bootLog('core scripts loaded');

  // Post-load patches.
  const G = globalThis.Graphics;
  const I = globalThis.Input;
  if (G && G.render) {
    const origRender = G.render;
    G.render = function (stage) {
      origRender.call(this, stage);
      blitFrame();
    };
    bootLog('render hook installed (canvas 2D -> screen blit)');
    // File access always works here (ZIP on SD); skip the browser probe that
    // assumes a real DOM <script> list (it throws on our empty stub).
    if (globalThis.Utils) Utils.canReadGameFiles = () => true;
    // Harden the error printer: if a future boot error happens before the
    // upper canvas exists, don't let _clearUpperCanvas throw and hide it.
    if (globalThis.Graphics && Graphics._clearUpperCanvas) {
      const origClear = Graphics._clearUpperCanvas;
      Graphics._clearUpperCanvas = function () {
        if (this._upperCanvas) origClear.call(this);
      };
    }
    // The FPSMeter dev overlay throws during construction on nx.js (unknown
    // cause; it works in node with the same fake DOM). It's hidden immediately
    // anyway and every use is guarded by `if (this._fpsMeter)`, so capture the
    // real error for the log and fall back to null.
    if (globalThis.Graphics && Graphics._createFPSMeter) {
      const origFpsMeter = Graphics._createFPSMeter;
      Graphics._createFPSMeter = function () {
        try { origFpsMeter.call(this); }
        catch (e) {
          logErr('FPSMeter disabled:', e && e.message,
            '| ctor:', e && e.constructor && e.constructor.name,
            '| stack:', e && e.stack);
          this._fpsMeter = null;
        }
      };
      bootLog('FPSMeter wrapped (dummy fallback)');
    }
  } else {
    bootLog('Graphics.render not found!', true);
  }
  if (I && I.gamepadMapper) {
    // W3C standard layout on Switch: index 0 = B(bottom), 1 = A(right),
    // 2 = Y(left), 3 = X(top). Map physical A->ok, B->cancel.
    I.gamepadMapper = {
      0: 'cancel', 1: 'ok', 2: 'shift', 3: 'menu',
      4: 'pageup', 5: 'pagedown',
      8: 'menu', 9: 'menu',
      12: 'up', 13: 'down', 14: 'left', 15: 'right',
    };
    bootLog('gamepadMapper fixed for Switch layout');
  }
  // This is a visual novel: no character movement exists, so the left stick
  // is EXCLUSIVE to the stick cursor (see installStickMask in section 3b:
  // MV's axis-to-direction mapping is replaced by an axes-free copy).
  // installStickMask is also called every tick (see the cursor wrapper)
  // so a skipped post-load install can never leave the stick unmasked.
  try { installStickMask(); } catch (x) {}
  // nx.js exits the app when "+" is pressed unless the app prevents the
  // "beforeunload" event it dispatches first (runtime index.ts $.onFrame).
  // The user reported "+" exiting the game instead of acting as a game
  // button, so prevent the exit and let "+" reach the game as 'menu'.
  try {
    globalThis.addEventListener('beforeunload', (e) => { e.preventDefault(); });
    bootLog('beforeunload prevented: "+" no longer exits the app');
  } catch (x) {}

  // Wait for plugin <script async=false> queue, then start the game.
  // (main.js called PluginManager.setup($plugins) during its eval.)
  await nxDrainScripts();
  bootLog('plugins loaded, starting game...');
  // Diagnostic: trace scene transitions to pinpoint OOM phase.
  try {
    const sm = globalThis.SceneManager;
    if (sm && sm.goto) {
      const origGoto = sm.goto.bind(sm);
      sm.goto = function(sceneClass) {
        try { log('Scene goto:', sceneClass && sceneClass.name); } catch (e) {}
        // Return heap pages to the native allocator at scene transitions:
        // native OOM (image/audio decode malloc) is the port's hard ceiling.
        try { if (typeof globalThis.gc === 'function') globalThis.gc(); } catch (e) {}
        return origGoto(sceneClass);
      };
    }
    // Diagnostic: wrap post-database phases to find the OOM site.
    const wrapPhase = (objName, fnName) => {
      try {
        const obj = globalThis[objName];
        if (obj && typeof obj[fnName] === 'function') {
          const orig = obj[fnName];
          obj[fnName] = function(...args) {
            log('Phase start:', objName + '.' + fnName);
            const r = orig.apply(this, args);
            log('Phase done:', objName + '.' + fnName);
            return r;
          };
        }
      } catch (e) {}
    };
    wrapPhase('DataManager', 'setupNewGame');
    wrapPhase('SoundManager', 'preloadImportantSounds');
    // Diagnostic: trace Scene_Boot.isReady and loadSystemImages.
    try {
      const SB = globalThis.Scene_Boot;
      if (SB && SB.prototype) {
        const origIsReady = SB.prototype.isReady;
        let isReadyCount = 0;
        SB.prototype.isReady = function() {
          isReadyCount++;
          if (isReadyCount === 1 || isReadyCount % 300 === 0) {
            try { log('Scene_Boot.isReady call #' + isReadyCount); } catch (e) {}
          }
          return origIsReady.call(this);
        };
        const origLSI = SB.prototype.loadSystemImages;
        if (typeof origLSI === 'function') {
          SB.prototype.loadSystemImages = function() {
            try { log('Phase start: Scene_Boot.loadSystemImages'); } catch (e) {}
            const r = origLSI.call(this);
            try { log('Phase done: Scene_Boot.loadSystemImages'); } catch (e) {}
            return r;
          };
        }
      }
      // Diagnostic: trace DataManager.onLoad completion.
      const DM = globalThis.DataManager;
      if (DM && typeof DM.onLoad === 'function') {
        const origOnLoad = DM.onLoad;
        DM.onLoad = function(obj) {
          const name = obj === globalThis.$dataCommonEvents ? '$dataCommonEvents' :
                       obj === globalThis.$dataCommonEvents2 ? '$dataCommonEvents2' : '?';
          try { log('DataManager.onLoad start:', name); } catch (e) {}
          const r = origOnLoad.call(this, obj);
          try { log('DataManager.onLoad done:', name); } catch (e) {}
          return r;
        };
      }
      // Diagnostic: trace SceneManager exceptions and stop.
      const SM2 = globalThis.SceneManager;
      if (SM2) {
        if (typeof SM2.catchException === 'function') {
          const origCE = SM2.catchException;
          SM2.catchException = function(e) {
            try { log('SceneManager.catchException:', e && (e.stack || e.message || e)); } catch (x) {}
            return origCE.call(this, e);
          };
        }
        if (typeof SM2.stop === 'function') {
          const origStop = SM2.stop;
          SM2.stop = function() {
            try { log('SceneManager.stop called'); } catch (x) {}
            return origStop.call(this);
          };
        }
      }
      // Diagnostic: trace ResourceHandler retries to find the failing URL.
      // Safety net: for non-data resources (img/audio), pass a null URL to
      // the real createLoader so a permanently missing file can no longer
      // trigger Graphics.printLoadingError + SceneManager.stop() (which froze
      // the game on a missing SE). Data files keep their URL: those failures
      // are genuinely fatal and should stay visible.
      try {
        const RH = globalThis.ResourceHandler;
        if (RH && typeof RH.createLoader === 'function') {
          const origCL = RH.createLoader;
          RH.createLoader = function(url, retryMethod, resignMethod, retryInterval) {
            try { log('ResourceHandler.createLoader:', url); } catch (x) {}
            const safeUrl = (url && /data\//i.test(url)) ? url : null;
            return origCL.call(this, safeUrl, retryMethod, resignMethod, retryInterval);
          };
        }
      } catch (x) {}
      // Fix: a bitmap stuck in 'error' state (e.g. AltMenuScreen3's
      // Save-screen background 'pictures/save.png', which does not exist
      // in the assets) must not block scene start forever. Scene_Base
      // .isReady() waits on ImageManager.isReady(), which is false while
      // ANY cached bitmap is neither 'loaded' nor 'none' — including
      // permanently errored ones. So a missing decorative image froze
      // Scene_Save on the last menu frame (ticks alive, frames+=0).
      // Treat errored bitmaps as ready for the cache-readiness check
      // ONLY; Bitmap.isReady itself is unchanged, so sprites still skip
      // drawing them (blank background) instead of hanging the scene.
      try {
        const ICP = globalThis.ImageCache && ImageCache.prototype;
        if (ICP && typeof ICP.isReady === 'function' && !ICP._yttdErrReady) {
          ICP._yttdErrReady = true;
          ICP.isReady = function() {
            const items = this._items || {};
            for (const key in items) {
              const bm = items[key] && items[key].bitmap;
              if (bm && !bm.isRequestOnly() && !bm.isReady() && !bm.isError()) return false;
            }
            return true;
          };
          log('Fix: errored bitmaps no longer block scene start');
        }
      } catch (x) {}
      // nx.js getImageData throws on some canvases, and MV calls it on
      // EVERY touch over a picture with transparent consideration ON
      // (Sprite_Picture.callTouch -> isTransparent -> getAlphaPixel).
      // The throw escaped into SceneManager.catchException, which stopped
      // the game (frozen frame) and left the error stack drawn on screen
      // as red text. Fall back to opaque (255): a deliberate click should
      // trigger the picture rather than crash the game.
      try {
        const BP = globalThis.Bitmap && Bitmap.prototype;
        if (BP && typeof BP.getAlphaPixel === 'function' && !BP._yttdAlphaFallback) {
          BP._yttdAlphaFallback = true;
          const origGAP = BP.getAlphaPixel;
          BP.getAlphaPixel = function(x, y) {
            try { return origGAP.call(this, x, y); }
            catch (e) { return 255; }
          };
          log('Fix: getAlphaPixel falls back to opaque on getImageData error');
        }
      } catch (x) {}
      // Bitmap loads go through MV's Decrypter (XHR for .rpgmvp, decrypt in
      // JS, blob URL to the Image) — NOT through the fetch wrapper's .png
      // decrypt — so the palette-transparency fix must also run here, on
      // the decrypted bytes before the blob URL is made. Non-PNG blobs
      // pass through untouched (the fix returns null for them).
      try {
        const D = globalThis.Decrypter;
        if (D && typeof D.createBlobUrl === 'function' && !D._yttdPngFix) {
          D._yttdPngFix = true;
          const origCBU = D.createBlobUrl.bind(D);
          D.createBlobUrl = function(arrayBuffer) {
            try {
              const fixed = fixPngPaletteTransparency(new Uint8Array(arrayBuffer));
              if (fixed) arrayBuffer = fixed.buffer;
            } catch (x) {}
            return origCBU(arrayBuffer);
          };
          log('Fix: paletted PNG transparent palette entries zeroed (Decrypter path)');
        }
      } catch (x) {}
      // Diagnostic: trace Graphics.printLoadingError to find the failing URL.
      try {
        const G = globalThis.Graphics;
        if (G && typeof G.printLoadingError === 'function') {
          const origPLE = G.printLoadingError;
          G.printLoadingError = function(url) {
            try { log('Graphics.printLoadingError:', url); } catch (x) {}
            return origPLE.call(this, url);
          };
        }
      } catch (x) {}
      // Fix: nx.js CanvasRenderingContext2D.createPattern is not implemented
      // (throws), and Pixi's TilingSprite._renderCanvas depends on it (used
      // for map parallaxes). Replace with an equivalent manual tiled fill.
      // NOTE: MV's own TilingSprite (rpg_core.js) CAPTURES the PIXI function
      // as _renderCanvas_PIXI when rpg_core loads, so patching the PIXI
      // prototype afterwards is not enough - the MV slot must be patched too
      // (it is looked up on the instance at call time, so this works).
      try {
        const TS = globalThis.PIXI && PIXI.extras && PIXI.extras.TilingSprite;
        if (TS && TS.prototype) {
          const manualTilingRender = function (renderer) {
            const texture = this._texture;
            if (!texture || !texture.baseTexture || !texture.baseTexture.hasLoaded) return;
            const context = renderer.context;
            const transform = this.worldTransform;
            const resolution = renderer.resolution;
            const baseTexture = texture.baseTexture;
            const baseRes = baseTexture.resolution || 1;
            const frame = texture._frame;
            // Build the single-tile canvas once per texture/tint.
            if (!this._yttdTile || this._yttdTile.baseTexture !== baseTexture || this._yttdTile.tint !== this.tint) {
              const rt = new PIXI.CanvasRenderTarget(frame.width, frame.height, baseRes);
              if (this.tint !== 0xFFFFFF) {
                if (this.cachedTint !== this.tint) {
                  this.cachedTint = this.tint;
                  this.tintedTexture = PIXI.CanvasTinter.getTintedTexture(this, this.tint);
                }
                rt.context.drawImage(this.tintedTexture, 0, 0);
              } else {
                rt.context.drawImage(baseTexture.source, -frame.x * baseRes, -frame.y * baseRes);
              }
              this._yttdTile = { canvas: rt.canvas, baseTexture: baseTexture, tint: this.tint };
            }
            const tileCanvas = this._yttdTile.canvas;
            const modX = (this.tilePosition.x / this.tileScale.x) % frame.width * baseRes;
            const modY = (this.tilePosition.y / this.tileScale.y) % frame.height * baseRes;
            context.globalAlpha = this.worldAlpha;
            context.setTransform(transform.a * resolution, transform.b * resolution, transform.c * resolution, transform.d * resolution, transform.tx * resolution, transform.ty * resolution);
            renderer.setBlendMode(this.blendMode);
            context.scale(this.tileScale.x / baseRes, this.tileScale.y / baseRes);
            const anchorX = this.anchor.x * -this._width;
            const anchorY = this.anchor.y * -this._height;
            const W = this._width / this.tileScale.x * baseRes;
            const H = this._height / this.tileScale.y * baseRes;
            let rectX, rectY;
            if (this.uvRespectAnchor) {
              context.translate(modX, modY);
              rectX = -modX + anchorX; rectY = -modY + anchorY;
            } else {
              context.translate(modX + anchorX, modY + anchorY);
              rectX = -modX; rectY = -modY;
            }
            const periodX = tileCanvas.width, periodY = tileCanvas.height;
            if (periodX > 0 && periodY > 0) {
              context.save();
              context.beginPath();
              context.rect(rectX, rectY, W, H);
              context.clip();
              const startX = Math.floor(rectX / periodX) * periodX;
              const startY = Math.floor(rectY / periodY) * periodY;
              const estDraws = Math.ceil(W / periodX) * Math.ceil(H / periodY);
              // Durability: tiling a tiny tile (e.g. 1x1) over a fullscreen
              // rect costs hundreds of thousands of drawImages per frame.
              // Render the pattern once into a cache canvas and blit it
              // (only when the loop would be large; small loops stay direct).
              if (estDraws > 64 && W > 0 && H > 0) {
                const parts = [tileCanvas, W, H, modX, modY, this.uvRespectAnchor ? 1 : 0];
                let pc = this._yttdPattern;
                const same = pc && pc.parts.length === parts.length && pc.parts.every((v, i) => v === parts[i]);
                if (!same) {
                  const cw = Math.ceil(W), ch = Math.ceil(H);
                  const cCan = document.createElement('canvas');
                  cCan.width = cw; cCan.height = ch;
                  const cCtx = cCan.getContext('2d');
                  for (let x = startX; x < rectX + W; x += periodX) {
                    for (let y = startY; y < rectY + H; y += periodY) {
                      cCtx.drawImage(tileCanvas, x - rectX, y - rectY);
                    }
                  }
                  pc = { parts: parts, canvas: cCan };
                  this._yttdPattern = pc;
                }
                context.drawImage(pc.canvas, rectX, rectY);
              } else {
                for (let x = startX; x < rectX + W; x += periodX) {
                  for (let y = startY; y < rectY + H; y += periodY) {
                    context.drawImage(tileCanvas, x, y);
                  }
                }
              }
              context.restore();
            }
          };
          TS.prototype._renderCanvas = manualTilingRender;
          // MV's TilingSprite delegates to the captured _renderCanvas_PIXI.
          const MVTS = globalThis.TilingSprite;
          if (MVTS && MVTS.prototype) {
            MVTS.prototype._renderCanvas_PIXI = manualTilingRender;
          }
          try { log('TilingSprite._renderCanvas patched (manual tiling)'); } catch (x) {}
        }
      } catch (x) {}
      // Fix (Map017 root cause): a map with no parallax gets a Bitmap that
      // never loads an image, whose canvas stays at the 1x1 placeholder
      // size (Bitmap.resize clamps 0 -> 1). MV's TilingSprite._renderCanvas
      // only checks frame > 0, so it tiles that 1x1 canvas over 816x624 =
      // ~509k drawImages per frame (~1700ms/real render, ~2 FPS). Skip
      // never-loaded degenerate tiles entirely (visually blank anyway).
      // Note: Bitmap.isReady() is true for state 'none', so it cannot be
      // the guard - use _image + size instead.
      try {
        const MVTS2 = globalThis.TilingSprite;
        if (MVTS2 && MVTS2.prototype && MVTS2.prototype._renderCanvas && !MVTS2.prototype._yttdBlankGuard) {
          MVTS2.prototype._yttdBlankGuard = true;
          const origMVT = MVTS2.prototype._renderCanvas;
          MVTS2.prototype._renderCanvas = function(renderer) {
            const bm = this._bitmap;
            if (bm && !bm._image && (bm.width | 0) <= 1 && (bm.height | 0) <= 1) {
              return;
            }
            return origMVT.call(this, renderer);
          };
          log('TilingSprite blank-tile guard installed');
        }
      } catch (x) {}
      // Fix: nx.js native Image doesn't go through our fetch wrapper (ZIP).
      // Override ImageManager.loadBitmap to fetch via our wrapper and use blob URLs.
      try {
        const IM = globalThis.ImageManager;
        if (IM && typeof IM.loadBitmap === 'function') {
          const origLB = IM.loadBitmap;
          IM.loadBitmap = function(folder, filename, hue, smooth) {
            try {
              const url = this._imageUrl(folder, filename);
              log('ImageManager.loadBitmap:', url);
              // Fetch via our wrapper (handles ZIP), then create blob URL for native Image.
              return origLB.call(this, folder, filename, hue, smooth);
            } catch (x) {
              return origLB.call(this, folder, filename, hue, smooth);
            }
          };
        }
      } catch (x) {}
      // Diagnostics: trace game-level Input triggers (proves whether MV's
      // Input sees pad presses, distinct from the raw gamepad poller).
      // NOTE: this MV version advances messages via isRepeated('ok'), so
      // trace both isTriggered and isRepeated.
      try {
        const IN = globalThis.Input;
        if (IN && typeof IN.isTriggered === 'function') {
          const origIT = IN.isTriggered.bind(IN);
          IN.isTriggered = function(name) {
            const r = origIT(name);
            if (r && (name === 'ok' || name === 'cancel' || name === 'down' || name === 'up' || name === 'menu')) {
              try { log('INPUT triggered:', name); } catch (x) {}
            }
            return r;
          };
          const origIR = IN.isRepeated.bind(IN);
          IN.isRepeated = function(name) {
            const r = origIR(name);
            if (r && (name === 'ok' || name === 'cancel')) {
              try { log('INPUT repeated:', name); } catch (x) {}
            }
            return r;
          };
        }
      } catch (x) {}
      // Diagnostics + freeze bisect: the freeze always lands within a
      // second of a dialogue SE play (GALV talk blips 'select04' every 4
      // chars + confirm blip 'poka01' per line advance). Temporarily mute
      // exactly those two SEs to test whether rapid native audio churn is
      // what wedges the main thread during dialogue.
      try {
        const AM = globalThis.AudioManager;
        if (AM && typeof AM.playSe === 'function') {
          const origPS = AM.playSe.bind(AM);
          AM.playSe = function(se) {
            if (se && (se.name === 'select04' || se.name === 'poka01')) {
              return;
            }
            return origPS(se);
          };
          log('Diag: GALV talk/confirm SE muted (select04, poka01)');
        }
      } catch (x) {}
      // Diagnostics: log when a picture click actually reserves a common
      // event (proves the touch -> PictureCallCommon path fired).
      // $gameTemp only exists after DataManager.createGameObjects, so
      // install the wrapper there (and immediately if it already exists).
      try {
        const installPCI = function() {
          try {
            const GT = globalThis.$gameTemp;
            if (GT && typeof GT.setPictureCallInfo === 'function' && !GT._yttdPCILogged) {
              GT._yttdPCILogged = true;
              const origPCI = GT.setPictureCallInfo.bind(GT);
              GT.setPictureCallInfo = function(commonId, pictureId) {
                try { log('PICTURE CLICK: common=' + commonId + ' picture=' + pictureId + ' TouchInput=(' + globalThis.TouchInput.x + ',' + globalThis.TouchInput.y + ')'); } catch (x) {}
                return origPCI(commonId, pictureId);
              };
            }
          } catch (x) {}
        };
        installPCI();
        const DM = globalThis.DataManager;
        if (DM && typeof DM.createGameObjects === 'function' && !DM._yttdCGOWrapped) {
          DM._yttdCGOWrapped = true;
          const origCGO = DM.createGameObjects.bind(DM);
          DM.createGameObjects = function() {
            const r = origCGO();
            installPCI();
            installGamepadTap();
            return r;
          };
        }
      } catch (x) {}
      // Gamepad substitute for taps: on Switch there is no mouse, and
      // several buttons sit idle, so pressing A (ok) also fires any
      // picture with a registered touch trigger (PictureCallCommon
      // trigger 1). Keeps the isTouchable gate (bitmap loaded, visible,
      // non-zero scale) but drops the pointer-position requirement,
      // since there is no pointer. Installed lazily like installPCI
      // because the plugin patches Sprite_Picture at plugin load.
      try {
        var installGamepadTap = function() {
          try {
            const SP = globalThis.Sprite_Picture && globalThis.Sprite_Picture.prototype;
            if (SP && typeof SP.isTriggered === 'function' && !SP._yttdGamepadTap) {
              SP._yttdGamepadTap = true;
              const origTrig = SP.isTriggered;
              SP.isTriggered = function() {
                if (origTrig.call(this)) return true;
                try {
                  if (this.isTouchable() && globalThis.Input && globalThis.Input.isTriggered('ok')) return true;
                } catch (x) {}
                return false;
              };
              log('Diag: gamepad A (ok) now fires touch-triggered pictures');
            }
          } catch (x) {}
        };
        installGamepadTap();
      } catch (x) {}
      // Stick cursor: poll the pad once per game tick (before the tick's
      // input processing, so a synthesized touchstart lands in the same
      // tick MV's TouchInput.update consumes it).
      try {
        const SM2 = globalThis.SceneManager;
        if (SM2 && typeof SM2.updateMain === 'function' && !SM2._yttdCursorPolled) {
          SM2._yttdCursorPolled = true;
          const origUM2 = SM2.updateMain.bind(SM2);
          SM2.updateMain = function() { try { installStickMask(); } catch (x) {} try { cursorPoll(); } catch (x) {} return origUM2(); };
          log('Stick cursor installed (left stick moves, ZL/ZR click)');
        }
      } catch (x) {}
      // Diagnostics: 5s status heartbeat - scene, interpreter wait state,
      // message/choice state, and whether the render loop is alive (via the
      // Graphics._frameCount delta).
      try {
        let lastFc = -1;
        let lastTick = -1;
        // Count SceneManager ticks independently of Graphics.frameCount,
        // and time the render + blit, to locate a slowdown (update vs render).
        try {
          const SM = globalThis.SceneManager;
          if (SM && typeof SM.updateMain === 'function' && !SM._yttdTickCounted) {
            SM._yttdTickCounted = true;
            globalThis.__yttdTicks = 0;
            const origUM = SM.updateMain.bind(SM);
            SM.updateMain = function() { try { globalThis.__yttdTicks++; } catch (x) {} return origUM(); };
          }
        } catch (x) {}
        try {
          const G0 = globalThis.Graphics;
          if (G0 && G0.render && !G0._yttdRenderTimed) {
            G0._yttdRenderTimed = true;
            globalThis.__yttdRenderMs = 0;
            globalThis.__yttdRenderN = 0;
            const origR = G0.render;
            G0.render = function(stage) {
              const t0 = Date.now();
              const r = origR.call(this, stage);
              const dt = Date.now() - t0;
              globalThis.__yttdRenderMs += dt;
              globalThis.__yttdRenderN++;
              return r;
            };
          }
        } catch (x) {}
        // Per-category render timing: ToneSprite (fullscreen tone fills),
        // all Sprites (pictures, characters, tilemap layers), and the
        // loader's screen blit - to find which draw costs ~440ms on Map017.
        try {
          globalThis.__yttdToneMs = 0;
          globalThis.__yttdSprMs = 0;
          globalThis.__yttdBlitMs = 0;
          globalThis.__yttdTileMs = 0;
          globalThis.__yttdWinMs = 0;
          const TS = globalThis.ToneSprite;
          if (TS && TS.prototype && TS.prototype._renderCanvas && !TS.prototype._yttdTimed) {
            TS.prototype._yttdTimed = true;
            const origT = TS.prototype._renderCanvas;
            TS.prototype._renderCanvas = function(renderer) {
              const t0 = Date.now();
              const r = origT.call(this, renderer);
              globalThis.__yttdToneMs += (Date.now() - t0);
              return r;
            };
          }
          const SP = globalThis.Sprite;
          if (SP && SP.prototype && SP.prototype._renderCanvas && !SP.prototype._yttdTimed) {
            SP.prototype._yttdTimed = true;
            const origS = SP.prototype._renderCanvas;
            SP.prototype._renderCanvas = function(renderer) {
              const t0 = Date.now();
              const r = origS.call(this, renderer);
              globalThis.__yttdSprMs += (Date.now() - t0);
              return r;
            };
          }
          const TM = globalThis.Tilemap;
          if (TM && TM.prototype && TM.prototype._paintAllTiles && !TM.prototype._yttdTimed) {
            TM.prototype._yttdTimed = true;
            const origP = TM.prototype._paintAllTiles;
            TM.prototype._paintAllTiles = function(a, b) {
              const t0 = Date.now();
              const r = origP.call(this, a, b);
              globalThis.__yttdTileMs += (Date.now() - t0);
              return r;
            };
          }
          const WN = globalThis.Window;
          if (WN && WN.prototype && WN.prototype._renderCanvas && !WN.prototype._yttdTimed) {
            WN.prototype._yttdTimed = true;
            const origW = WN.prototype._renderCanvas;
            WN.prototype._renderCanvas = function(renderer) {
              const t0 = Date.now();
              const r = origW.call(this, renderer);
              globalThis.__yttdWinMs += (Date.now() - t0);
              return r;
            };
          }
          // Split the renderer's own two phases: scene-graph transform
          // update vs the draw walk, plus the Tilemap's transform (which
          // can repaint tiles). This isolates the ~1740ms/real-render
          // that sits outside every leaf draw measured so far.
          globalThis.__yttdUpdMs = 0;
          globalThis.__yttdDrawMs = 0;
          globalThis.__yttdTileUpdMs = 0;
          const SC = globalThis.Scene_Map;
          if (SC && SC.prototype && !SC.prototype._yttdTimed) {
            SC.prototype._yttdTimed = true;
            const origUT = SC.prototype.updateTransform;
            SC.prototype.updateTransform = function() {
              const t0 = Date.now();
              const r = origUT.call(this);
              globalThis.__yttdUpdMs += (Date.now() - t0);
              return r;
            };
            const origRC = SC.prototype.renderCanvas;
            SC.prototype.renderCanvas = function(renderer) {
              const t0 = Date.now();
              const r = origRC.call(this, renderer);
              globalThis.__yttdDrawMs += (Date.now() - t0);
              return r;
            };
          }
          if (TM && TM.prototype && TM.prototype.updateTransform && !TM.prototype._yttdUpdTimed) {
            TM.prototype._yttdUpdTimed = true;
            const origTU = TM.prototype.updateTransform;
            TM.prototype.updateTransform = function() {
              const t0 = Date.now();
              const r = origTU.call(this);
              globalThis.__yttdTileUpdMs += (Date.now() - t0);
              return r;
            };
          }
          // Remaining unmeasured draw paths: WindowLayer (renders all
          // windows via a temp canvas every frame) and TilingSprite
          // (parallax; own _renderCanvas, not covered by the Sprite wrap).
          globalThis.__yttdWinLayerMs = 0;
          globalThis.__yttdTilingMs = 0;
          const WL = globalThis.WindowLayer;
          if (WL && WL.prototype && WL.prototype.renderCanvas && !WL.prototype._yttdTimed) {
            WL.prototype._yttdTimed = true;
            const origWL = WL.prototype.renderCanvas;
            WL.prototype.renderCanvas = function(renderer) {
              const t0 = Date.now();
              const r = origWL.call(this, renderer);
              globalThis.__yttdWinLayerMs += (Date.now() - t0);
              return r;
            };
          }
          const TS2 = globalThis.TilingSprite;
          if (TS2 && TS2.prototype && TS2.prototype._renderCanvas && !TS2.prototype._yttdTimed2) {
            TS2.prototype._yttdTimed2 = true;
            const origTS = TS2.prototype._renderCanvas;
            TS2.prototype._renderCanvas = function(renderer) {
              const t0 = Date.now();
              const r = origTS.call(this, renderer);
              globalThis.__yttdTilingMs += (Date.now() - t0);
              return r;
            };
          }
        } catch (x) {}
        setInterval(() => {
          try {
            const G = globalThis.Graphics;
            const fc = G ? (G.frameCount | 0) : -1;
            const dFc = lastFc < 0 ? 0 : fc - lastFc;
            lastFc = fc;
            const tk = globalThis.__yttdTicks | 0;
            const dTk = lastTick < 0 ? 0 : tk - lastTick;
            lastTick = tk;
            const rMs = globalThis.__yttdRenderMs | 0;
            const rN = globalThis.__yttdRenderN | 0;
            globalThis.__yttdRenderMs = 0;
            globalThis.__yttdRenderN = 0;
            const avgR = rN ? (rMs / rN).toFixed(1) : '?';
            const toneMs = globalThis.__yttdToneMs | 0;
            const sprMs = globalThis.__yttdSprMs | 0;
            const blitMs = globalThis.__yttdBlitMs | 0;
            const tileMs = globalThis.__yttdTileMs | 0;
            const winMs = globalThis.__yttdWinMs | 0;
            const updMs = globalThis.__yttdUpdMs | 0;
            const drawMs = globalThis.__yttdDrawMs | 0;
            const tileUpdMs = globalThis.__yttdTileUpdMs | 0;
            const winLayerMs = globalThis.__yttdWinLayerMs | 0;
            const tilingMs = globalThis.__yttdTilingMs | 0;
            globalThis.__yttdToneMs = 0;
            globalThis.__yttdSprMs = 0;
            globalThis.__yttdBlitMs = 0;
            globalThis.__yttdTileMs = 0;
            globalThis.__yttdWinMs = 0;
            globalThis.__yttdUpdMs = 0;
            globalThis.__yttdDrawMs = 0;
            globalThis.__yttdTileUpdMs = 0;
            globalThis.__yttdWinLayerMs = 0;
            globalThis.__yttdTilingMs = 0;
            const tonePf = dFc ? (toneMs / dFc).toFixed(1) : '?';
            const sprPf = dFc ? (sprMs / dFc).toFixed(1) : '?';
            const blitPf = dFc ? (blitMs / dFc).toFixed(1) : '?';
            const tilePf = dFc ? (tileMs / dFc).toFixed(1) : '?';
            const winPf = dFc ? (winMs / dFc).toFixed(1) : '?';
            const updPf = dFc ? (updMs / dFc).toFixed(1) : '?';
            const drawPf = dFc ? (drawMs / dFc).toFixed(1) : '?';
            const tileUpdPf = dFc ? (tileUpdMs / dFc).toFixed(1) : '?';
            const winLayerPf = dFc ? (winLayerMs / dFc).toFixed(1) : '?';
            const tilingPf = dFc ? (tilingMs / dFc).toFixed(1) : '?';
            // Count scene-graph nodes (a huge tree would explain a slow
            // container recursion even with cheap leaf draws).
            let nodeInfo = '';
            try {
              const st = sm && sm._scene;
              if (st) {
                let n = 0;
                const counts = Object.create(null);
                const stack = [st];
                while (stack.length && n < 20000) {
                  const nd = stack.pop();
                  n++;
                  const cn = (nd.constructor && nd.constructor.name) || '?';
                  counts[cn] = (counts[cn] | 0) + 1;
                  const ch = nd.children;
                  if (ch) for (let i = 0; i < ch.length; i++) stack.push(ch[i]);
                }
                const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 4).map((k) => k + ':' + counts[k]).join(',');
                nodeInfo = ' nodes=' + n + '(' + top + ')';
              }
            } catch (x) {}
            const sm = globalThis.SceneManager;
            const scene = sm && sm._scene ? (sm._scene.constructor && sm._scene.constructor.name) : '?';
            let extra = '';
            try {
              const gm = globalThis.$gameMap;
              const itp = gm ? gm._interpreter : null;
              if (itp) {
                extra += ' itp:run=' + itp.isRunning() + ',idx=' + itp._index + ',wait=' + itp._waitMode + '/' + itp._waitCount + ',evt=' + itp._eventId;
              }
              const msg = globalThis.$gameMessage;
              if (msg) {
                extra += ' msg:busy=' + msg.isBusy() + ',choice=' + (typeof msg.isChoice === 'function' ? msg.isChoice() : '?');
              }
              const scr = globalThis.$gameScreen;
              if (scr) {
                extra += ' tone=' + JSON.stringify(scr.tone()) + ',bright=' + scr.brightness();
                try {
                  const p1 = scr.picture(1);
                  if (p1) extra += ' pic1op=' + p1.opacity();
                } catch (x) {}
              }
              if (scene === 'Scene_Map' && sm._scene && sm._scene._messageWindow) {
                const mw = sm._scene._messageWindow;
                const cw = mw._choiceWindow;
                extra += ' msgwin:active-sub=' + (cw ? ('choice(active=' + cw.active + ',idx=' + (typeof cw.index === 'function' ? cw.index() : cw.index) + ')') : 'none');
              }
            } catch (x) {}
            log('STATUS scene=' + scene + ' ticks+=' + dTk + ' frames+=' + dFc + ' renderAvgMs=' + avgR + ' tonePf=' + tonePf + ' sprPf=' + sprPf + ' blitPf=' + blitPf + ' tilePf=' + tilePf + ' winPf=' + winPf + ' updPf=' + updPf + ' drawPf=' + drawPf + ' tileUpdPf=' + tileUpdPf + ' winLayerPf=' + winLayerPf + ' tilingPf=' + tilingPf + nodeInfo + ' skip=' + (G ? G._skipCount : '?') + extra);
          } catch (x) {}
        }, 5000);
      } catch (x) {}
    } catch (e) {}
    try {
      const cte = globalThis.CTE;
      if (cte && typeof cte.loadLanguageScripts === 'function') {
        const orig = cte.loadLanguageScripts;
        cte.loadLanguageScripts = function(...args) {
          log('Phase start: CTE.loadLanguageScripts');
          const r = orig.apply(this, args);
          log('Phase done: CTE.loadLanguageScripts');
          return r;
        };
      }
      if (cte && typeof cte.load === 'function') {
        const origLoad = cte.load;
        cte.load = function(localPath, ...rest) {
          log('CTE.load:', localPath);
          const r = origLoad.call(this, localPath, ...rest);
          log('CTE.load done:', localPath, '->', r);
          return r;
        };
      }
      // Avoid LZString.decompressFromBase64 OOM on Switch: use pre-decompressed
      // JSON (built at pack time) instead of decompressing EN.cte at runtime.
      // With the official ZIP there is no pre-decompressed file, so fall
      // back to the original loader (EN.cte is only ~950KB, decompressing
      // to ~2.3MB — fine with the current heap config).
      if (cte && typeof cte.loadLanguage === 'function') {
        const origLoadLanguage = cte.loadLanguage.bind(cte);
        cte.loadLanguage = function(language) {
          log('CTE.loadLanguage (pre-decompressed):', language);
          try {
            cte.data = cte.data || {};
            const xhr = new XMLHttpRequest();
            xhr.open('GET', '3/languages/' + language + '.decompressed.json', false);
            xhr.send();
            if (xhr.status < 400 && xhr.responseText) {
              cte.data[language] = JSON.parse(xhr.responseText);
              log('CTE.loadLanguage done:', language, 'keys=', Object.keys(cte.data[language]).length);
            } else {
              log('CTE.loadLanguage: no pre-decompressed file for', language, '- falling back to .cte');
              origLoadLanguage(language);
            }
          } catch (e) {
            log('CTE.loadLanguage failed:', language, e && e.message);
            try { origLoadLanguage(language); } catch (e2) { cte.data[language] = {}; }
          }
        };
      }
    } catch (e) {}
  } catch (e) {}
  const onload = globalThis.onload;
  if (typeof onload === 'function') {
    onload();
  } else {
    bootLog('window.onload was never set - boot failed', true);
  }
}

boot().catch((e) => {
  bootLog('BOOT FAILED: ' + (e && (e.stack || e.message || e)), true);
});
