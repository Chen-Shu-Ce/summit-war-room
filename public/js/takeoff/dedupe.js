/**
 * 重複描繪偵測。
 *
 * 為什麼這件事比任何自動化都優先：
 *
 * `aggregateByLayer` 把圖層裡所有實體的長度加總。如果同一條管路被描了兩遍
 * ——複製貼上、圖層沒清乾淨、不同人各畫一次——長度就**直接翻倍**，
 * 而且沒有任何地方看得出來。對應猜錯了，數字會不合理而被發現；
 * 重複描繪不會：它給你一個完全合理、但是錯一倍的數字。
 *
 * 這裡算的是一個很具體的量：**重複長度 = 總長 − 聯集長度**。
 * 「聯集」是指把同一條無限直線上的所有線段投影成一維區間之後取聯集 ——
 * 一段牆畫成 0–5000 和 3000–8000，總長 10000、聯集 8000、重複 2000。
 * 這個定義不需要「兩條線是不是同一條」的主觀判斷，只需要幾何。
 *
 * 三類重複分開算，因為處置方式不同：
 *   1. 共線重疊（含完全重合、反向重合、部分重疊）→ 長度被灌水
 *   2. 相同幾何的圓／弧 → 長度與面積都被灌水
 *   3. 同點同名的圖塊 → **計數**被灌水（燈具、插座最常見）
 *
 * 全部是確定性幾何計算，沒有門檻可調到「看起來比較好看」。
 */

/** 角度分群的容差（弧度）。0.0005 rad ≈ 0.03°，比任何手繪誤差都嚴。 */
export const ANG_TOL = 5e-4;

/** 預設的長度容差，單位是圖檔單位。呼叫端應換算成 1mm 再傳進來。 */
export const DEFAULT_TOL = 1e-6;

const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

/**
 * 把實體攤成直線段。
 *
 * POLYLINE 的每一段都拆開 —— 重複描繪常常是「一條多段線」對上
 * 「好幾條獨立線段」，不拆開就比不出來。帶 bulge 的弧段不拆（它不是直線），
 * 改由第 2 類（相同幾何）處理。
 */
export function segmentsOf(flat) {
  const out = [];
  const push = (layer, a, b, src) => {
    if (!a || !b) return;
    out.push({ layer: layer || '0', a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, src });
  };
  for (const e of flat) {
    if (e.type === 'LINE') push(e.layer, e.pts[0], e.pts[1], e);
    else if (e.type === 'POLYLINE' && e.pts && e.pts.length > 1) {
      const n = e.pts.length;
      for (let i = 0; i + 1 < n; i++) {
        if (e.pts[i].bulge) continue;               // 弧段不當直線比
        push(e.layer, e.pts[i], e.pts[i + 1], e);
      }
      if (e.closed && n > 2 && !e.pts[n - 1].bulge) push(e.layer, e.pts[n - 1], e.pts[0], e);
    }
  }
  return out;
}

/**
 * 線段所在的無限直線，正規化成 (theta, c)。
 *
 * theta 落在 [0, π) —— 方向相反的兩條線是同一條直線，這一點很重要：
 * A→B 和 B→A 是最常見的重複描繪形式。
 */
export function lineOf(seg) {
  const dx = seg.b.x - seg.a.x, dy = seg.b.y - seg.a.y;
  const len = Math.hypot(dx, dy);
  if (!len) return { theta: 0, c: 0, len: 0, ux: 0, uy: 0, degenerate: true };
  let theta = Math.atan2(dy, dx);
  if (theta < 0) theta += Math.PI;                   // 方向無關：A→B 與 B→A 同一條
  if (theta >= Math.PI) theta -= Math.PI;
  // 把 θ 落在 π 附近的那一小段拉回 0 附近。
  // 斜率 +1e-5 與 −1e-5 是兩條幾乎重合的線，但一個 θ≈0、一個 θ≈π ——
  // 排序後落在陣列兩端，永遠不會被拿來比，重複就整段漏掉（而漏報比誤報更危險）。
  if (theta > Math.PI - ANG_TOL) theta -= Math.PI;
  const ux = Math.cos(theta), uy = Math.sin(theta);  // 直線方向（正規化後）
  const c = -uy * seg.a.x + ux * seg.a.y;            // 法向距離（有號）
  return { theta, c, len, ux, uy, degenerate: false };
}

