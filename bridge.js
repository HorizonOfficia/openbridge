#!/usr/bin/env node
/**
 * SignalRGB → OpenRGB Bridge
 *
 * Usage:
 *   node bridge.js <effect.html> [deviceIndex]
 *   node bridge.js <effect.html> --mouse
 *   node bridge.js <effect.html> --all-devices
 *   node bridge.js <effect.html> --layout-editor
 *   node bridge.js <effect.html> --layout my.json
 *
 * Flags:
 *   --fps N              Target render frame rate (default: 30)
 *   --effect-fps N       Effect's native fps for animation pacing (default: 90)
 *                        Ticks are multiplied so animation speed matches the original
 *                        regardless of render fps. Set to match the SignalRGB preview fps.
 *   --host H             OpenRGB host (default: 127.0.0.1 or $OPENRGB_HOST)
 *   --port P             OpenRGB port (default: 6742 or $OPENRGB_PORT)
 *   --mouse              Also apply effect to mouse
 *   --mousepad           Also apply effect to mousepad
 *   --headset            Also apply effect to headset
 *   --all-devices        Apply effect to every connected device
 *   --layout <file>      Load layout region from JSON file
 *   --layout-editor      Start layout editor web UI
 *   --editor-port P      Port for layout editor (default: 7899)
 *   --sample-radius N    Pixel neighborhood radius per LED (default: 3, 0=single pixel)
 *   --tap-socket <path>  Unix socket path for keypress injection (see below)
 *   --reconnect          Auto-reconnect to OpenRGB on disconnect
 *   --evdev [path]       Read keypresses directly from evdev (default: auto-detect)
 *                        Needs input group: sudo usermod -aG input $USER && re-login
 *
 * Keypress injection (Arch Linux / daemon mode):
 *   By default the bridge listens for keypresses via a Unix domain socket.
 *   Any tool can send a tap:
 *     echo "tap" | nc -U /tmp/rgb-bridge-tap.sock
 *     echo "120,50" | nc -U /tmp/rgb-bridge-tap.sock   # specific x,y on canvas
 *   Wire this to xbindkeys, xdotool, or anything that can run a shell command.
 */
'use strict';

const net  = require('net');
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const http = require('http');
const { execSync, spawn } = require('child_process');
const { createCanvas } = require('@napi-rs/canvas');

// ─────────────────────────────────────────────────────────────────────────────
//  SECTION 0 — CLI
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const raw = argv.slice(2);
  const opts = {
    effect:       null,
    deviceIndex:  null,
    allDevices:   false,
    extraTypes:   [],          // 'mouse', 'mousepad', 'headset'
    fps:          30,
    effectFps:    90,   // fps the effect was designed for; ticks are multiplied to match
    host:         process.env.OPENRGB_HOST || '127.0.0.1',
    port:         parseInt(process.env.OPENRGB_PORT  || '6742'),
    layout:       null,
    layoutEditor: false,
    editorPort:   7899,
    sampleRadius: 3,
    tapSocket:    '/tmp/rgb-bridge-tap.sock',
    reconnect:    false,
    evdev: null,
  };

  let i = 0;
  while (i < raw.length) {
    const a = raw[i];
    switch (a) {
      case '--all-devices':   opts.allDevices = true;                           i++; break;
      case '--mouse':         opts.extraTypes.push('mouse');                    i++; break;
      case '--mousepad':      opts.extraTypes.push('mousepad');                 i++; break;
      case '--headset':       opts.extraTypes.push('headset');                  i++; break;
      case '--fps':           opts.fps          = parseInt(raw[++i]) || 30;    i++; break;
      case '--effect-fps':    opts.effectFps    = parseInt(raw[++i]) || 90;    i++; break;
      case '--host':          opts.host         = raw[++i];                     i++; break;
      case '--port':          opts.port         = parseInt(raw[++i]);           i++; break;
      case '--layout':        opts.layout       = raw[++i];                     i++; break;
      case '--layout-editor': opts.layoutEditor = true;                         i++; break;
      case '--editor-port':   opts.editorPort   = parseInt(raw[++i]);           i++; break;
      case '--sample-radius': opts.sampleRadius = parseInt(raw[++i]);           i++; break;
      case '--tap-socket':    opts.tapSocket    = raw[++i];                     i++; break;
      case '--reconnect':     opts.reconnect    = true;                         i++; break;
      case '--evdev': opts.evdev = (raw[i+1] && !raw[i+1].startsWith('--')) ? raw[++i] : 'auto'; i++; break;
      default:
        if (!a.startsWith('--')) {
          if      (!opts.effect)                               opts.effect      = a;
          else if (opts.deviceIndex === null && !isNaN(+a))   opts.deviceIndex = parseInt(a);
        }
        i++;
    }
  }
  return opts;
}

// ─────────────────────────────────────────────────────────────────────────────
//  SECTION 1 — Constants
// ─────────────────────────────────────────────────────────────────────────────

const CANVAS_W = 320;
const CANVAS_H = 200;
const NA       = 0xFFFFFFFF;   // matrix map "no LED here" sentinel

const DEVICE_TYPE = { keyboard: 5, mouse: 6, mousepad: 7, headset: 8 };
const ZONE_TYPE   = { linear: 1, matrix: 2 };

const PKT = {
  REQUEST_CONTROLLER_COUNT : 0,
  REQUEST_CONTROLLER_DATA  : 1,
  REQUEST_PROTOCOL_VERSION : 40,
  SET_CLIENT_NAME          : 50,
  SETCUSTOMMODE            : 1100,
  UPDATELEDS               : 1050,
};

// ─────────────────────────────────────────────────────────────────────────────
//  SECTION 2 — OpenRGB SDK client
// ─────────────────────────────────────────────────────────────────────────────

function readString(buf, ptr) {
  const len = buf.readUInt16LE(ptr);
  return [buf.toString('utf8', ptr + 2, ptr + 2 + len), ptr + 2 + len];
}

