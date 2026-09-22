/**
 * dxf.js — 自寫的 ASCII DXF 解析器 + 幾何彙總。
 *
 * 為什麼不用現成套件：算量的每一個數字都要能追溯到「哪一條線、哪一層」，
 * 解析層自己掌握才能把 bulge 弧長、封閉判定、圖塊展開的假設寫清楚並被稽核。
 *
 * 支援：LINE / LWPOLYLINE(含 bulge) / POLYLINE+VERTEX / CIRCLE / ARC / ELLIPSE(近似)
 *      / SOLID / 3DFACE / POINT / TEXT / MTEXT / INSERT(圖塊遞迴展開) / DIMENSION(取實測值)
 * 不支援：SPLINE 精確弧長（以控制點折線近似並標記）、HATCH 面積（僅計數）、二進位 DXF。
 */

import * as ENC from './encoding.js';

const NUMERIC = (c) =>
  (c >= 10 && c <= 59) || (c >= 110 && c <= 149) || (c >= 210 && c <= 239) ||
  (c >= 460 && c <= 469) || (c >= 1010 && c <= 1059);
const INT = (c) =>
  (c >= 60 && c <= 79) || (c >= 90 && c <= 99) || (c >= 170 && c <= 179) ||
  (c >= 270 && c <= 289) || (c >= 370 && c <= 389) || (c >= 400 && c <= 409) ||
  (c >= 420 && c <= 429) || (c >= 440 && c <= 459) || (c >= 1060 && c <= 1071);

/** $INSUNITS → 公尺換算係數。 */
export const INSUNITS = {
  0: { name: '未定義', toM: null }, 1: { name: '英吋', toM: 0.0254 }, 2: { name: '英呎', toM: 0.3048 },
  3: { name: '英里', toM: 1609.344 }, 4: { name: '公厘', toM: 0.001 }, 5: { name: '公分', toM: 0.01 },
  6: { name: '公尺', toM: 1 }, 7: { name: '公里', toM: 1000 }, 8: { name: '微英吋', toM: 2.54e-8 },
  9: { name: '密耳', toM: 2.54e-5 }, 10: { name: '碼', toM: 0.9144 }, 11: { name: '埃', toM: 1e-10 },
  12: { name: '奈米', toM: 1e-9 }, 13: { name: '微米', toM: 1e-6 }, 14: { name: '公寸', toM: 0.1 },
  15: { name: '公丈', toM: 10 }, 16: { name: '百公尺', toM: 100 },
};

export function isBinaryDxf(buf) {
  const head = new Uint8Array(buf.slice(0, 22));
  return String.fromCharCode(...head).startsWith('AutoCAD Binary DXF');
}

/** 讀取 DWG 檔頭版本標記（AC1015…），用來給使用者精準的轉檔指引。 */
export const DWG_VERSIONS = {
  AC1009: 'R11/R12', AC1012: 'R13', AC1014: 'R14', AC1015: 'AutoCAD 2000',
  AC1018: 'AutoCAD 2004', AC1021: 'AutoCAD 2007', AC1024: 'AutoCAD 2010',
  AC1027: 'AutoCAD 2013', AC1032: 'AutoCAD 2018+',
};
export function dwgVersion(buf) {
  const sig = String.fromCharCode(...new Uint8Array(buf.slice(0, 6)));
  return { sig, name: DWG_VERSIONS[sig] || null };
}

/** 把 DXF 文字切成 (code, value) 對。 */
function* pairs(text) {
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const raw = lines[i].trim();
    if (raw === '') { i -= 1; continue; }      // 容忍空行錯位
    const code = parseInt(raw, 10);
    if (Number.isNaN(code)) continue;
    const v = lines[i + 1];
    if (code === 999) continue;                 // 註解
    yield [code, NUMERIC(code) ? parseFloat(v) : INT(code) ? parseInt(v, 10) : (v == null ? '' : v.trim())];
  }
}

