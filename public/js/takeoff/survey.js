/**
 * survey.js — 座標合理性與測量座標系偵測（純函式，無 DOM、無 I/O）
 *
 * 這個模組是真實圖檔逼出來的。一張地籍圖同時暴露了兩件事：
 *
 *   1. `$INSUNITS` 宣告「公厘」，但座標實際上是**公尺**。
 *      照著宣告算，217.7 公尺的地界會變成 0.2177 公尺 —— 差一千倍，
 *      而且畫面上看起來完全正常，因為整張圖等比例縮小了。
 *
 *   2. 圖面同時存在兩群座標：地籍內容在 TWD97 TM2 的
 *      (260,400 , 2,737,400) 附近，圖例與指北針卻畫在原點旁邊 ±30。
 *      對「全部實體」取外框會得到 270 萬單位的跨距，自動框選因此完全失效。
 *
 * 兩件事都不是靠看圖能發現的 —— 它們只會讓數量安靜地錯掉。
 */

/** TWD97 TM2（EPSG:3826）在台灣本島的座標範圍，單位公尺。 */
export const TM2 = {
  x: [100000, 350000],
  y: [2350000, 2810000],
  label: 'TWD97 TM2（二度分帶）',
};

/** 營建圖面內容跨距的合理範圍（公尺）。超出就代表宣告的單位有問題。 */
export const PLAUSIBLE_M = [0.5, 20000];

function collectPoints(flat) {
  const pts = [];
  for (const e of flat || []) {
    if (e.pts) for (const p of e.pts) if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) pts.push(p);
    if (e.pt && Number.isFinite(e.pt.x) && Number.isFinite(e.pt.y)) pts.push(e.pt);
    if (e.c && Number.isFinite(e.c.x) && Number.isFinite(e.c.y)) pts.push(e.c);
  }
  return pts;
}

/**
 * 一維分群：依「相鄰值之間的空隙」切開。
 * 空隙門檻取「中位空隙的 N 倍」與「全距的一定比例」兩者的大者 ——
 * 前者對付均勻分布的圖，後者對付本來就稀疏的圖。
 */
export function cluster1d(values, opts = {}) {
  const v = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (v.length < 2) return v.length ? [{ min: v[0], max: v[0], count: 1 }] : [];
  // 中位空隙要算在**相異值**上。重複值會讓中位數變成 0，
  // 門檻整個塌掉，結果把一個 10 單位寬的矩形切成兩群。
  const uniq = [];
  for (const x of v) if (!uniq.length || x !== uniq[uniq.length - 1]) uniq.push(x);
  if (uniq.length < 2) return [{ min: v[0], max: v[v.length - 1], count: v.length }];
  const diffs = [];
  for (let i = 1; i < uniq.length; i++) diffs.push(uniq[i] - uniq[i - 1]);
  const sorted = diffs.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  const range = v[v.length - 1] - v[0];
  const gap = Math.max(median * (opts.gapFactor || 200), range * (opts.gapRatio || 0.2));
  if (!(gap > 0)) return [{ min: v[0], max: v[v.length - 1], count: v.length }];

  const out = [];
  let start = 0;
  for (let i = 1; i < v.length; i++) {
    if (v[i] - v[i - 1] > gap) { out.push({ min: v[start], max: v[i - 1], count: i - start }); start = i; }
  }
  out.push({ min: v[start], max: v[v.length - 1], count: v.length - start });
  return out.sort((a, b) => b.count - a.count);
}

/**
 * 圖面真正的「內容範圍」。
 *
 * 對全部實體取外框，只要有一個離群的圖框或圖例就會把範圍撐爛。
 * 這裡先分群、取點數最多的那一群，並回報被排除了多少點 ——
 * 排除是有代價的判斷，不能靜默做掉。
 */
/** 排除離群點的門檻：主群要佔多數，而且排除後範圍要縮很多，才值得排除。 */
export const SPLIT = { minShare: 0.6, minShrink: 0.9 };