class OpenRGBClient {
  constructor(host, port) {
    this.host            = host;
    this.port            = port;
    this.socket          = null;
    this.protocolVersion = 0;
    this._buf            = Buffer.alloc(0);
    this._pendingHdr     = null;
    this._resolve        = null;
    this._ledPayloads    = new Map();   // devIdx → Buffer
    this._dead           = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();
      this.socket.setKeepAlive(true, 5000);
      this.socket.connect(this.port, this.host, resolve);
      this.socket.on('error', (e) => {
        if (this._resolve) { const r = this._resolve; this._resolve = null; r({ hdr: null, data: null, error: e }); }
        reject(e);
      });
      this.socket.on('close', () => { this._dead = true; });
      this.socket.on('data',  d => this._onData(d));
    });
  }

  _onData(chunk) {
    // Avoid repeated Buffer.concat by using a pre-allocated ring-style approach:
    // only concat when we actually have a partial leftover, otherwise use chunk directly.
    const buf = this._buf.length === 0 ? chunk : Buffer.concat([this._buf, chunk]);
    let offset = 0;

    while (true) {
      if (!this._pendingHdr) {
        if (buf.length - offset < 16) break;
        this._pendingHdr = {
          devIdx : buf.readUInt32LE(offset + 4),
          id     : buf.readUInt32LE(offset + 8),
          size   : buf.readUInt32LE(offset + 12),
        };
        offset += 16;
      }
      if (buf.length - offset < this._pendingHdr.size) break;
      const data = buf.slice(offset, offset + this._pendingHdr.size);
      offset += this._pendingHdr.size;
      const hdr  = this._pendingHdr;
      this._pendingHdr = null;
      if (this._resolve) { const r = this._resolve; this._resolve = null; r({ hdr, data }); }
    }

    // Only retain the unconsumed tail — avoids accumulation
    this._buf = offset < buf.length ? buf.slice(offset) : Buffer.alloc(0);
  }

  _send(devIdx, pktId, data = Buffer.alloc(0)) {
    if (this._dead || !this.socket || this.socket.destroyed) return;
    try {
      if (!this._hdr) { this._hdr = Buffer.alloc(16); this._hdr.write('ORGB', 0, 'ascii'); }
      this._hdr.writeUInt32LE(devIdx, 4);
      this._hdr.writeUInt32LE(pktId, 8);
      this._hdr.writeUInt32LE(data.length, 12);
      this.socket.write(this._hdr);
      if (data.length > 0) this.socket.write(data);
    } catch (_) { this._dead = true; }
  }

  _request(devIdx, pktId, data) {
    return new Promise(resolve => { this._resolve = resolve; this._send(devIdx, pktId, data); });
  }

  async init() {
    this._send(0, PKT.SET_CLIENT_NAME, Buffer.from('SignalRGB-OpenRGB-Bridge\0'));
    const req = Buffer.alloc(4); req.writeUInt32LE(5, 0);
    const { data } = await this._request(0, PKT.REQUEST_PROTOCOL_VERSION, req);
    this.protocolVersion = data ? data.readUInt32LE(0) : 0;
    console.log(`[openrgb] protocol version: ${this.protocolVersion}`);
  }

  async getDeviceCount() {
    const { data } = await this._request(0, PKT.REQUEST_CONTROLLER_COUNT);
    return data ? data.readUInt32LE(0) : 0;
  }

  async getDevice(devIdx) {
    const req = Buffer.alloc(4); req.writeUInt32LE(this.protocolVersion, 0);
    const { data } = await this._request(devIdx, PKT.REQUEST_CONTROLLER_DATA, req);
    if (!data) return null;
    return this._parseDevice(data);
  }

  _parseDevice(buf) {
    let ptr = 4;
    const type = buf.readInt32LE(ptr); ptr += 4;
    let name, vendor, _d, _v, _s, _l;
    [name,  ptr] = readString(buf, ptr);
    [vendor,ptr] = readString(buf, ptr);
    [_d,    ptr] = readString(buf, ptr);
    [_v,    ptr] = readString(buf, ptr);
    [_s,    ptr] = readString(buf, ptr);
    [_l,    ptr] = readString(buf, ptr);

    const numModes = buf.readUInt16LE(ptr); ptr += 2;
    ptr += 4; // active_mode
    for (let m = 0; m < numModes; m++) {
      let _n; [_n, ptr] = readString(buf, ptr);
      ptr += 4 + 4 + 4 + 4;
      if (this.protocolVersion >= 3) ptr += 8;
      ptr += 4 + 4 + 4;
      if (this.protocolVersion >= 3) ptr += 4;
      ptr += 8;
      const nc = buf.readUInt16LE(ptr); ptr += 2 + nc * 4;
    }

    const numZones = buf.readUInt16LE(ptr); ptr += 2;
    const zones = [];
    for (let z = 0; z < numZones; z++) {
      let zName; [zName, ptr] = readString(buf, ptr);
      const zType     = buf.readInt32LE(ptr);  ptr += 4;
      ptr += 8; // leds_min, leds_max
      const ledsCount = buf.readUInt32LE(ptr); ptr += 4;
      const matLen    = buf.readUInt16LE(ptr); ptr += 2;

      let matrixMap = null;
      if (matLen > 0) {
        const h = buf.readUInt32LE(ptr); ptr += 4;
        const w = buf.readUInt32LE(ptr); ptr += 4;
        const map = [];
        for (let i = 0; i < h * w; i++) { map.push(buf.readUInt32LE(ptr)); ptr += 4; }
        matrixMap = { h, w, map };
      }
      if (this.protocolVersion >= 4) {
        const ns = buf.readUInt16LE(ptr); ptr += 2;
        for (let s = 0; s < ns; s++) {
          let _sn; [_sn, ptr] = readString(buf, ptr);
          ptr += 12;
        }
      }
      if (this.protocolVersion >= 5) ptr += 4;
      zones.push({ name: zName, type: zType, ledsCount, matrixMap });
    }

    let running = 0;
    for (const z of zones) { z.startIdx = running; running += z.ledsCount; }

    const numLeds = buf.readUInt16LE(ptr); ptr += 2;
    for (let l = 0; l < numLeds; l++) {
      let _ln; [_ln, ptr] = readString(buf, ptr);
      ptr += 4;
    }
    const numColors = buf.readUInt16LE(ptr);
    return { type, name, vendor, zones, numColors };
  }

  setCustomMode(devIdx) { this._send(devIdx, PKT.SETCUSTOMMODE); }

  allocLEDPayload(devIdx, numColors) {
    const buf = Buffer.alloc(4 + 2 + numColors * 4);
    buf.writeUInt32LE(buf.length, 0);
    buf.writeUInt16LE(numColors, 4);
    this._ledPayloads.set(devIdx, buf);
  }

  updateLEDs(devIdx, rgb) {
    if (this._dead) return;
    const n = rgb.length / 3;
    const p = this._ledPayloads.get(devIdx);
    if (!p) return;
    for (let i = 0; i < n; i++) {
      const b = 6 + i * 4;
      p[b] = rgb[i * 3]; p[b + 1] = rgb[i * 3 + 1]; p[b + 2] = rgb[i * 3 + 2];
    }
    this._send(devIdx, PKT.UPDATELEDS, p);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SECTION 3 — LED ↔ canvas position mapper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns two things:
 *  - positions: [{ledIndex, cx, cy, nx, ny}]  (nx/ny = normalized 0–1 within keyboard)
 *  - a rebuild(layout) function that recomputes cx/cy from a new layout region
 *
 * layout = {x, y, w, h} in canvas pixel coordinates.
 * Default layout = full canvas.
 */
function buildLEDPositions(zones, layout) {
  const L = layout || { x: 0, y: 0, w: CANVAS_W, h: CANVAS_H };
  const positions = [];

  for (const zone of zones) {
    if (zone.type === ZONE_TYPE.matrix && zone.matrixMap) {
      const { h, w, map } = zone.matrixMap;
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) {
          const ledIdx = map[row * w + col];
          if (ledIdx === NA) continue;
          const nx = col / Math.max(w - 1, 1);
          const ny = row / Math.max(h - 1, 1);
          const cx = Math.max(0, Math.min(CANVAS_W - 1, Math.round(L.x + nx * L.w)));
          const cy = Math.max(0, Math.min(CANVAS_H - 1, Math.round(L.y + ny * L.h)));
          positions.push({ ledIndex: ledIdx, cx, cy, nx, ny });
        }
      }
    } else if (zone.type === ZONE_TYPE.linear && zone.ledsCount > 0) {
      const ny = 0.5;
      for (let i = 0; i < zone.ledsCount; i++) {
        const nx = i / Math.max(zone.ledsCount - 1, 1);
        const cx = Math.max(0, Math.min(CANVAS_W - 1, Math.round(L.x + nx * L.w)));
        const cy = Math.max(0, Math.min(CANVAS_H - 1, Math.round(L.y + ny * L.h)));
        positions.push({ ledIndex: zone.startIdx + i, cx, cy, nx, ny });
      }
    } else if (zone.ledsCount === 1) {
      positions.push({ ledIndex: zone.startIdx, cx: Math.round(CANVAS_W / 2), cy: Math.round(CANVAS_H / 2), nx: 0.5, ny: 0.5 });
    }
  }
  return positions;
}