/** 把一串 pair 收成 record：重複的 code 收成陣列，並保留出現順序供頂點還原。 */
function collect(list) {
  const rec = { _order: [] };
  for (const [c, v] of list) {
    rec._order.push([c, v]);
    if (c in rec) { if (Array.isArray(rec[c])) rec[c].push(v); else rec[c] = [rec[c], v]; }
    else rec[c] = v;
  }
  return rec;
}
const one = (rec, c, d) => { const v = rec[c]; return Array.isArray(v) ? v[0] : (v === undefined ? d : v); };

/** LWPOLYLINE：依 _order 還原「10,20(,42)」的頂點序列，bulge 才會綁到正確的邊。 */
function lwVertices(rec) {
  const pts = [];
  for (const [c, v] of rec._order) {
    if (c === 10) pts.push({ x: v, y: 0, bulge: 0 });
    else if (c === 20 && pts.length) pts[pts.length - 1].y = v;
    else if (c === 42 && pts.length) pts[pts.length - 1].bulge = v;
  }
  return pts;
}

export function parseDxf(text) {
  const it = pairs(text);
  const header = {}; const layers = {}; const blocks = {}; const entities = [];
  const warnings = [];
  let section = null; let pending = null; let pendingType = null; let target = entities;
  let currentBlock = null; let polyline = null; let tableType = null;

  const flush = () => {
    if (!pending) return;
    const rec = collect(pending);
    const e = normalize(pendingType, rec, warnings);
    pending = null; pendingType = null;
    if (!e) return;
    if (polyline && e.type === 'VERTEX') { polyline.pts.push(e.pt); return; }
    if (polyline && e.type === 'SEQEND') {
      const p = polyline; polyline = null;
      if (p.pts.length >= 2) target.push({ type: 'POLYLINE', layer: p.layer, pts: p.pts, closed: p.closed });
      return;
    }
    if (e.type === '_POLYHDR') { polyline = { layer: e.layer, closed: e.closed, pts: [] }; return; }
    if (e.type === 'VERTEX' || e.type === 'SEQEND') return;
    if (e.type === '_LAYER') { layers[e.name] = { name: e.name, color: e.color, frozen: e.frozen }; return; }
    target.push(e);
  };

  for (const [c, v] of it) {
    if (c === 0) {
      flush();
      if (v === 'SECTION') { pendingType = '_SECTION'; pending = []; continue; }
      if (v === 'ENDSEC') { section = null; target = entities; currentBlock = null; polyline = null; continue; }
      if (v === 'EOF') break;
      if (section === 'BLOCKS' && v === 'BLOCK') { pendingType = '_BLOCK'; pending = []; continue; }
      if (section === 'BLOCKS' && v === 'ENDBLK') { currentBlock = null; target = entities; continue; }
      if (section === 'TABLES' && v === 'TABLE') { pendingType = '_TABLE'; pending = []; continue; }
      if (section === 'TABLES' && v === 'ENDTAB') { tableType = null; continue; }
      if (section === 'TABLES') { pendingType = v === 'LAYER' ? '_LAYER' : '_SKIP'; pending = []; continue; }
      if (section === 'HEADER') { pendingType = '_SKIP'; pending = []; continue; }
      pendingType = v; pending = [];
      continue;
    }
    if (pendingType === '_SECTION' && c === 2) {
      section = v; pending = null; pendingType = null;
      target = section === 'ENTITIES' ? entities : [];   // 只有 ENTITIES 段進模型空間
      continue;
    }
    if (pendingType === '_TABLE' && c === 2) { tableType = v; pending = null; pendingType = null; continue; }
    if (section === 'HEADER' && pendingType === '_SKIP') { continue; }
    if (pending) pending.push([c, v]);
  }
  flush();

  // HEADER 變數需要獨立掃描（$VAR 是 code 9）
  const hm = text.match(/^\s*9\s*\r?\n\s*\$INSUNITS\s*\r?\n\s*70\s*\r?\n\s*(-?\d+)/m);
  header.$INSUNITS = hm ? parseInt(hm[1], 10) : 0;
  const ex = text.match(/\$EXTMIN\s*\r?\n\s*10\s*\r?\n\s*(-?[\d.eE+]+)\s*\r?\n\s*20\s*\r?\n\s*(-?[\d.eE+]+)/);
  const ey = text.match(/\$EXTMAX\s*\r?\n\s*10\s*\r?\n\s*(-?[\d.eE+]+)\s*\r?\n\s*20\s*\r?\n\s*(-?[\d.eE+]+)/);
  if (ex && ey) header.extents = { minX: +ex[1], minY: +ex[2], maxX: +ey[1], maxY: +ey[2] };

  // BLOCKS：第二次掃描，把 BLOCK 內容切出來（結構單純，分兩趟比在單趟裡塞狀態機可靠）
  parseBlocks(text, blocks, warnings);

  return { header, layers, blocks, entities, warnings, units: INSUNITS[header.$INSUNITS] || INSUNITS[0] };
}