export function contentBounds(flat, opts = {}) {
  const pts = collectPoints(flat);
  if (!pts.length) return null;
  const box = (a) => ({
    minX: Math.min(...a.map((p) => p.x)), maxX: Math.max(...a.map((p) => p.x)),
    minY: Math.min(...a.map((p) => p.y)), maxY: Math.max(...a.map((p) => p.y)),
  });
  const full = box(pts);
  const fullSpan = Math.max(full.maxX - full.minX, full.maxY - full.minY);

  const cx = cluster1d(pts.map((p) => p.x), opts);
  const cy = cluster1d(pts.map((p) => p.y), opts);
  const mainX = cx[0], mainY = cy[0];
  const inside = (mainX && mainY)
    ? pts.filter((p) => p.x >= mainX.min && p.x <= mainX.max && p.y >= mainY.min && p.y <= mainY.max)
    : [];

  // 只有「主群佔多數」且「排除後範圍大幅縮小」才採用主群。
  //
  // 五五分的兩群不是離群，是圖上真的有兩塊東西 —— 那時候安靜地丟掉一半
  // 才是最糟的結果。寧可回報範圍很大，也不要偷偷少算一半的圖。
  const share = inside.length / pts.length;
  const span = inside.length ? Math.max(...[box(inside)].map((b) => Math.max(b.maxX - b.minX, b.maxY - b.minY))) : Infinity;
  const shrink = fullSpan > 0 ? 1 - span / fullSpan : 0;
  const accept = inside.length > 0 && share >= (opts.minShare ?? SPLIT.minShare)
    && shrink >= (opts.minShrink ?? SPLIT.minShrink);

  const use = accept ? inside : pts;
  const b = box(use);
  const many = cx.length > 1 || cy.length > 1;
  return {
    ...b,
    width: b.maxX - b.minX, height: b.maxY - b.minY,
    total: pts.length, used: use.length, excluded: pts.length - use.length,
    clusters: { x: cx.length, y: cy.length },
    split: accept,
    // 有多群但不敢排除 —— 這件事要說出來，不能當作沒事
    ambiguous: many && !accept,
    share, shrink,
  };
}

/** 這些座標看起來是不是 TWD97 TM2（公尺）。 */
export function looksLikeTM2(b) {
  if (!b) return false;
  const inX = b.minX >= TM2.x[0] && b.maxX <= TM2.x[1];
  const inY = b.minY >= TM2.y[0] && b.maxY <= TM2.y[1];
  return inX && inY;
}

const UNIT_CANDIDATES = [
  { name: '公尺', toM: 1 },
  { name: '公厘', toM: 0.001 },
  { name: '公分', toM: 0.01 },
  { name: '英吋', toM: 0.0254 },
  { name: '英尺', toM: 0.3048 },
];

/**
 * 單位合理性檢查。
 *
 * 邏輯很簡單，但沒有人做：**把宣告的單位套上去，看圖變成多大**。
 * 一張地籍圖的內容跨距若算出來是 0.2 公尺或 2,700 公里，那不是圖有問題，
 * 是宣告的單位有問題。這裡只回報，不自動改 —— 改單位會改變所有數量。
 */
