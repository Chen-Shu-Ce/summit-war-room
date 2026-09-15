/**
 * units.js — 工程單位與換算（純函式，無 DOM、無 I/O）
 *
 * 原則只有一條：**同維度自動換算，跨維度絕不自動換算。**
 *
 *   M² → 坪        自動（同為面積，係數固定）
 *   CM → M         自動（同為長度）
 *   KG → 公噸       自動（同為質量）
 *   M² → M         **不自動** —— 面積換長度要除以寬度，那個寬度不在圖上，
 *                  是工程判斷。工具會問，不會猜。
 *   只 → 組         **不換** —— 一組含幾只是規格問題，不是單位問題。
 *
 * 台制單位（坪、台尺）是實務必需，換算係數採法定值：
 *   1 台尺 = 10/33 公尺（經濟部標準檢驗局法定換算）
 *   1 坪   = 6 台尺 × 6 台尺 = (60/33)² 平方公尺 ≈ 3.305785 ㎡
 */

export const DIM = { L: '長度', A: '面積', V: '體積', M: '質量', C: '計數' };

const TAI_CHI = 10 / 33;                  // 台尺 → 公尺
const PING = (6 * TAI_CHI) ** 2;          // 坪 → 平方公尺 ≈ 3.3057851

/**
 * 單位表。`toBase` 是「換成該維度基準單位」的係數（長度 M、面積 M2、體積 M3、質量 KG）。
 * 計數單位各自獨立成一個維度：只 ≠ 組 ≠ 台，彼此不可換算。
 */
export const UNITS = {
  // ── 長度（基準 M）
  M:    { dim: 'L', toBase: 1,        label: 'M',  aliases: ['m', '公尺', '米', 'lm', 'LM', 'ｍ'] },
  CM:   { dim: 'L', toBase: 0.01,     label: 'CM', aliases: ['cm', '公分', '厘米', '糎'] },
  MM:   { dim: 'L', toBase: 0.001,    label: 'MM', aliases: ['mm', '公厘', '毫米'] },
  KM:   { dim: 'L', toBase: 1000,     label: 'KM', aliases: ['km', '公里'] },
  IN:   { dim: 'L', toBase: 0.0254,   label: 'IN', aliases: ['in', 'inch', '英吋', '吋'] },
  FT:   { dim: 'L', toBase: 0.3048,   label: 'FT', aliases: ['ft', 'feet', '英尺'] },
  台尺:  { dim: 'L', toBase: TAI_CHI,  label: '台尺', aliases: ['尺'] },

  // ── 面積（基準 M2）
  M2:   { dim: 'A', toBase: 1,        label: 'M2', aliases: ['m2', 'm²', '㎡', '平方公尺', '平方米', 'sqm', 'SQM', 'M²'] },
  CM2:  { dim: 'A', toBase: 0.0001,   label: 'CM2', aliases: ['cm2', 'cm²', '平方公分'] },
  MM2:  { dim: 'A', toBase: 0.000001, label: 'MM2', aliases: ['mm2', 'mm²', '平方公厘'] },
  坪:    { dim: 'A', toBase: PING,     label: '坪', aliases: ['PING', 'ping'] },
  平方台尺: { dim: 'A', toBase: TAI_CHI * TAI_CHI, label: '平方台尺', aliases: ['才'] },
  HA:   { dim: 'A', toBase: 10000,    label: 'HA', aliases: ['ha', '公頃'] },

  // ── 體積（基準 M3）
  M3:   { dim: 'V', toBase: 1,        label: 'M3', aliases: ['m3', 'm³', '㎥', '立方公尺', '立方米', 'CUM', 'cum', 'M³'] },
  L:    { dim: 'V', toBase: 0.001,    label: 'L',  aliases: ['l', 'ltr', '公升', '升'] },
  CM3:  { dim: 'V', toBase: 0.000001, label: 'CM3', aliases: ['cm3', 'cm³', '立方公分', 'cc', 'CC'] },

  // ── 質量（基準 KG）
  KG:   { dim: 'M', toBase: 1,        label: 'KG', aliases: ['kg', '公斤', '瓩'] },
  T:    { dim: 'M', toBase: 1000,     label: 'T',  aliases: ['t', 'ton', 'TON', '公噸', '噸', 'MT'] },
  G:    { dim: 'M', toBase: 0.001,    label: 'G',  aliases: ['g', '公克', '克'] },
};

/** 計數單位。每一種自成一個維度，不與其他計數單位互換。 */
export const COUNT_UNITS = ['只', '個', '座', '台', '組', '式', '樘', '處', '支', '片', '面', '套', '束', '捲', '箱', 'PCS', 'SET', 'EA'];
for (const u of COUNT_UNITS) {
  UNITS[u] = { dim: `C:${u}`, toBase: 1, label: u, aliases: [], count: true };
}

const LOOKUP = new Map();
for (const [key, def] of Object.entries(UNITS)) {
  LOOKUP.set(key, key);
  LOOKUP.set(key.toLowerCase(), key);
  for (const a of (def.aliases || [])) { LOOKUP.set(a, key); LOOKUP.set(String(a).toLowerCase(), key); }
}

/** 把使用者或圖面寫的單位正規化成表內的鍵。認不得就回 null，不亂猜。 */
export function normalize(u) {
  const raw = String(u ?? '').trim();
  if (!raw) return null;
  if (LOOKUP.has(raw)) return LOOKUP.get(raw);
  const stripped = raw.replace(/[\s.．]/g, '');
  if (LOOKUP.has(stripped)) return LOOKUP.get(stripped);
  if (LOOKUP.has(stripped.toLowerCase())) return LOOKUP.get(stripped.toLowerCase());
  return null;
}