function parseBlocks(text, blocks, warnings) {
  const re = /^\s*0\s*\r?\n\s*BLOCK\s*\r?\n([\s\S]*?)^\s*0\s*\r?\n\s*ENDBLK\s*\r?\n/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    // 以 (code, value) 對逐一走訪：不能用「找第一個值為 0 的行」來切，
    // 那會誤把群組碼 10 的數值 0 當成實體起點而錯開奇偶位。
    let name = null;
    const basePt = { x: 0, y: 0 };
    const ents = [];
    let started = false; let pending = null; let type = null;
    const push = () => {
      if (!pending) return;
      const e = normalize(type, collect(pending), warnings);
      pending = null; type = null;
      if (e && e.type !== 'VERTEX' && e.type !== 'SEQEND' && e.type !== '_LAYER' && e.type !== '_POLYHDR') ents.push(e);
    };
    for (const [c, v] of pairs(m[1] + '\n  0\nEOF\n')) {
      if (c === 0) { push(); if (v === 'EOF') break; started = true; type = v; pending = []; continue; }
      if (!started) {
        if (c === 2 && name == null) name = String(v).trim();
        else if (c === 10) basePt.x = v;
        else if (c === 20) basePt.y = v;
        continue;
      }
      if (pending) pending.push([c, v]);
    }
    if (!name) continue;
    blocks[name] = { name, basePt, entities: ents };
  }
}