/** 一維區間聯集長度。 */
export function unionLength(intervals) {
  if (!intervals.length) return 0;
  const s = intervals.slice().sort((p, q) => p[0] - q[0]);
  let total = 0, lo = s[0][0], hi = s[0][1];
  for (let i = 1; i < s.length; i++) {
    if (s[i][0] > hi) { total += hi - lo; lo = s[i][0]; hi = s[i][1]; }
    else if (s[i][1] > hi) hi = s[i][1];
  }
  return total + (hi - lo);
}

/**
 * 依「同一條直線」分群。
 *
 * 不用格子量化 —— 量化的邊界會讓兩條只差一點點的線落進不同格子而漏掉。
 * 改成排序後掃描：相鄰兩筆在容差內就併進同一群。
 */
function groupByLine(segs, tol) {
  const withLine = segs.map((s) => ({ s, l: lineOf(s) })).filter((x) => !x.l.degenerate);
  withLine.sort((p, q) => p.l.theta - q.l.theta || p.l.c - q.l.c);
  const groups = [];
  let cur = [];
  for (let i = 0; i < withLine.length; i++) {
    const x = withLine[i];
    if (!cur.length) { cur = [x]; continue; }
    const prev = cur[cur.length - 1];
    // theta 接近 0 與接近 π 其實是同一個方向，跨接處要特別處理
    const dt = Math.min(Math.abs(x.l.theta - prev.l.theta), Math.PI - Math.abs(x.l.theta - prev.l.theta));
    if (dt <= ANG_TOL && Math.abs(x.l.c - prev.l.c) <= tol) cur.push(x);
    else { groups.push(cur); cur = [x]; }
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/**
 * 分析一組線段的共線重複。
 * 回傳 { total, union, duplicated, groups:[...] }，長度單位同輸入。
 */
export function overlapOf(segs, tol = DEFAULT_TOL) {
  let total = 0, union = 0, degenerate = 0;
  const hot = [];
  for (const s of segs) {
    const l = lineOf(s);
    if (l.degenerate) { degenerate++; continue; }
    total += l.len;
  }
  for (const grp of groupByLine(segs, tol)) {
    const ref = grp[0].l;
    const intervals = grp.map(({ s }) => {
      const ta = ref.ux * s.a.x + ref.uy * s.a.y;
      const tb = ref.ux * s.b.x + ref.uy * s.b.y;
      return ta <= tb ? [ta, tb] : [tb, ta];
    });
    const u = unionLength(intervals);
    union += u;
    const sum = intervals.reduce((a, [p, q]) => a + (q - p), 0);
    const dup = sum - u;
    if (dup > tol && grp.length > 1) {
      hot.push({ count: grp.length, duplicated: dup, sum, union: u, sample: grp[0].s });
    }
  }
  hot.sort((a, b) => b.duplicated - a.duplicated);
  return { total, union, duplicated: Math.max(0, total - union), degenerate, groups: hot };
}

/** 幾何簽章：相同的圓／弧／圖塊插入點會得到同一個字串。 */
function sigOf(e, tol) {
  const q = (v) => Math.round(v / tol);
  switch (e.type) {
    case 'CIRCLE': return `C|${e.layer}|${q(e.c.x)}|${q(e.c.y)}|${q(e.r)}`;
    case 'ARC': return `A|${e.layer}|${q(e.c.x)}|${q(e.c.y)}|${q(e.r)}|${Math.round(e.a0 ?? 0)}|${Math.round(e.a1 ?? 0)}`;
    case 'INSERT': return `I|${e.layer}|${e.name}|${q(e.pt.x)}|${q(e.pt.y)}`;
    default: return null;
  }
}

/**
 * 相同幾何的實體。
 *
 * 圖塊那一類特別要命：同一盞燈插兩次在同一個點，畫面上完全看不出來
 * （兩個圖形疊在一起），但計數工項會多算一個。燈具、插座、消防設備
 * 都是靠 INSERT 計數的，這裡多一個就是採購單上多一個。
 */
export function duplicateEntities(flat, tol = DEFAULT_TOL) {
  const map = new Map();
  for (const e of flat) {
    const sig = sigOf(e, tol);
    if (!sig) continue;
    if (!map.has(sig)) map.set(sig, []);
    map.get(sig).push(e);
  }
  const out = [];
  for (const [sig, list] of map) {
    if (list.length < 2) continue;
    out.push({ sig, type: list[0].type, layer: list[0].layer || '0',
      name: list[0].name || '', extra: list.length - 1, at: list[0].pt || list[0].c, items: list });
  }
  out.sort((a, b) => b.extra - a.extra);
  return out;
}

/**
 * 整張圖的重複描繪分析，逐圖層。
 *
 * opts.tol 是長度容差（圖檔單位）。呼叫端請用 1mm 換算：
 * metersPerUnit 已知時 tol = 0.001 / metersPerUnit。
 */
export function analyze(flat, opts = {}) {
  const tol = opts.tol > 0 ? opts.tol : DEFAULT_TOL;
  const segs = segmentsOf(flat);
  const byLayer = new Map();
  const get = (l) => {
    if (!byLayer.has(l)) {
      byLayer.set(l, { layer: l, segs: [], total: 0, union: 0, duplicated: 0, degenerate: 0,
        ratio: 0, groups: [], dupEntities: [], dupInserts: 0 });
    }
    return byLayer.get(l);
  };
  for (const s of segs) get(s.layer).segs.push(s);

  for (const g of byLayer.values()) {
    Object.assign(g, overlapOf(g.segs, tol));
    g.ratio = g.total > 0 ? g.duplicated / g.total : 0;
    delete g.segs;
  }

  for (const d of duplicateEntities(flat, tol)) {
    const g = get(d.layer);
    g.dupEntities.push(d);
    if (d.type === 'INSERT') g.dupInserts += d.extra;
  }

  const layers = [...byLayer.values()].sort((a, b) => b.duplicated - a.duplicated || b.dupInserts - a.dupInserts);
  const totals = layers.reduce((a, g) => ({
    total: a.total + g.total,
    duplicated: a.duplicated + g.duplicated,
    degenerate: a.degenerate + g.degenerate,
    dupInserts: a.dupInserts + g.dupInserts,
  }), { total: 0, duplicated: 0, degenerate: 0, dupInserts: 0 });
  totals.ratio = totals.total > 0 ? totals.duplicated / totals.total : 0;
  return { tol, layers, byLayer, totals, clean: totals.duplicated <= tol && !totals.dupInserts };
}

/** 嚴重度分級。用來決定要不要擋住自動抓量。 */
export function severity(g) {
  if (g.dupInserts > 0) return 'bad';                 // 計數被灌水，一個就是一個
  if (g.ratio >= 0.02) return 'bad';                  // 長度灌水超過 2%
  if (g.ratio > 0 || g.degenerate > 0) return 'warn';
  return 'ok';
}

/** 一句話講清楚這個圖層的狀況（長度換算交給呼叫端）。 */
export function describe(g, toM = null) {
  const L = (v) => (toM ? `${(v * toM).toFixed(1)} M` : v.toFixed(1));
  if (severity(g) === 'ok') return '無重複';
  const parts = [];
  if (g.duplicated > 0) parts.push(`重複 ${L(g.duplicated)}（總長 ${L(g.total)} 的 ${(g.ratio * 100).toFixed(1)}%）`);
  if (g.dupInserts > 0) parts.push(`${g.dupInserts} 個圖塊重疊插入`);
  if (g.degenerate > 0) parts.push(`${g.degenerate} 條零長度線`);
  return parts.join('；');
}