export function dimOf(u) {
  const k = normalize(u);
  return k ? UNITS[k].dim : null;
}

export function isCount(u) {
  const k = normalize(u);
  return !!(k && UNITS[k].count);
}

export function labelOf(u) {
  const k = normalize(u);
  return k ? UNITS[k].label : String(u ?? '');
}

/** 同維度之間的換算係數。維度不同或認不得就回 null。 */
export function factor(from, to) {
  const a = normalize(from), b = normalize(to);
  if (!a || !b) return null;
  if (a === b) return 1;
  if (UNITS[a].dim !== UNITS[b].dim) return null;
  return UNITS[a].toBase / UNITS[b].toBase;
}

/**
 * 跨維度需要補的那一個量。這是工程判斷，工具問、不猜。
 *   面積 → 長度：除以寬度      長度 → 面積：乘寬度
 *   體積 → 面積：除以厚度      面積 → 體積：乘厚度
 *   體積 → 長度：除以斷面積    長度 → 體積：乘斷面積
 *   質量 ↔ 任何：需要單位重，且隨材質而異，一律不提供
 */
const BRIDGE = {
  'A>L': { need: '寬度', unit: 'M', op: 'divide', why: '面積除以寬度才是長度。寬度不在算式裡，必須由工程指定。' },
  'L>A': { need: '寬度', unit: 'M', op: 'multiply', why: '長度乘寬度才是面積。' },
  'V>A': { need: '厚度', unit: 'M', op: 'divide', why: '體積除以厚度才是面積。' },
  'A>V': { need: '厚度', unit: 'M', op: 'multiply', why: '面積乘厚度才是體積。' },
  'V>L': { need: '斷面積', unit: 'M2', op: 'divide', why: '體積除以斷面積才是長度。' },
  'L>V': { need: '斷面積', unit: 'M2', op: 'multiply', why: '長度乘斷面積才是體積。' },
};

/** 跨維度換算需要補什麼。補不了（例如質量、計數）就回 null。 */
export function bridgeFor(from, to) {
  const a = dimOf(from), b = dimOf(to);
  if (!a || !b || a === b) return null;
  return BRIDGE[`${a}>${b}`] || null;
}

/**
 * 換算。回傳結果一律帶「怎麼換的」，因為換算是會改變金額的動作，必須可稽核。
 *
 * opts.bridge  跨維度時補上的量（寬度／厚度／斷面積），單位見 bridgeFor().unit
 */
export function convert(value, from, to, opts = {}) {
  if (!Number.isFinite(value)) return { ok: false, reason: 'value', msg: '數值無效。' };
  const a = normalize(from), b = normalize(to);
  if (!a) return { ok: false, reason: 'unknown-from', msg: `認不得單位「${from}」。` };
  if (!b) return { ok: false, reason: 'unknown-to', msg: `認不得單位「${to}」。` };
  if (a === b) return { ok: true, value, factor: 1, from: a, to: b, how: '單位相同，未換算。' };

  const f = factor(a, b);
  if (f !== null) {
    return {
      ok: true, value: value * f, factor: f, from: a, to: b,
      how: `${UNITS[a].label} → ${UNITS[b].label}，係數 ${f.toPrecision(8).replace(/\.?0+$/, '')}。`,
    };
  }

  // 計數單位不與任何東西互換。
  // 兩邊都是計數：一組含幾只是規格問題，不是單位問題。
  // 只有一邊是計數：一片磚等於多少 M²，要看磚的尺寸，那也不是單位問題。
  if (UNITS[a].count && UNITS[b].count) {
    return {
      ok: false, reason: 'count', from: a, to: b,
      msg: `「${UNITS[a].label}」與「${UNITS[b].label}」是不同的計數單位，沒有固定換算比 —— 一組含幾只是規格問題，不是單位問題。`,
    };
  }
  if (UNITS[a].count || UNITS[b].count) {
    const cnt = UNITS[a].count ? UNITS[a] : UNITS[b];
    const msr = UNITS[a].count ? UNITS[b] : UNITS[a];
    return {
      ok: false, reason: 'count', from: a, to: b,
      msg: `「${cnt.label}」是計數單位、「${msr.label}」是${DIM[msr.dim] || msr.dim}單位。一件等於多少${DIM[msr.dim] || ''}要看該件的規格尺寸，那是規格問題，不是單位問題。`,
    };
  }

  const bridge = bridgeFor(a, b);
  if (!bridge) {
    return {
      ok: false, reason: 'incompatible', from: a, to: b,
      msg: `${DIM[UNITS[a].dim] || UNITS[a].dim} 與 ${DIM[UNITS[b].dim] || UNITS[b].dim} 之間沒有通用換算。`,
    };
  }
  const need = opts.bridge;
  if (!Number.isFinite(need) || need <= 0) {
    return {
      ok: false, reason: 'need-bridge', from: a, to: b, bridge,
      msg: `${UNITS[a].label} → ${UNITS[b].label} 需要${bridge.need}（單位 ${bridge.unit}）。${bridge.why}`,
    };
  }
  // 先換到該維度的基準單位，套用橋接量，再換到目標單位
  const baseA = value * UNITS[a].toBase;
  const mid = bridge.op === 'divide' ? baseA / need : baseA * need;
  const out = mid / UNITS[b].toBase;
  return {
    ok: true, value: out, from: a, to: b, bridge, bridgeValue: need,
    how: `${UNITS[a].label} → ${UNITS[b].label}，${bridge.op === 'divide' ? '除以' : '乘以'}${bridge.need} ${need} ${bridge.unit}。`,
  };
}