export function checkUnits(doc, flat, opts = {}) {
  const b = contentBounds(flat, opts);
  if (!b) return null;
  const declared = (doc && doc.units) || null;
  const toM = declared && Number.isFinite(declared.toM) ? declared.toM : null;
  const span = Math.max(b.width, b.height);
  const tm2 = looksLikeTM2(b);

  const out = {
    bounds: b, declared, spanRaw: span,
    spanM: toM ? span * toM : null,
    tm2, crs: tm2 ? TM2.label : null,
    split: b.split, excluded: b.excluded,
    ok: true, suggest: null, reasons: [],
  };

  // TM2 座標一定是公尺 —— 這是座標系的定義，不是推測。
  if (tm2) {
    out.reasons.push({
      level: 'warn', kind: 'crs',
      msg: `座標落在 ${TM2.label} 範圍內（X ${b.minX.toFixed(0)}–${b.maxX.toFixed(0)}、Y ${b.minY.toFixed(0)}–${b.maxY.toFixed(0)}）。`
        + `這個座標系的單位**依定義就是公尺**，內容實際跨距約 ${b.width.toFixed(1)} × ${b.height.toFixed(1)} 公尺。`,
    });
    if (toM !== null && Math.abs(toM - 1) > 1e-9) {
      out.ok = false;
      out.suggest = { name: '公尺', toM: 1 };
      out.reasons.push({
        level: 'bad', kind: 'unit',
        msg: `但圖檔宣告單位是「${declared.name}」。照宣告換算，這塊地會變成 ${(span * toM).toFixed(4)} 公尺 ——`
          + ` 與實際差 ${(1 / toM).toLocaleString()} 倍。所有由圖面抓出來的數量都會同倍數錯掉。`,
      });
    }
  } else if (toM !== null) {
    const m = span * toM;
    if (m < PLAUSIBLE_M[0] || m > PLAUSIBLE_M[1]) {
      out.ok = false;
      // 找出讓跨距落回合理範圍的單位
      const fit = UNIT_CANDIDATES.filter((u) => {
        const x = span * u.toM;
        return x >= PLAUSIBLE_M[0] && x <= PLAUSIBLE_M[1];
      });
      out.suggest = fit.length === 1 ? fit[0] : null;
      out.candidates = fit;
      out.reasons.push({
        level: 'bad', kind: 'unit',
        msg: `依宣告單位「${declared.name}」換算，圖面內容跨距是 ${m.toPrecision(4)} 公尺 ——`
          + ` 不在營建圖面的合理範圍（${PLAUSIBLE_M[0]}–${PLAUSIBLE_M[1]} 公尺）。`
          + (fit.length ? `改用「${fit.map((u) => u.name).join('」或「')}」才落得回合理範圍。` : '沒有任何常用單位能讓它合理，請確認圖檔。'),
      });
    }
  } else {
    out.ok = false;
    out.reasons.push({ level: 'warn', kind: 'no-unit', msg: '圖檔沒有宣告單位（$INSUNITS 未定義或為 0），必須人工指定。' });
    out.candidates = UNIT_CANDIDATES.filter((u) => {
      const x = span * u.toM;
      return x >= PLAUSIBLE_M[0] && x <= PLAUSIBLE_M[1];
    });
  }

  if (b.ambiguous) {
    out.reasons.push({
      level: 'warn', kind: 'ambiguous',
      msg: `圖面有 ${Math.max(b.clusters.x, b.clusters.y)} 群相距很遠的座標，但沒有哪一群明顯是主體`
        + `（最大一群佔 ${(b.share * 100).toFixed(0)}%）。工具**不排除任何一群** ——`
        + `五五分的兩群通常是圖上真的有兩塊東西，安靜丟掉一半比範圍太大更危險。請自行確認要量的是哪一塊。`,
    });
  }

  // 座標分成好幾群 → 對全部實體取外框會完全失真
  if (b.split) {
    out.reasons.push({
      level: 'warn', kind: 'split',
      msg: `圖面有 ${Math.max(b.clusters.x, b.clusters.y)} 群相距很遠的座標，已排除 ${b.excluded} 個離群點才算出內容範圍。`
        + `常見成因：地籍內容畫在測量座標上，圖例與指北針卻畫在原點旁。對全部實體取外框會得到毫無意義的跨距。`,
    });
  }
  return out;
}

/** 給使用者看的一句話結論。 */
export function summarize(chk) {
  if (!chk) return '';
  if (chk.ok && !chk.reasons.length) return '座標與單位看起來正常。';
  return chk.reasons.map((r) => r.msg).join(' ');
}