function rebuildPositions(positions, layout) {
  const L = layout || { x: 0, y: 0, w: CANVAS_W, h: CANVAS_H };
  for (const p of positions) {
    p.cx = Math.max(0, Math.min(CANVAS_W - 1, Math.round(L.x + p.nx * L.w)));
    p.cy = Math.max(0, Math.min(CANVAS_H - 1, Math.round(L.y + p.ny * L.h)));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SECTION 4 — SignalRGB HTML parser
// ─────────────────────────────────────────────────────────────────────────────

function parseEffectHTML(html) {
  const text = html.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Extract meta property defaults
  const metaDefaults = {};
  const metaRe = /<meta\b([^>]*\/?>)/gsi;
  let mb;
  while ((mb = metaRe.exec(text)) !== null) {
    const block = mb[1];
    const propM    = block.match(/property\s*=\s*"([^"]*)"/i);
    const defaultM = block.match(/default\s*=\s*"([^"]*)"/i);
    if (propM && defaultM) metaDefaults[propM[1]] = defaultM[1];
  }

  // Collect all INLINE script blocks (skip <script src="...">)
  // Pattern: <script> with no src attribute
  const scriptRe = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
  const candidates = [];
  let sm;
  while ((sm = scriptRe.exec(text)) !== null) {
    const content = sm[1].trim();
    if (!content || content.length < 50) continue;
    // Skip known tracking / analytics patterns
    if (content.startsWith('(function(){window[\'__CF')
     || content.includes('__CF$cv$params')
     || content.includes('google-analytics')
     || content.includes('gtag(')) continue;
    candidates.push(content);
  }

  if (candidates.length === 0) throw new Error('No effect script found in HTML file.');

  // Prefer the block that looks like an effect (mentions exCanvas, requestAnimationFrame or getContext)
  const effectScript =
    candidates.find(b => b.includes('exCanvas') || b.includes('getContext') || b.includes('requestAnimationFrame'))
    || candidates[candidates.length - 1];   // fallback: last block

  return { scriptSrc: effectScript, metaDefaults };
}

// ─────────────────────────────────────────────────────────────────────────────
//  SECTION 5 — Effect runner (vm sandbox)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compatibility matrix for SignalRGB effect patterns:
 *
 * ① Most effects: call window.requestAnimationFrame(update) or bare requestAnimationFrame(update)
 *   → Both forms intercepted; pendingRAF driven by our tick().
 *
 * ② setTimeout-internally-paced effects (e.g. Falling Stars):
 *   update() schedules a setTimeout that does the drawing, then calls rAF.
 *   → We intercept setTimeout with VIRTUAL timers (no real async).
 *     tick() fires expired virtual timers then the pending rAF.
 *     This puts ALL timing under our control, eliminating race conditions
 *     and preventing the effect from running its own parallel loop.
 *
 * ③ setInterval effects (e.g. Terminal):
 *   → Intercepted; callbacks fired each tick.
 *
 * ④ Meta globals: SignalRGB injects <meta property="foo" default="bar"> as
 *   a global var `foo = bar` in the script scope.
 *   → All metaDefaults spread into sandbox as top-level globals.
 */
