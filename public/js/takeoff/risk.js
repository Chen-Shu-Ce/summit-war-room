/**
 * risk.js — 損耗率機率化與蒙地卡羅模擬。
 *
 * 為什麼要做這件事：單一損耗率係數（3%）是慣例不是證據。它把一個機率分布壓成一個數字，
 * 然後假裝它沒有變異。1,751 看起來很精確，但它不回答「有多少機率會缺料」。
 *
 * 做錯的蒙地卡羅比不做更危險 —— 它會給你看起來很科學的錯數字。本模組刻意處理五件事：
 *
 *   1. 相關性：同工班、同場地、同工法的損耗是正相關的。全當獨立會被大數法則抹平，
 *      整包 P80 嚴重低估。用高斯 copula 單因子模型注入相關係數。
 *   2. 加總謬誤：各項 P80 相加 ≠ 整包 P80（除非完全相關）。兩個數字都算給你看差多少。
 *   3. 可重現：固定種子的 PRNG。同樣輸入必得同樣輸出，否則採購數字每按一次就變，沒人敢簽。
 *   4. 適用範圍：只有材料類（長度/面積/體積/重量）有損耗分布。計數類與統包項不模擬。
 *   5. 運算順序：在「需求量」層抽樣，再套包裝倍數/MOQ 這些確定性階梯函數。
 *      反過來做會把分布扭曲。
 */

import * as Q from './quantity.js';

/* ────────── 可重現的亂數 ────────── */

/** mulberry32：小、快、統計性質足夠，且同種子必得同序列。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 標準常態分位函數（Acklam 近似，絕對誤差 < 1.15e-9）。 */
export function normalInv(p) {
  if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425, ph = 1 - pl;
  let q, r;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > ph) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** 標準常態累積分布（Abramowitz–Stegun 7.1.26 誤差函數近似）。 */
export function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

/* ────────── 分布 ────────── */

const lnGamma = (x) => {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += g[j] / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
};

/** 正則化不完全 beta 函數 I_x(a,b)（Lentz 連分數）。 */
export function betaInc(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? bt * betacf(x, a, b) / a : 1 - bt * betacf(1 - x, b, a) / b;
}