function normalize(type, rec, warnings) {
  const layer = one(rec, 8, '0');
  switch (type) {
    case 'LINE':
      return { type: 'LINE', layer, pts: [{ x: one(rec, 10, 0), y: one(rec, 20, 0) }, { x: one(rec, 11, 0), y: one(rec, 21, 0) }] };
    case 'LWPOLYLINE': {
      const pts = lwVertices(rec);
      return pts.length ? { type: 'POLYLINE', layer, pts, closed: !!(one(rec, 70, 0) & 1) } : null;
    }
    case 'POLYLINE':
      // 舊式 POLYLINE 只是表頭，真正的點在後續 VERTEX 實體裡，用內部型別區隔。
      return { type: '_POLYHDR', layer, pts: [], closed: !!(one(rec, 70, 0) & 1) };
    case 'VERTEX':
      return { type: 'VERTEX', layer, pt: { x: one(rec, 10, 0), y: one(rec, 20, 0), bulge: one(rec, 42, 0) } };
    case 'SEQEND':
      return { type: 'SEQEND', layer };
    case 'CIRCLE':
      return { type: 'CIRCLE', layer, c: { x: one(rec, 10, 0), y: one(rec, 20, 0) }, r: one(rec, 40, 0) };
    case 'ARC':
      return { type: 'ARC', layer, c: { x: one(rec, 10, 0), y: one(rec, 20, 0) }, r: one(rec, 40, 0), a0: one(rec, 50, 0), a1: one(rec, 51, 0) };
    case 'ELLIPSE':
      return { type: 'ELLIPSE', layer, c: { x: one(rec, 10, 0), y: one(rec, 20, 0) }, mx: one(rec, 11, 0), my: one(rec, 21, 0), ratio: one(rec, 40, 1), a0: one(rec, 41, 0), a1: one(rec, 42, Math.PI * 2) };
    case 'POINT':
      return { type: 'POINT', layer, pt: { x: one(rec, 10, 0), y: one(rec, 20, 0) } };
    case 'SOLID': case '3DFACE': {
      const p = [[10, 20], [11, 21], [12, 22], [13, 23]].map(([a, b]) => ({ x: one(rec, a, 0), y: one(rec, b, 0) }));
      return { type: 'POLYLINE', layer, pts: p, closed: true, from: type };
    }
    case 'TEXT': case 'MTEXT':
      // MTEXT 把字型、字高、堆疊分數等排版碼混在文字裡，這裡一併還原成純文字。
      return { type: 'TEXT', layer, pt: { x: one(rec, 10, 0), y: one(rec, 20, 0) }, h: one(rec, 40, 2.5),
        text: ENC.decodeMText(String(one(rec, 1, ''))), raw: String(one(rec, 1, '')) };
    case 'INSERT':
      return {
        type: 'INSERT', layer, name: String(one(rec, 2, '')),
        pt: { x: one(rec, 10, 0), y: one(rec, 20, 0) },
        sx: one(rec, 41, 1), sy: one(rec, 42, 1), rot: one(rec, 50, 0),
        cols: one(rec, 70, 1) || 1, rows: one(rec, 71, 1) || 1,
        colSp: one(rec, 44, 0), rowSp: one(rec, 45, 0),
      };
    case 'DIMENSION':
      return { type: 'DIMENSION', layer, measured: one(rec, 42, null), text: String(one(rec, 1, '')), pt: { x: one(rec, 10, 0), y: one(rec, 20, 0) } };
    case 'SPLINE': {
      const xs = [].concat(rec[10] ?? []); const ys = [].concat(rec[20] ?? []);
      const pts = xs.map((x, i) => ({ x, y: ys[i] ?? 0 }));
      if (pts.length >= 2) { warnings.push('SPLINE 以控制點折線近似，長度為下界'); return { type: 'POLYLINE', layer, pts, closed: false, approx: 'spline' }; }
      return null;
    }
    case 'HATCH':
      return { type: 'HATCH', layer };
    case '_LAYER':
      return { type: '_LAYER', name: String(one(rec, 2, '')), color: one(rec, 62, 7), frozen: !!(one(rec, 70, 0) & 1) };
    default:
      return null;
  }
}

/* ────────── 幾何計算 ────────── */

export const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

/** bulge 弧：θ = 4·atan(|b|)，R = c / (2·sin(θ/2))。 */
export function bulgeArc(a, b, bulge) {
  const c = dist(a, b);
  if (!bulge || c < 1e-12) return { len: c, segArea: 0 };
  const th = 4 * Math.atan(Math.abs(bulge));
  const R = c / (2 * Math.sin(th / 2));
  const len = R * th;
  // 弓形面積，凹凸由 bulge 正負決定（CCW 為正）
  const segArea = Math.sign(bulge) * ((R * R) / 2) * (th - Math.sin(th));
  return { len, segArea, R, th };
}

export function polylineLength(pts, closed) {
  let L = 0;
  const n = pts.length;
  for (let i = 0; i + 1 < n; i++) L += bulgeArc(pts[i], pts[i + 1], pts[i].bulge || 0).len;
  if (closed && n > 2) L += bulgeArc(pts[n - 1], pts[0], pts[n - 1].bulge || 0).len;
  return L;
}

/** Shoelace + bulge 弓形修正；回傳有號面積的絕對值。 */
export function polylineArea(pts, closed) {
  const n = pts.length;
  if (n < 3) return 0;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    if (i === n - 1 && !closed) break;
    a += p.x * q.y - q.x * p.y;
  }
  a /= 2;
  let seg = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    if (i === n - 1 && !closed) break;
    if (p.bulge) seg += bulgeArc(p, q, p.bulge).segArea;
  }
  return Math.abs(a + seg);
}