function createEffectRunner(scriptSrc, metaDefaults) {
  const canvas = createCanvas(CANVAS_W, CANVAS_H);

  // rAF state
  let pendingRAF = null;

  // Virtual Timers State (Using Maps for O(1) clears and proper pacing)
  const virtualTimeouts = new Map();
  const virtualIntervals = new Map();
  let   nextVirtualTimerId = 1;

  const rafFn    = (cb) => { pendingRAF = cb; return 1; };
  const rafCanFn = ()   => { pendingRAF = null; };

  const mockWindow = {
    requestAnimationFrame: rafFn, cancelAnimationFrame: rafCanFn,
    innerWidth: CANVAS_W, innerHeight: CANVAS_H,
    screen: { width: CANVAS_W, height: CANVAS_H }, devicePixelRatio: 1,
    location: { href: '', hostname: 'localhost', search: '' },
    navigator: { userAgent: '' },
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => {},
  };

  const mockDocument = {
    getElementById: (id) => id === 'exCanvas' ? canvas : null,
    querySelector: (sel) => {
      const m = sel.match(/meta\[property="([^"]+)"\]/);
      if (!m) return null;
      const prop = m[1];
      return (prop in metaDefaults)
        ? { getAttribute: (a) => a === 'default' ? metaDefaults[prop] : null, addEventListener: () => {} }
        : null;
    },
  };

  // Coerce meta values: numeric strings → numbers (effects do arithmetic on them)
  const metaGlobals = {};
  for (const [k, v] of Object.entries(metaDefaults)) {
    const n = Number(v);
    metaGlobals[k] = (v !== '' && !isNaN(n)) ? n : v;
  }

  const _bea = [];
  const _backEffectsProxy = new Proxy(_bea, {
    get(t,p){if(p==='push')return(...a)=>{if(t.length<120)t.push(...a);};const v=t[p];return typeof v==='function'?v.bind(t):v;},
    set(t,p,v){t[p]=v;return true;}
  });

  const sandbox = {
    // Browser globals
    window:      mockWindow,
    document:    mockDocument,
    Math, parseInt, parseFloat, Number, String, Boolean, Array, Object,
    isNaN, isFinite, JSON,
    console: { ...console, log:()=>{}, info:()=>{}, debug:()=>{} },
    performance: { now: () => Date.now() },

    innerWidth: CANVAS_W, innerHeight: CANVAS_H,
    backEffects: _backEffectsProxy,
    Image: class Image { constructor(){this.src='';this.onload=null;this.onerror=null;} },
    Path2D: (()=>{try{return require('@napi-rs/canvas').Path2D;}catch(_){return class Path2D{};}})(),
    HTMLCanvasElement: class HTMLCanvasElement {},
    Audio: class Audio { constructor(){} play(){} pause(){} addEventListener(){} },
    Event: class Event { constructor(t){this.type=t;} },
    CustomEvent: class CustomEvent { constructor(t,o){this.type=t;this.detail=o&&o.detail;} },
    requestAnimationFrame:  rafFn,
    cancelAnimationFrame:   rafCanFn,

    // Your New Improved Virtual Timers
    setTimeout: (cb, ms) => {
      const id = nextVirtualTimerId++;
      if (virtualTimeouts.size < 500) { // Safety cap
        virtualTimeouts.set(id, { cb, fireAt: Date.now() + (ms || 0) });
      }
      return id;
    },
    clearTimeout: (id) => {
      virtualTimeouts.delete(id);
    },
    setInterval: (cb, ms) => {
      const id = nextVirtualTimerId++;
      if (virtualIntervals.size < 50) { // Safety cap
        virtualIntervals.set(id, { cb, ms: ms || 16, lastFired: Date.now() });
      }
      return id;
    },
    clearInterval: (id) => {
      virtualIntervals.delete(id);
    },

    // SignalRGB meta property globals
    ...metaGlobals,
  };

  try {
    vm.runInNewContext(scriptSrc, sandbox);
  } catch (e) {
    throw new Error(`Effect script error: ${e.message}`);
  }

  for (const [k, v] of Object.entries(metaGlobals)) sandbox[k] = v;

  const onCanvasTapped = typeof sandbox.onCanvasTapped === 'function'
    ? (...a) => { try { sandbox.onCanvasTapped(...a); } catch (_) {} }
    : null;

  // Updated tick function to handle the Maps and respect Interval delays
  function tick() {
    const now = Date.now();

    // 1. Process Timeouts safely (snapshot to prevent infinite immediate loop cascades)
    const timeoutsToFire = [];
    for (const [id, t] of virtualTimeouts.entries()) {
      if (t.fireAt <= now) {
        timeoutsToFire.push(t.cb);
        virtualTimeouts.delete(id);
      }
    }
    for (const cb of timeoutsToFire) {
      try { cb.call(sandbox, now); } catch (_) {}
    }

    // 2. Process requestAnimationFrame
    if (pendingRAF) {
      const cb = pendingRAF; 
      pendingRAF = null;
      try { cb.call(sandbox, now); } catch (_) {}
    }

    // 3. Process Intervals adhering to their requested ms pacing
    for (const [_, e] of virtualIntervals.entries()) {
      if (e.lastFired + e.ms <= now) {
        e.lastFired = now; 
        try { e.cb.call(sandbox, now); } catch (_) {}
      }
    }
  }

  return { canvas, tick, onCanvasTapped };
}
// ─────────────────────────────────────────────────────────────────────────────
//  SECTION 6 — Layout editor (HTTP server)
// ─────────────────────────────────────────────────────────────────────────────