function betacf(x, a, b) {
  const EPS = 3e-12, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Beta 分位函數（對 I_x(a,b) 做二分法；只在建表時呼叫，不在抽樣迴圈裡）。 */
export function betaInv(p, a, b) {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let lo = 0, hi = 1;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (betaInc(mid, a, b) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

export const DISTS = {
  triangular: {
    key: 'triangular', label: '三角分布',
    note: '參數最直覺（樂觀／最可能／悲觀），反函數有閉式解。營建估價常用。',
    inv(p, d) {
      const { min, mode, max } = d;
      if (max <= min) return min;
      const c = (mode - min) / (max - min);
      return p < c
        ? min + Math.sqrt(p * (max - min) * (mode - min))
        : max - Math.sqrt((1 - p) * (max - min) * (max - mode));
    },
  },
  pert: {
    key: 'pert', label: 'PERT（Beta-PERT）',
    note: '三角分布的平滑版，最可能值權重 4，尾部比三角保守。PMI／AACE 三點估計的標準做法。',
    inv(p, d) {
      const { min, mode, max } = d;
      if (max <= min) return min;
      const a = 1 + 4 * (mode - min) / (max - min);
      const b = 1 + 4 * (max - mode) / (max - min);
      return min + betaInv(p, a, b) * (max - min);
    },
  },
  lognormal: {
    key: 'lognormal', label: '對數常態',
    note: '右偏、恆正，尾部較厚。適合「偶爾會出現大浪費」的材料。',
    inv(p, d) {
      // 以 mode 為中位數、(max-min) 推 σ，讓三個參數仍有意義
      const med = Math.max(d.mode, 1e-9);
      const sigma = Math.max((Math.log(Math.max(d.max, med * 1.0001)) - Math.log(Math.max(d.min, 1e-9))) / 4, 1e-6);
      return Math.exp(Math.log(med) + sigma * normalInv(p));
    },
  },
};

/**
 * 預先建好分位數查表再線性內插。
 * PERT 的反函數要跑二分法＋連分數，放進 30 萬次的抽樣迴圈會慢到不能用；
 * 建一次 1024 點的表之後查表，誤差可忽略而速度與三角分布相同。
 */
export function makeQuantileTable(dist, params, n = 1024) {
  const f = (DISTS[dist] || DISTS.triangular).inv;
  const t = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) t[i] = f(i / n, params);
  return t;
}

export function lookup(table, u) {
  const n = table.length - 1;
  const x = Math.min(Math.max(u, 0), 0.999999) * n;
  const i = Math.floor(x);
  const frac = x - i;
  return table[i] + (table[Math.min(i + 1, n)] - table[i]) * frac;
}

/* ────────── 損耗率區間 ────────── */

export const DEFAULT_SIM = {
  iterations: 10000,
  seed: 20260913,
  correlation: 0.3,      // 同案場工班/工法造成的正相關；設 0 可看獨立假設下差多少
  dist: 'pert',
  serviceLevel: 0.8,     // 採購基準用的服務水準（P80）
  // 價格風險預設關閉 —— 開了會改變既有專案的 P80，必須是使用者明確決定。
  // 開啟時的典型值：{ min: -0.02, mode: 0, max: 0.08 }（報價向上偏）
  priceDist: null,
  priceCorrelation: 0.6, // 同市場同批廠商，價格的相關性比數量高
};

/** 只有材料類才有損耗分布可言。計數類、統包項不模擬。 */
export function isStochastic(item) {
  return ['length', 'area', 'volume', 'weight'].includes(item.measureType);
}

/** 工項的損耗區間；沒設就由既有的單點損耗率退化出一個窄區間。 */
export function wasteDistOf(item, settings = {}) {
  const d = item.wasteDist;
  if (d && Q.isNum(d.min) && Q.isNum(d.mode) && Q.isNum(d.max) && d.max >= d.min) {
    return { min: d.min, mode: Math.min(Math.max(d.mode, d.min), d.max), max: d.max, source: 'item' };
  }
  const w = Q.isNum(item.wasteRate) ? item.wasteRate : (settings.defaultWasteRate ?? 0.03);
  // 沒有區間資料時不假裝有：退回以單點為中心的窄區間，並標明來源
  return { min: Math.max(0, w * 0.6), mode: w, max: w * 1.8, source: 'fallback' };
}

/** 服務水準建議：缺料代價越高（長交期、特殊規格），該備越多。 */
export function suggestServiceLevel(item, settings = {}) {
  const long = settings.longLeadDays ?? 90;
  const lead = item.leadTimeDays || 0;
  if (item.special || lead >= long * 2) return { p: 0.95, why: '特殊規格或超長交期，缺料等於停工數月' };
  if (lead >= long) return { p: 0.9, why: `前置期 ${lead} 天 ≥ ${long} 天，補料來不及` };
  if (lead >= 30) return { p: 0.85, why: `前置期 ${lead} 天，補料需一個月以上` };
  return { p: 0.8, why: '短交期料，缺了可以補' };
}

/**
 * 一個單點損耗率相當於第幾百分位。
 *
 * 這是機率化最有價值的一句話：「你慣用的 3% 其實只到 P37，有 63% 的機率不夠。」
 * 沒有這個對照，使用者不會知道舊做法到底偏在哪裡。
 */
export function percentileOfWaste(w, dist, kind = 'pert') {
  if (!Q.isNum(w) || !dist || dist.max <= dist.min) return null;
  if (w <= dist.min) return 0;
  if (w >= dist.max) return 1;
  const x = (w - dist.min) / (dist.max - dist.min);
  if (kind === 'triangular') {
    const c = (dist.mode - dist.min) / (dist.max - dist.min);
    return Q.roundTo(x <= c ? (x * x) / c : 1 - ((1 - x) * (1 - x)) / (1 - c), 4);
  }
  if (kind === 'lognormal') {
    const med = Math.max(dist.mode, 1e-9);
    const sigma = Math.max((Math.log(Math.max(dist.max, med * 1.0001)) - Math.log(Math.max(dist.min, 1e-9))) / 4, 1e-6);
    return Q.roundTo(normalCdf((Math.log(w) - Math.log(med)) / sigma), 4);
  }
  const a = 1 + 4 * (dist.mode - dist.min) / (dist.max - dist.min);
  const b = 1 + 4 * (dist.max - dist.mode) / (dist.max - dist.min);
  return Q.roundTo(betaInc(x, a, b), 4);
}

/* ────────── 模擬 ────────── */

const PCTS = [0.05, 0.5, 0.8, 0.9, 0.95];

function quantile(sorted, p) {
  if (!sorted.length) return null;
  const x = p * (sorted.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  return sorted[i] + (sorted[Math.min(i + 1, sorted.length - 1)] - sorted[i]) * f;
}

function stats(arr) {
  const s = Float64Array.from(arr).sort();
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const sd = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length);
  const out = { mean: Q.roundTo(mean, 4), sd: Q.roundTo(sd, 4) };
  for (const p of PCTS) out[`p${Math.round(p * 100)}`] = Q.roundTo(quantile(s, p), 4);
  return out;
}

/**
 * 單一工項的需求量分布。
 * 回傳的 p50/p80… 是「需求量」，尚未套包裝倍數與 MOQ —— 那是確定性階梯函數，
 * 必須在抽樣之後才套用，順序反了分布會被扭曲。
 */
export function simulateItem(item, settings = {}, opts = {}) {
  const s = { ...DEFAULT_SIM, ...settings, ...opts };
  const res = Q.resolveBasis(item, settings);
  if (!Q.isNum(res.value)) return null;
  if (!isStochastic(item)) {
    return { deterministic: true, base: res.value, dist: null, qty: { p50: res.value, p80: res.value, p90: res.value, p95: res.value, mean: res.value, sd: 0 } };
  }
  const dist = wasteDistOf(item, settings);
  const table = makeQuantileTable(s.dist, dist);
  const rand = mulberry32(s.seed ^ hashCode(item.code));
  const n = s.iterations;
  const qty = new Array(n);
  const waste = new Array(n);
  for (let i = 0; i < n; i++) {
    const w = lookup(table, rand());
    waste[i] = w;
    qty[i] = res.value * (1 + w);
  }
  return { deterministic: false, base: res.value, dist, distKind: s.dist, qty: stats(qty), waste: stats(waste) };
}

function hashCode(str) {
  let h = 0;
  for (let i = 0; i < String(str).length; i++) h = (Math.imul(31, h) + String(str).charCodeAt(i)) | 0;
  return h;
}

/**
 * 整包模擬。這才是採購決策要看的數字。
 *
 * 相關性用高斯 copula 單因子模型注入：
 *   Z_i = √ρ · Z_common + √(1−ρ) · Z_i'    →    u_i = Φ(Z_i)    →    w_i = F_i⁻¹(u_i)
 * ρ = 0 等於各項獨立（會低估整包風險），ρ = 1 等於完全同步（等於各項分位數相加）。
 */
export function simulatePortfolio(items, settings = {}, opts = {}) {
  const s = { ...DEFAULT_SIM, ...settings, ...opts };
  const rho = Math.min(Math.max(Q.isNum(s.correlation) ? s.correlation : 0, 0), 1);
  const usable = [];
  for (const it of items) {
    const res = Q.resolveBasis(it, settings);
    if (!Q.isNum(res.value)) continue;
    usable.push({
      item: it, base: res.value, stoch: isStochastic(it),
      table: isStochastic(it) ? makeQuantileTable(s.dist, wasteDistOf(it, settings)) : null,
      price: Q.isNum(it.unitPrice) ? it.unitPrice : null,
    });
  }
  if (!usable.length) return null;

  const n = s.iterations;
  const rand = mulberry32(s.seed);
  const sqrtRho = Math.sqrt(rho), sqrtAnti = Math.sqrt(1 - rho);

  // ── 價格風險 ──
  //
  // 原本只擾動數量，等於假設「發包時的報價一定等於估價時的單價」。
  // 使用者說真正吃虧的正是這一段：發包時報價比估價高。
  //
  // 開啟方式是傳入 priceDist（相對偏差的三點估計，例如
  // { min: -0.02, mode: 0, max: 0.08 } —— 刻意不對稱，因為報價向上偏的機會
  // 遠大於向下）。**不傳就完全不動**：連亂數都不會多抽一個，
  // 既有結果逐位元相同，不會因為加了功能就讓舊的基準版對不起來。
  const pd = opts.priceDist || s.priceDist || null;
  const priceTable = pd && Q.isNum(pd.min) && Q.isNum(pd.mode) && Q.isNum(pd.max)
    ? makeQuantileTable(s.dist, pd) : null;
  // 價格的相關性比數量高：同一個市場、同一批廠商，漲是一起漲。
  const rhoP = Math.min(Math.max(Q.isNum(s.priceCorrelation) ? s.priceCorrelation : 0.6, 0), 1);
  const sqrtRhoP = Math.sqrt(rhoP), sqrtAntiP = Math.sqrt(1 - rhoP);

  const totalCost = new Array(n);
  const perItem = usable.map(() => new Array(n));
  const perPrice = priceTable ? usable.map(() => new Array(n)) : null;

  for (let k = 0; k < n; k++) {
    const zc = normalInv(rand());
    const zp = priceTable ? normalInv(rand()) : 0;   // 價格的共同因子
    let cost = 0;
    for (let j = 0; j < usable.length; j++) {
      const u = usable[j];
      let q = u.base;
      if (u.stoch) {
        const z = sqrtRho * zc + sqrtAnti * normalInv(rand());
        q = u.base * (1 + lookup(u.table, normalCdf(z)));
      }
      perItem[j][k] = q;
      let price = u.price;
      if (priceTable && price != null) {
        const z = sqrtRhoP * zp + sqrtAntiP * normalInv(rand());
        price = u.price * (1 + lookup(priceTable, normalCdf(z)));
        perPrice[j][k] = price;
      }
      if (price != null) cost += q * price;
    }
    totalCost[k] = cost;
  }

  const itemStats = usable.map((u, j) => ({
    code: u.item.code, name: u.item.name, unit: u.item.unit, base: u.base,
    stochastic: u.stoch, qty: stats(perItem[j]),
    price: perPrice ? stats(perPrice[j]) : null,
  }));

  // 加總謬誤對照：各項 P80 相加 vs 整包 P80
  const sumOfP80 = itemStats.reduce((a, x) => a + (x.qty.p80 * (usable.find((u) => u.item.code === x.code).price || 0)), 0);
  const cost = stats(totalCost);

  // 收斂檢查：前後半樣本的 P80 差多少。差太多代表迭代次數不夠。
  const half = Math.floor(n / 2);
  const a80 = quantile(Float64Array.from(totalCost.slice(0, half)).sort(), 0.8);
  const b80 = quantile(Float64Array.from(totalCost.slice(half)).sort(), 0.8);
  const convergence = a80 > 0 ? Math.abs(a80 - b80) / a80 : 0;

  return {
    iterations: n, correlation: rho, dist: s.dist, seed: s.seed,
    priceRisk: priceTable ? { dist: pd, correlation: rhoP } : null,
    items: itemStats, cost,
    sumOfP80: Q.roundTo(sumOfP80, 2),
    portfolioP80: cost.p80,
    diversification: Q.roundTo(sumOfP80 - cost.p80, 2),
    convergence: Q.roundTo(convergence, 5),
  };
}

/**
 * 依服務水準取出該工項的等效損耗率，回傳一個 clone 供既有的 suggestPurchase 使用。
 * 這樣 quantity.js 完全不需要知道機率的存在，向下相容。
 */
export function withServiceLevel(item, settings = {}, level) {
  if (!isStochastic(item)) return item;
  const s = { ...DEFAULT_SIM, ...settings };
  const p = Q.isNum(level) ? level : (Q.isNum(item.serviceLevel) ? item.serviceLevel : s.serviceLevel);
  const dist = wasteDistOf(item, settings);
  const w = (DISTS[s.dist] || DISTS.pert).inv(p, dist);
  return { ...item, wasteRate: Q.roundTo(w, 6), _serviceLevel: p, _wasteSource: dist.source };
}

/**
 * 由歷史實績反算損耗區間 —— 讓慣例值有機會被你們自己的資料取代。
 * records: [{ theoretical, actual }]，損耗率 = actual/theoretical − 1。
 */
export function calibrateFromHistory(records = []) {
  const w = records
    .filter((r) => Q.isNum(r.theoretical) && r.theoretical > 0 && Q.isNum(r.actual))
    .map((r) => r.actual / r.theoretical - 1)
    .filter((x) => Number.isFinite(x))
    .sort((a, b) => a - b);
  if (w.length < 5) return { error: `樣本只有 ${w.length} 筆，少於 5 筆不足以估分布 —— 寧可繼續用慣例值並註明，也不要用 3 筆資料假裝有統計基礎` };
  const arr = Float64Array.from(w);
  return {
    n: w.length,
    min: Q.roundTo(Math.max(0, quantile(arr, 0.05)), 4),
    mode: Q.roundTo(quantile(arr, 0.5), 4),
    max: Q.roundTo(quantile(arr, 0.95), 4),
    observed: { p5: quantile(arr, 0.05), p50: quantile(arr, 0.5), p95: quantile(arr, 0.95) },
    note: '以實績 P5／P50／P95 作為三角/PERT 的三個參數。樣本越多越可信。',
  };
}