export function arcLength(e) {
  let sweep = ((e.a1 - e.a0) % 360 + 360) % 360;
  if (sweep === 0) sweep = 360;
  return (sweep * Math.PI / 180) * e.r;
}

/** 依 INSERT 的位移/縮放/旋轉展開圖塊，回傳攤平後的實體清單。 */
export function flatten(doc, maxDepth = 8) {
  const out = [];
  const walk = (ents, m, depth, stack) => {
    for (const e of ents) {
      if (e.type === 'INSERT') {
        if (depth >= maxDepth || stack.includes(e.name)) { doc.warnings.push(`圖塊 ${e.name} 巢狀過深或循環參照，已略過`); continue; }
        const blk = doc.blocks[e.name];
        for (let cx = 0; cx < (e.cols || 1); cx++) {
          for (let ry = 0; ry < (e.rows || 1); ry++) {
            const dx = cx * (e.colSp || 0), dy = ry * (e.rowSp || 0);
            const at = { x: e.pt.x + dx, y: e.pt.y + dy };
            // 每一格陣列都是一個實體單元（燈具、插座計數靠這裡）
            out.push({ type: 'INSERT', name: e.name, layer: e.layer, pt: m ? m.fn(at) : at, cell: [cx, ry] });
            if (!blk) continue;
            const m2 = compose(m, {
              tx: at.x, ty: at.y, sx: e.sx || 1, sy: e.sy || 1,
              rot: (e.rot || 0) * Math.PI / 180, bx: blk.basePt.x, by: blk.basePt.y,
            });
            walk(blk.entities, m2, depth + 1, stack.concat(e.name));
          }
        }
      } else {
        out.push(applyM(e, m));
      }
    }
  };
  walk(doc.entities, null, 0, []);
  return out;
}

function compose(m, t) {
  const cos = Math.cos(t.rot), sin = Math.sin(t.rot);
  const local = (p) => {
    const x = (p.x - t.bx) * t.sx, y = (p.y - t.by) * t.sy;
    return { x: t.tx + x * cos - y * sin, y: t.ty + x * sin + y * cos };
  };
  const scale = Math.sqrt(Math.abs(t.sx * t.sy)) || 1;
  return m ? { fn: (p) => m.fn(local(p)), s: m.s * scale } : { fn: local, s: scale };
}

function applyM(e, m) {
  if (!m) return e;
  const f = m.fn;
  const o = { ...e };
  if (e.pts) o.pts = e.pts.map((p) => ({ ...f(p), bulge: p.bulge }));
  if (e.pt) o.pt = f(e.pt);
  if (e.c) { o.c = f(e.c); o.r = e.r * m.s; }
  return o;
}

/** 圖層彙總：長度 / 面積 / 計數 / 圖塊計數。這是「圖面量」自動抓取的來源。 */
export function aggregateByLayer(doc) {
  const flat = flatten(doc);
  const map = new Map();
  const get = (l) => {
    if (!map.has(l)) map.set(l, { layer: l, length: 0, area: 0, count: 0, closedCount: 0, openCount: 0, blocks: {}, types: {} });
    return map.get(l);
  };
  for (const e of flat) {
    const g = get(e.layer || '0');
    g.types[e.type] = (g.types[e.type] || 0) + 1;
    switch (e.type) {
      case 'LINE': g.length += dist(e.pts[0], e.pts[1]); g.count++; g.openCount++; break;
      case 'POLYLINE':
        g.length += polylineLength(e.pts, e.closed); g.count++;
        if (e.closed) { g.area += polylineArea(e.pts, true); g.closedCount++; } else g.openCount++;
        break;
      case 'CIRCLE': g.length += 2 * Math.PI * e.r; g.area += Math.PI * e.r * e.r; g.count++; g.closedCount++; break;
      case 'ARC': g.length += arcLength(e); g.count++; g.openCount++; break;
      case 'ELLIPSE': {
        const a = Math.hypot(e.mx, e.my), b = a * (e.ratio || 1);
        g.length += Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));  // Ramanujan II
        g.area += Math.PI * a * b; g.count++; g.closedCount++; break;
      }
      case 'INSERT': g.blocks[e.name] = (g.blocks[e.name] || 0) + 1; g.count++; break;
      case 'POINT': g.count++; break;
      default: break;
    }
  }
  return [...map.values()].sort((a, b) => b.length - a.length || b.count - a.count);
}