function buildEditorHTML(scale, effectPath) {
  const W = CANVAS_W * scale, H = CANVAS_H * scale;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Bridge Layout Editor</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #111; color: #eee; font: 14px/1.4 monospace; display: flex; flex-direction: column; height: 100vh; }
  #top { display: flex; flex: 1; min-height: 0; }
  #preview-wrap {
    position: relative; width: ${W}px; height: ${H}px; flex-shrink: 0;
    border: 1px solid #333; overflow: hidden; cursor: crosshair;
  }
  iframe {
    width: ${CANVAS_W}px; height: ${CANVAS_H}px; border: none; display: block;
    transform: scale(${scale}); transform-origin: top left; pointer-events: none;
  }
  #overlay {
    position: absolute; inset: 0; pointer-events: none;
  }
  #region {
    position: absolute; border: 2px solid #00d4ff; background: transparent;
    pointer-events: all; cursor: move; user-select: none;
  }
  .handle {
    position: absolute; width: 10px; height: 10px; background: #00d4ff;
    border: 1px solid #fff; border-radius: 2px;
  }
  .handle[data-h="nw"] { top:-5px; left:-5px; cursor:nw-resize; }
  .handle[data-h="n"]  { top:-5px; left:calc(50% - 5px); cursor:n-resize; }
  .handle[data-h="ne"] { top:-5px; right:-5px; cursor:ne-resize; }
  .handle[data-h="e"]  { top:calc(50% - 5px); right:-5px; cursor:e-resize; }
  .handle[data-h="se"] { bottom:-5px; right:-5px; cursor:se-resize; }
  .handle[data-h="s"]  { bottom:-5px; left:calc(50% - 5px); cursor:s-resize; }
  .handle[data-h="sw"] { bottom:-5px; left:-5px; cursor:sw-resize; }
  .handle[data-h="w"]  { top:calc(50% - 5px); left:-5px; cursor:w-resize; }
  #dots-svg { position: absolute; inset: 0; pointer-events: none; }
  #sidebar {
    flex: 1; padding: 20px; display: flex; flex-direction: column; gap: 14px;
    overflow-y: auto; background: #181818; border-left: 1px solid #333;
  }
  h2 { color: #00d4ff; font-size: 16px; margin-bottom: 4px; }
  .row { display: flex; gap: 8px; align-items: center; }
  label { font-size: 12px; color: #aaa; width: 24px; flex-shrink: 0; }
  input[type=number] {
    background: #222; color: #eee; border: 1px solid #444; padding: 4px 6px;
    width: 70px; border-radius: 4px; font: inherit;
  }
  input[type=range] { width: 100%; accent-color: #00d4ff; }
  button {
    background: #00d4ff; color: #000; border: none; padding: 10px 18px;
    border-radius: 6px; cursor: pointer; font: bold 14px monospace; transition: opacity .15s;
  }
  button:hover { opacity: .85; }
  #status { font-size: 12px; color: #0f0; min-height: 18px; }
  #device-info { font-size: 12px; color: #888; }
  hr { border: none; border-top: 1px solid #333; }
  .tip { font-size: 11px; color: #666; line-height: 1.6; }
</style>
</head>
<body>
<div id="top">
  <div id="preview-wrap">
    <iframe id="fx" src="/effect"></iframe>
    <div id="overlay">
      <svg id="dots-svg" width="${W}" height="${H}"></svg>
      <div id="region">
        <div class="handle" data-h="nw"></div><div class="handle" data-h="n"></div>
        <div class="handle" data-h="ne"></div><div class="handle" data-h="e"></div>
        <div class="handle" data-h="se"></div><div class="handle" data-h="s"></div>
        <div class="handle" data-h="sw"></div><div class="handle" data-h="w"></div>
      </div>
    </div>
  </div>
  <div id="sidebar">
    <h2>Layout Editor</h2>
    <div id="device-info">Loading device info…</div>
    <hr>
    <p class="tip">Drag the blue rectangle to set which part of the effect canvas maps to your device's LEDs.<br>Cyan dots show each LED's sample position.</p>
    <hr>
    <div class="row">
      <label>X</label><input type="number" id="ix" min="0" max="${CANVAS_W}">
      <label>Y</label><input type="number" id="iy" min="0" max="${CANVAS_H}">
    </div>
    <div class="row">
      <label>W</label><input type="number" id="iw" min="1" max="${CANVAS_W}">
      <label>H</label><input type="number" id="ih" min="1" max="${CANVAS_H}">
    </div>
    <button id="btn-save">💾 Save Layout</button>
    <button id="btn-reset" style="background:#333;color:#eee">↺ Reset to full canvas</button>
    <div id="status"></div>
  </div>
</div>
<script>
const SCALE = ${scale}, CW = ${CANVAS_W}, CH = ${CANVAS_H};
const PW = ${W}, PH = ${H};

let region  = {x:0, y:0, w:CW, h:CH};
let leds    = [];
let dragging = null;

const regionEl = document.getElementById('region');
const svg      = document.getElementById('dots-svg');
const status   = document.getElementById('status');
const ix = document.getElementById('ix'), iy = document.getElementById('iy');
const iw = document.getElementById('iw'), ih = document.getElementById('ih');

// Load device info + current layout
Promise.all([
  fetch('/api/device').then(r=>r.json()),
  fetch('/api/layout').then(r=>r.json()),
  fetch('/api/leds').then(r=>r.json()),
]).then(([dev, layout, ledData]) => {
  document.getElementById('device-info').textContent =
    dev.name + ' — ' + dev.numColors + ' LEDs';
  region = {...layout};
  leds = ledData;
  syncInputs();
  updateVisuals();
}).catch(e => {
  document.getElementById('device-info').textContent = 'Could not load device: ' + e.message;
});

function syncInputs() {
  ix.value = Math.round(region.x); iy.value = Math.round(region.y);
  iw.value = Math.round(region.w); ih.value = Math.round(region.h);
}
function syncFromInputs() {
  region.x = Math.max(0, Math.min(CW-1, +ix.value||0));
  region.y = Math.max(0, Math.min(CH-1, +iy.value||0));
  region.w = Math.max(1, Math.min(CW - region.x, +iw.value||1));
  region.h = Math.max(1, Math.min(CH - region.y, +ih.value||1));
  updateVisuals();
}
[ix,iy,iw,ih].forEach(el => el.addEventListener('input', syncFromInputs));

function updateVisuals() {
  // Position the region div (in display px)
  regionEl.style.left   = (region.x * SCALE) + 'px';
  regionEl.style.top    = (region.y * SCALE) + 'px';
  regionEl.style.width  = (region.w * SCALE) + 'px';
  regionEl.style.height = (region.h * SCALE) + 'px';

  // Draw LED dots
  svg.innerHTML = '';
  for (const led of leds) {
    const cx = (region.x + led.nx * region.w) * SCALE;
    const cy = (region.y + led.ny * region.h) * SCALE;
    const c = document.createElementNS('http://www.w3.org/2000/svg','circle');
    c.setAttribute('cx', cx); c.setAttribute('cy', cy);
    c.setAttribute('r', 3); c.setAttribute('fill', '#00ffcc');
    c.setAttribute('fill-opacity', '0.7');
    svg.appendChild(c);
  }
}

// ── Drag & resize ────────────────────────────────────────────────────────────
const wrap = document.getElementById('preview-wrap');

function startDrag(e, type) {
  e.preventDefault();
  const startX = e.clientX, startY = e.clientY;
  const r0 = {...region};
  dragging = {type, startX, startY, r0};
}

regionEl.addEventListener('mousedown', e => {
  if (e.target.classList.contains('handle')) return;
  startDrag(e, 'move');
});
regionEl.querySelectorAll('.handle').forEach(h => {
  h.addEventListener('mousedown', e => { e.stopPropagation(); startDrag(e, h.dataset.h); });
});

document.addEventListener('mousemove', e => {
  if (!dragging) return;
  const dx = (e.clientX - dragging.startX) / SCALE;
  const dy = (e.clientY - dragging.startY) / SCALE;
  const r0 = dragging.r0;
  let {x, y, w, h} = r0;

  if (dragging.type === 'move') {
    x = Math.max(0, Math.min(CW - w, r0.x + dx));
    y = Math.max(0, Math.min(CH - h, r0.y + dy));
  } else {
    const t = dragging.type;
    if (t.includes('e')) { w = Math.max(1, Math.min(CW - x, r0.w + dx)); }
    if (t.includes('s')) { h = Math.max(1, Math.min(CH - y, r0.h + dy)); }
    if (t.includes('w')) { const nx = r0.x + dx; w = Math.max(1, r0.w - (nx - r0.x)); x = Math.max(0, Math.min(r0.x + r0.w - 1, nx)); }
    if (t.includes('n')) { const ny = r0.y + dy; h = Math.max(1, r0.h - (ny - r0.y)); y = Math.max(0, Math.min(r0.y + r0.h - 1, ny)); }
  }
  region = {x, y, w, h};
  syncInputs();
  updateVisuals();
});

document.addEventListener('mouseup', () => { dragging = null; });

// ── Save / reset ─────────────────────────────────────────────────────────────
document.getElementById('btn-save').addEventListener('click', () => {
  fetch('/api/layout', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({x: region.x, y: region.y, w: region.w, h: region.h}),
  }).then(r => r.json()).then(d => {
    status.textContent = '✓ Saved to ' + d.file;
    status.style.color = '#0f0';
  }).catch(e => {
    status.textContent = '✗ Save failed: ' + e.message;
    status.style.color = '#f44';
  });
});

document.getElementById('btn-reset').addEventListener('click', () => {
  region = {x:0, y:0, w:CW, h:CH};
  syncInputs(); updateVisuals();
  status.textContent = 'Reset (not yet saved)';
  status.style.color = '#aaa';
});
</script>
</body>
</html>`;
}

function startLayoutEditor(opts, effectPath, device, ledPositions) {
  const layoutFile = opts.layout || path.join(path.dirname(effectPath), 'layout.json');
  const SCALE = 3;

  function loadLayout() {
    if (fs.existsSync(layoutFile)) {
      try { return JSON.parse(fs.readFileSync(layoutFile, 'utf8')); } catch (_) {}
    }
    return { x: 0, y: 0, w: CANVAS_W, h: CANVAS_H };
  }

  const editorHTML = buildEditorHTML(SCALE, effectPath);

  const server = http.createServer((req, res) => {
    const [url] = req.url.split('?');

    if (req.method === 'GET' && url === '/') {
      res.writeHead(200, {'Content-Type': 'text/html'}); res.end(editorHTML); return;
    }
    if (req.method === 'GET' && url === '/effect') {
      // Inject a full-page canvas + SignalRGB compatibility shim so the effect
      // actually renders. Most SignalRGB effects expect:
      //   • A <canvas id="exCanvas"> filling the viewport
      //   • window.requestAnimationFrame available (standard browser — always true)
      //   • Meta <property> defaults already in window scope as JS globals
      //   • No "module" errors from missing SignalRGB SDK globals
      //
      // We prepend a shim <script> that:
      //   1. Creates and sizes #exCanvas to fill the page
      //   2. Seeds meta-default globals so effects that read them don't get NaN
      //   3. Stubs the few SignalRGB SDK calls some effects make (e.g. signal.*)
      const rawHtml = fs.readFileSync(effectPath, 'utf8');

      // Collect meta defaults from the effect HTML so we can seed globals
      const metaGlobalsJs = [];
      const metaRe2 = /<meta\b([^>]*\/?>)/gsi;
      let mb2;
      while ((mb2 = metaRe2.exec(rawHtml)) !== null) {
        const block = mb2[1];
        const propM    = block.match(/property\s*=\s*"([^"]*)"/i);
        const defaultM = block.match(/default\s*=\s*"([^"]*)"/i);
        if (propM && defaultM) {
          const k = propM[1].replace(/[^a-zA-Z0-9_$]/g, '_');
          const raw = defaultM[1].replace(/\\/g, '\\\\').replace(/'/g, "\\'");
          const n = Number(defaultM[1]);
          const val = (defaultM[1] !== '' && !isNaN(n)) ? n : `'${raw}'`;
          metaGlobalsJs.push(`  try { if (typeof ${k} === 'undefined') window.${k} = ${val}; } catch(_) {}`);
        }
      }

      const shim = `<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#000; overflow:hidden; width:100vw; height:100vh; }
  canvas#exCanvas { display:block; width:100%; height:100%; }
</style>
<canvas id="exCanvas"></canvas>
<script>
(function() {
  // Size the canvas to the viewport (SignalRGB uses a fixed internal resolution
  // but effects look fine scaled via CSS)
  var c = document.getElementById('exCanvas');
  c.width  = ${CANVAS_W};
  c.height = ${CANVAS_H};

  // Seed meta-property globals so effects that read them don't get NaN/undefined
${metaGlobalsJs.join('\n')}

  // Stub SignalRGB SDK globals that some effects reference
  window.signal = window.signal || {
    on: function() {},
    off: function() {},
    emit: function() {},
  };
  // Some effects call these directly
  window.LightingController = window.LightingController || { Devices: [] };
})();
</script>`;

      // Insert shim right after <head> (or prepend to <body>, or just before first <script>)
      let injected = rawHtml;
      if (/<head[^>]*>/i.test(injected)) {
        injected = injected.replace(/(<head[^>]*>)/i, `$1\n${shim}`);
      } else if (/<body[^>]*>/i.test(injected)) {
        injected = injected.replace(/(<body[^>]*>)/i, `$1\n${shim}`);
      } else {
        injected = shim + '\n' + injected;
      }

      res.writeHead(200, {'Content-Type': 'text/html'}); res.end(injected); return;
    }
    if (req.method === 'GET' && url === '/api/device') {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ name: device.name, numColors: device.numColors })); return;
    }
    if (req.method === 'GET' && url === '/api/layout') {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify(loadLayout())); return;
    }
    if (req.method === 'GET' && url === '/api/leds') {
      // Return normalized LED positions (nx, ny in 0–1 range)
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify(ledPositions.map(p => ({ nx: p.nx, ny: p.ny }))));
      return;
    }
    if (req.method === 'POST' && url === '/api/layout') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        try {
          const layout = JSON.parse(body);
          fs.writeFileSync(layoutFile, JSON.stringify(layout, null, 2));
          res.writeHead(200, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({ ok: true, file: layoutFile }));
          console.log(`\n[editor]  layout saved to ${layoutFile}`);
          console.log(`[editor]  restart bridge with:  --layout ${layoutFile}`);
        } catch (e) {
          res.writeHead(400); res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    res.writeHead(404); res.end();
  });

  server.listen(opts.editorPort, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${opts.editorPort}`;
    console.log(`[editor]  layout editor running at ${url}`);
    // Try to open browser (Linux/macOS/Windows)
    const opener = process.platform === 'darwin' ? 'open'
                 : process.platform === 'win32'  ? 'start'
                 : 'xdg-open';
    try { spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref(); } catch (_) {}
    console.log(`[editor]  open ${url} if the browser didn't launch automatically`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  SECTION 6b — Hyprland IPC keypress listener
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Connects to the Hyprland event socket2 and fires onCanvasTapped on every
 * keypress event. This works globally — no focus required.
 *
 * Hyprland emits on $XDG_RUNTIME_DIR/hypr/$HYPRLAND_INSTANCE_SIGNATURE/.socket2.sock
 * Events are newline-delimited ASCII: "eventname>>data\n"
 *
 * Key events:
 *   "key>>keycode"        — key pressed (fired on every keydown)
 *   "keyup>>keycode"      — key released
 * (NOT "keypress>>" — that was the wrong name)
 *
 * Auto-discovery: if HYPRLAND_INSTANCE_SIGNATURE is not set (e.g. running via
 * systemd, disown, or a clean-env daemon) the function scans the hypr runtime
 * dir and uses the first .socket2.sock it finds.  This means you don't need to
 * forward env vars when launching as a service.
 */



function startEvdevListener(devPath, onCanvasTapped) {
  if (!onCanvasTapped) return;
  const EV_KEY = 0x01, EVT_SZ = 24;

  function open(p) {
    let fd;
    try { fd = fs.openSync(p, 'r'); } catch(e) {
      console.warn('[evdev]   cannot open', p, '-', e.message);
      console.warn('[evdev]   run: sudo usermod -aG input $USER  then re-login');
      return;
    }
    console.log('[evdev]   listening on', p);
    const buf = Buffer.alloc(EVT_SZ);
    (function read() {
      fs.read(fd, buf, 0, EVT_SZ, null, (err, n) => {
        if (err || n === 0) {
          try { fs.closeSync(fd); } catch(_) {}
          setTimeout(() => open(p), 3000);
          return;
        }
        if (buf.readUInt16LE(8) === EV_KEY && buf.readInt32LE(20) === 1)
          onCanvasTapped(0, 0);
        read();
      });
    })();
  }

  if (devPath !== 'auto') { open(devPath); return; }

  try {
    const info = fs.readFileSync('/proc/bus/input/devices', 'utf8');
    for (const block of info.split('\n\n')) {
      if (!block.match(/Handlers=.*kbd/i) && !block.match(/Name=.*[Kk]eyboard/)) continue;
      const m = block.match(/Handlers=[^\n]*event(\d+)/);
      if (m) { open('/dev/input/event' + m[1]); return; }
    }
  } catch(_) {}
  console.warn('[evdev]   auto-detect failed — try --evdev /dev/input/eventX');
}

function startTapSocket(socketPath, ledPositions, onCanvasTapped) {
  if (!onCanvasTapped) return;

  // Remove stale socket file if it exists
  try { fs.unlinkSync(socketPath); } catch (_) {}

  const srv = net.createServer(conn => {
    conn.on('data', data => {
      const msg = data.toString().trim();
      // Accept "x,y" for specific position, or anything else → random LED
      const parts = msg.split(',');
      if (parts.length === 2 && !isNaN(+parts[0]) && !isNaN(+parts[1])) {
        onCanvasTapped(+parts[0], +parts[1]);
      } else {
        const p = ledPositions[Math.floor(Math.random() * ledPositions.length)];
        if (p) onCanvasTapped(p.cx, p.cy);
      }
    });
    conn.on('error', () => {});
  });

  srv.on('error', (e) => { console.warn(`[tap]     socket error: ${e.message}`); });
  srv.listen(socketPath, () => {
    console.log(`[tap]     keypress socket: ${socketPath}`);
    console.log(`[tap]     trigger from anywhere (terminal, keybind, script):`);
    console.log(`[tap]       echo "tap"      | nc -U ${socketPath}`);
    console.log(`[tap]       echo "120,60"   | nc -U ${socketPath}   # specific x,y`);
    console.log(`[tap]     add to Hyprland config to fire on every keypress:`);
    console.log(`[tap]       bind = , catchall, exec, echo "tap" | nc -U ${socketPath}`);
    console.log(`[tap]     or use --hyprland-keys flag (auto-connects to Hyprland IPC)`);
  });

  // Cleanup on exit
  process.on('exit', () => { try { fs.unlinkSync(socketPath); } catch (_) {} });
  return srv;
}

// ─────────────────────────────────────────────────────────────────────────────
//  SECTION 8 — Main
// ─────────────────────────────────────────────────────────────────────────────

async function connectWithRetry(host, port, reconnect) {
  while (true) {
    const client = new OpenRGBClient(host, port);
    try {
      await client.connect();
      await client.init();
      return client;
    } catch (e) {
      if (!reconnect) throw e;
      console.warn(`[openrgb] connection failed (${e.message}), retrying in 5s…`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv);

  if (!opts.effect) {
    console.error([
      '',
      '  Usage: node bridge.js <effect.html> [flags]',
      '',
      '  Common flags:',
      '    --fps 30            Render frame rate (default: 30)',
      '    --effect-fps 90     Effect native fps for animation pacing (default: 90)',
      '    --mouse             Also light up mouse',
      '    --all-devices       All connected devices',
      '    --layout file.json  Custom LED region',
      '    --layout-editor     Open layout editor UI',
      '    --reconnect         Auto-reconnect on OpenRGB disconnect',
      '',
    ].join('\n'));
    process.exit(1);
  }

  const effectPath = path.resolve(opts.effect);
  if (!fs.existsSync(effectPath)) {
    console.error(`[error]   File not found: ${effectPath}`); process.exit(1);
  }

  // ── Parse effect ───────────────────────────────────────────────────────────
  console.log(`[effect]  loading: ${path.basename(effectPath)}`);
  const html = fs.readFileSync(effectPath, 'utf8');
  const { scriptSrc, metaDefaults } = parseEffectHTML(html);
  console.log(`[effect]  parameters: ${JSON.stringify(metaDefaults)}`);

  // ── Connect to OpenRGB ────────────────────────────────────────────────────
  console.log(`[openrgb] connecting to ${opts.host}:${opts.port} …`);
  let client;
  try {
    client = await connectWithRetry(opts.host, opts.port, opts.reconnect);
  } catch (e) {
    console.error(`[openrgb] connection failed: ${e.message}`);
    console.error(`          Make sure OpenRGB is open and SDK server is enabled (Settings → SDK Server).`);
    process.exit(1);
  }

  const count = await client.getDeviceCount();
  console.log(`[openrgb] ${count} device(s) found`);

  // ── Enumerate and select devices ──────────────────────────────────────────
  const allDevices = [];
  for (let i = 0; i < count; i++) {
    const d = await client.getDevice(i);
    if (!d) continue;
    allDevices.push({ devIdx: i, device: d });
    const typeName = Object.keys(DEVICE_TYPE).find(k => DEVICE_TYPE[k] === d.type) || `type${d.type}`;
    console.log(`[openrgb]   [${i}] ${d.name} (${typeName})`);
  }

  let targets = [];
  if (opts.allDevices) {
    targets = allDevices;
  } else {
    // Always include the keyboard (or forced device index)
    if (opts.deviceIndex !== null) {
      const found = allDevices.find(e => e.devIdx === opts.deviceIndex);
      if (!found) { console.error(`[error]   Device index ${opts.deviceIndex} not found`); process.exit(1); }
      targets.push(found);
    } else {
      const kb = allDevices.find(e => e.device.type === DEVICE_TYPE.keyboard);
      if (kb) { targets.push(kb); console.log(`[openrgb] auto-selected keyboard: [${kb.devIdx}] ${kb.device.name}`); }
    }
    // Additional device types from flags
    for (const typeName of opts.extraTypes) {
      const typeId = DEVICE_TYPE[typeName];
      const found  = allDevices.find(e => e.device.type === typeId && !targets.includes(e));
      if (found) { targets.push(found); console.log(`[openrgb] also targeting ${typeName}: [${found.devIdx}] ${found.device.name}`); }
      else       { console.warn(`[openrgb] no ${typeName} found`); }
    }
  }

  if (targets.length === 0) {
    console.error('[error]   No target devices found. Use a device index or --all-devices.');
    process.exit(1);
  }

  // ── Load layout ────────────────────────────────────────────────────────────
  let layout = null;
  if (opts.layout) {
    try {
      layout = JSON.parse(fs.readFileSync(opts.layout, 'utf8'));
      console.log(`[layout]  loaded from ${opts.layout}: ${JSON.stringify(layout)}`);
    } catch (e) {
      console.warn(`[layout]  failed to load ${opts.layout}: ${e.message}, using full canvas`);
    }
  }

  // ── Build per-device LED position data ───────────────────────────────────
  const RADIUS = opts.sampleRadius;
  const deviceContexts = targets.map(({ devIdx, device }) => {
    const positions = buildLEDPositions(device.zones, layout);
    if (positions.length === 0) {
      console.warn(`[openrgb] warning: no LED positions mapped for ${device.name}`);
    }
    console.log(`[openrgb] [${devIdx}] ${device.name}: ${positions.length}/${device.numColors} LEDs mapped`);

    client.setCustomMode(devIdx);

    // Pre-allocate per-device LED payload and sample offsets
    client.allocLEDPayload(devIdx, device.numColors);

    const sampleOffsets = positions.map(({ cx, cy }) => {
      const offs = [];
      if (RADIUS === 0) {
        offs.push((cy * CANVAS_W + cx) * 4);
      } else {
        for (let dy = -RADIUS; dy <= RADIUS; dy++) {
          for (let dx = -RADIUS; dx <= RADIUS; dx++) {
            const x = cx + dx, y = cy + dy;
            if (x >= 0 && x < CANVAS_W && y >= 0 && y < CANVAS_H)
              offs.push((y * CANVAS_W + x) * 4);
          }
        }
      }
      return new Int32Array(offs);
    });

    const ledIndices = new Int32Array(positions.map(p => p.ledIndex));
    const colorBuf = new Uint8Array(device.numColors * 3);
    const prevColorBuf = new Uint8Array(device.numColors * 3);
    return { devIdx, device, positions, sampleOffsets, ledIndices, colorBuf, prevColorBuf };
  });

  // ── Layout editor mode ────────────────────────────────────────────────────
  if (opts.layoutEditor) {
    const primaryDevice = targets[0];
    startLayoutEditor(opts, effectPath, primaryDevice.device, deviceContexts[0].positions);
    console.log('[editor]  editor mode — frame loop not started');
    console.log('[editor]  Save layout then restart bridge without --layout-editor\n');
    return; // Don't start the frame loop in editor mode
  }

  // ── Start effect runner ───────────────────────────────────────────────────
  let runner;
  try {
    runner = createEffectRunner(scriptSrc, metaDefaults);
  } catch (e) {
    console.error(`[effect]  ${e.message}`);
    process.exit(1);
  }
  const { canvas, tick, onCanvasTapped } = runner;
  const ctx = canvas.getContext('2d');

  // ── Tap socket (keypress injection) ───────────────────────────────────────
  startTapSocket(opts.tapSocket, deviceContexts[0].positions, onCanvasTapped);

  if (opts.evdev) startEvdevListener(opts.evdev, onCanvasTapped);

  // ── Stdin keypress (bonus: also works when in a real terminal) ────────────
  if (onCanvasTapped && process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', key => {
        if (key === '\u0003') { process.emit('SIGINT'); return; }
        const pos = deviceContexts[0].positions[Math.floor(Math.random() * deviceContexts[0].positions.length)];
        if (pos) onCanvasTapped(pos.cx, pos.cy);
      });
      process.stdin.on('error', () => {}); // Don't crash if stdin closes
      console.log('[bridge]  stdin tap-effect enabled (press keys)');
    } catch (_) {
      // Raw mode unavailable (non-TTY terminal, tmux, etc.) — tap socket is the fallback
    }
  }

  // ── Reconnect watchdog ────────────────────────────────────────────────────
  if (opts.reconnect) {
    setInterval(async () => {
      if (client._dead) {
        console.warn('\n[openrgb] connection lost, reconnecting…');
        try {
          client = await connectWithRetry(opts.host, opts.port, true);
          for (const dc of deviceContexts) {
            client.setCustomMode(dc.devIdx);
            client.allocLEDPayload(dc.devIdx, dc.device.numColors);
          }
          console.log('[openrgb] reconnected');
        } catch (_) {}
      }
    }, 3000);
  }

  // ── Frame loop ────────────────────────────────────────────────────────────
  const FRAME_MS    = 1000 / opts.fps;
  // How many effect ticks to advance per rendered frame so animation speed
  // matches the original effectFps cadence (default 90) even at lower render fps.
  // Non-integer multipliers are handled stochastically to avoid drift.
  const TICK_RATIO  = opts.effectFps / opts.fps;
  let tickAccum     = 0;

  let running = true, nextAt = Date.now();
  let frameCount = 0, lastFPS = Date.now();

  console.log(`[bridge]  ${targets.length} device(s) | render ${opts.fps} fps | effect ${opts.effectFps} fps (×${TICK_RATIO.toFixed(2)} ticks/frame) | radius ${RADIUS} | Ctrl+C to stop`);
  if (TICK_RATIO > 1) {
    console.log(`[bridge]  tip: canvas draws once/frame (timer ticks still ×${TICK_RATIO.toFixed(1)})`);
    console.log(`[bridge]  tip: reduce CPU on slow hardware → --fps 20 --effect-fps 20`);
  }
  console.log('');

  // Pre-allocate a reusable pixel buffer (320×200×4 = 256 KB).
  // @napi-rs/canvas getImageData always returns a new ImageData object, but the
  // underlying pixel bytes are copied into our buffer with set(), so we avoid
  // creating a new large typed array on the GC heap every frame.
  const pixelBuf = new Uint8ClampedArray(CANVAS_W * CANVAS_H * 4);

  function renderFrame() {
    if (!running) return;
    nextAt += FRAME_MS;
    if (nextAt < Date.now()) nextAt = Date.now();

    // Advance N ticks per frame to match effectFps pacing; rAF fires every tick.
    tickAccum += TICK_RATIO;
    const ticks = Math.floor(tickAccum);
    tickAccum -= ticks;
    for (let t = 0; t < ticks; t++) tick();
    ctx.beginPath();
    // Copy canvas pixels into our reusable buffer — avoids a 256 KB GC allocation per frame.
    const frameImageData = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H);
    pixelBuf.set(frameImageData.data);
    const pixels = pixelBuf;

    // Sample and send for each device
    for (const dc of deviceContexts) {
      const { devIdx, device, sampleOffsets, ledIndices, colorBuf, prevColorBuf } = dc;
      colorBuf.fill(0);

      for (let i = 0; i < ledIndices.length; i++) {
        const li = ledIndices[i];
        if (li >= device.numColors) continue;
        const offs = sampleOffsets[i];
        let bestR = 0, bestG = 0, bestB = 0, bestL = -1;
        for (let j = 0; j < offs.length; j++) {
          const po = offs[j];
          const l  = pixels[po] + pixels[po + 1] + pixels[po + 2];
          if (l > bestL) { bestL = l; bestR = pixels[po]; bestG = pixels[po+1]; bestB = pixels[po+2]; }
        }
        const rgb = li * 3;
        colorBuf[rgb] = bestR; colorBuf[rgb+1] = bestG; colorBuf[rgb+2] = bestB;
      }

      let dirty = false;
      for (let b = 0; b < colorBuf.length; b++) { if (colorBuf[b] !== prevColorBuf[b]) { dirty = true; break; } }
      if (dirty) { prevColorBuf.set(colorBuf); client.updateLEDs(devIdx, colorBuf); }
    }

    frameCount++;
    const now = Date.now();
    if (now - lastFPS >= 5000) {
      process.stdout.write(`\r[bridge]  ${(frameCount / ((now - lastFPS) / 1000)).toFixed(1)} fps actual`);
      frameCount = 0; lastFPS = now;
    }

    setTimeout(renderFrame, Math.max(0, nextAt - Date.now()));
  }

  renderFrame();

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP',  shutdown);

  function shutdown() {
    running = false;
    console.log('\n[bridge]  shutting down…');
    for (const dc of deviceContexts) {
      dc.colorBuf.fill(0);
      client.updateLEDs(dc.devIdx, dc.colorBuf);
    }
    setTimeout(() => { try { client.socket.destroy(); } catch (_) {} process.exit(0); }, 150);
  }
}

main().catch(e => { console.error('[fatal]', e.message); process.exit(1); });