export function bounds(doc) {
  const flat = flatten(doc);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const hit = (p) => { if (!p || !Number.isFinite(p.x)) return; minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); };
  for (const e of flat) {
    if (e.pts) e.pts.forEach(hit);
    if (e.pt) hit(e.pt);
    if (e.c) { hit({ x: e.c.x - e.r, y: e.c.y - e.r }); hit({ x: e.c.x + e.r, y: e.c.y + e.r }); }
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1, empty: true };
  return { minX, minY, maxX, maxY, empty: false };
}

/**
 * 把 libredwg-web 的 DwgDatabase 轉成本模組的實體模型。
 * 只在使用者自行啟用 GPL WASM 解析器時才會被呼叫（見 docs/TAKEOFF.md 授權說明）。
 */
export function fromDwgDatabase(db) {
  const doc = { header: {}, layers: {}, blocks: {}, entities: [], warnings: [], units: INSUNITS[0] };
  const P = (p) => (p ? { x: p.x ?? p[0] ?? 0, y: p.y ?? p[1] ?? 0 } : { x: 0, y: 0 });
  const conv = (e) => {
    const layer = e.layer || e.layerName || '0';
    switch ((e.type || '').toUpperCase()) {
      case 'LINE': return { type: 'LINE', layer, pts: [P(e.startPoint), P(e.endPoint)] };
      case 'LWPOLYLINE': case 'POLYLINE': case 'POLYLINE_2D': {
        const vs = (e.vertices || []).map((v) => ({ ...P(v), bulge: v.bulge || 0 }));
        return vs.length >= 2 ? { type: 'POLYLINE', layer, pts: vs, closed: !!(e.closed || (e.flag & 1)) } : null;
      }
      case 'CIRCLE': return { type: 'CIRCLE', layer, c: P(e.center), r: e.radius || 0 };
      case 'ARC': return { type: 'ARC', layer, c: P(e.center), r: e.radius || 0, a0: rad2deg(e.startAngle), a1: rad2deg(e.endAngle) };
      case 'INSERT': return { type: 'INSERT', layer, name: e.name || e.blockName || '', pt: P(e.insertionPoint), sx: e.xScale ?? 1, sy: e.yScale ?? 1, rot: rad2deg(e.rotation), cols: e.columnCount || 1, rows: e.rowCount || 1, colSp: e.columnSpacing || 0, rowSp: e.rowSpacing || 0 };
      case 'TEXT': case 'MTEXT': return { type: 'TEXT', layer, pt: P(e.insertionPoint || e.startPoint), h: e.textHeight || 2.5, text: ENC.decodeMText(e.text || ''), raw: e.text || '' };
      case 'POINT': return { type: 'POINT', layer, pt: P(e.position || e.center) };
      default: return null;
    }
  };
  const rad2deg = (v) => (typeof v === 'number' ? (Math.abs(v) <= Math.PI * 2 + 1e-6 ? v * 180 / Math.PI : v) : 0);
  for (const e of (db.entities || [])) { const c = conv(e); if (c) doc.entities.push(c); }
  for (const b of (db.blocks || db.tables?.blockRecord?.entries || [])) {
    const name = b.name || b.blockName; if (!name) continue;
    doc.blocks[name] = { name, basePt: P(b.basePoint), entities: (b.entities || []).map(conv).filter(Boolean) };
  }
  const u = db.header?.INSUNITS ?? db.header?.$INSUNITS ?? 0;
  doc.units = INSUNITS[u] || INSUNITS[0];
  doc.header.$INSUNITS = u;
  return doc;
}
