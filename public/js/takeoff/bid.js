/**
 * 投標價組成（直接成本 → 投標總價）。
 *
 * 這個模組存在的理由：工具原本算的是**採購成本**，不是**承包價**。
 * 畫面上寫「預估金額 NT$ 47,225,837」，旁邊沒有一個字說明它是什麼 ——
 * 拿它去投標，等於用 0% 間接費、0% 利潤、0% 風險準備的價格投。
 * 數字完全合理，只是少了三層。
 *
 * ── 這裡最容易出錯、也最貴的一件事 ──
 *
 * 「10% 管理費」和「佔合約價 1% 的規費」是**兩種不同的數學**：
 *
 *   加成（markup on cost）：金額 = 基數 × r        → 100 加 10% = 110
 *   毛利率（margin on price）：金額 = 標價 × r      → 標價 = 100 / (1 − 0.10) = 111.11
 *
 * 使用者說規費「佔**合約價**百分之一」—— 那是後者，必須用除的。
 * 用乘的（基數 × 1%）在 10 億的案子上會少算約 100 萬，而且帳面上完全看不出來。
 * 所以每一層都必須明確標示 basis，不能混在一起用一個百分比帶過。
 *
 * ── 疊法 ──
 *
 * 成本基礎的層是**逐層疊加**（每層加在前一層的小計上），因為使用者說的是
 * 「每層 10%」——「層」這個字就是疊上去的意思。利潤算在「成本＋管理費」上，
 * 不是只算在成本上。每一層的計算基數都會回傳，避免爭議。
 *
 * 價格基礎的層一起解聯立：
 *
 *   P = K / (1 − Σp)      K = 成本層疊完 + 風險準備金
 *
 * ── 這個模組不做什麼 ──
 *
 * 不替你決定管理費率、利潤率、準備金率。那是商業與策略決定，
 * 不是能從圖面推導的東西。工具能做的是把直接成本算準，
 * 並提供一個**每一層都攤得開**的加成結構。
 */

/** 加成層的基礎：算在成本上（乘），還是算在標價上（除）。 */
export const BASIS = {
  cost: { key: 'cost', label: '成本加成', hint: '金額 = 前一層小計 × 費率（乘）' },
  price: { key: 'price', label: '佔標價比例', hint: '金額 = 投標價 × 費率（除，需解聯立）' },
};

/**
 * 預設加成層。數字來自使用者自述的實際作法，不是我編的：
 *   管理費 10%、利潤 10%（一口價百分比，逐層疊加）
 *   規費／保險／履約保證 佔合約價 1%（獨立欄位，按標價計）
 *   風險準備金 預設 0 —— 使用者說目前沒有明確編列，所以預設維持現況，
 *     要用就從蒙地卡羅推導（riskReserve），不要拍一個百分比上去。
 */
export const DEFAULT_MARKUPS = [
  { key: 'overhead', label: '工地管理費', rate: 0.10, basis: 'cost', note: '工地管理、假設工程、臨時設施' },
  { key: 'profit', label: '利潤', rate: 0.10, basis: 'cost', note: '算在「成本＋管理費」上' },
  { key: 'fees', label: '規費／保險／履約保證', rate: 0.01, basis: 'price', note: '佔合約價比例，按標價計' },
];

export const DEFAULT_TAX = 0.05;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const r2 = (v) => Math.round(v * 100) / 100;

/**
 * 組出投標價。
 *
 * direct   直接成本（工具算出來的那個數）
 * opts.reserve   風險準備金（金額，非比率 —— 由 riskReserve 推導）
 * opts.shortfall 漏項保留（金額 —— 由 shortfallReserve 推導）
 * opts.markups   加成層
 * opts.taxRate   營業稅
 */
export function buildUp(direct, opts = {}) {
  const markups = opts.markups || DEFAULT_MARKUPS;
  const taxRate = isNum(opts.taxRate) ? opts.taxRate : DEFAULT_TAX;
  const reserve = isNum(opts.reserve) ? opts.reserve : 0;
  const shortfall = isNum(opts.shortfall) ? opts.shortfall : 0;
  if (!isNum(direct)) return { error: '沒有直接成本，無法組價' };

  const lines = [];
  // 漏項保留併進基數 —— 它是「已經知道會有、只是還沒量出來」的成本，
  // 不是風險。把它當風險會低估，因為風險準備金可能被談掉、漏項不會。
  let running = direct + shortfall;
  lines.push({ key: 'direct', label: '直接成本', amount: r2(direct), basis: null, base: null });
  if (shortfall) {
    lines.push({ key: 'shortfall', label: '漏項保留', amount: r2(shortfall), basis: null, base: null,
      note: '自動抓量被擋下或無法分辨的圖層，以同類工項均價估列' });
  }

  const costLayers = markups.filter((m) => m.basis !== 'price');
  const priceLayers = markups.filter((m) => m.basis === 'price');

  for (const m of costLayers) {
    const rate = isNum(m.rate) ? m.rate : 0;
    const amount = running * rate;
    lines.push({ key: m.key, label: m.label, rate, basis: 'cost', base: r2(running), amount: r2(amount), note: m.note });
    running += amount;   // 逐層疊加：下一層算在這一層之後的小計上
  }

  if (reserve) {
    lines.push({ key: 'reserve', label: '風險準備金', amount: r2(reserve), basis: null, base: null,
      note: '由蒙地卡羅在選定服務水準下推導，非固定百分比' });
    running += reserve;
  }

  // 價格基礎的層一起解：P = K / (1 − Σp)
  const sumP = priceLayers.reduce((a, m) => a + (isNum(m.rate) ? m.rate : 0), 0);
  if (sumP >= 1) return { error: `佔標價比例的費率合計 ${(sumP * 100).toFixed(1)}% ≥ 100%，無解` };
  const K = running;
  const preTax = sumP > 0 ? K / (1 - sumP) : K;
  for (const m of priceLayers) {
    const rate = isNum(m.rate) ? m.rate : 0;
    lines.push({ key: m.key, label: m.label, rate, basis: 'price', base: r2(preTax),
      amount: r2(preTax * rate), note: m.note });
  }

  const tax = preTax * taxRate;
  return {
    direct: r2(direct), shortfall: r2(shortfall), reserve: r2(reserve),
    lines, taxRate,
    preTax: r2(preTax), tax: r2(tax), total: r2(preTax + tax),
    // 加成倍率：投標價是直接成本的幾倍。用來一眼看出「我加了多少」
    markupOnDirect: direct > 0 ? +((preTax / direct - 1)).toFixed(6) : null,
  };
}

/**
 * 風險準備金 —— 從模擬結果推導，不是拍一個百分比。
 *
 * 定義：在選定的服務水準下，總成本超出「基準估算」的金額。
 * 基準估算用 P50 而不是模擬的平均 —— 分布右偏時平均會高於中位數，
 * 用平均當基準會讓準備金看起來比實際小。
 *
 * 使用者說目前沒有明確編列準備金。這個函式讓它從「藏在單價裡」
 * 變成「攤在檯面上的一個數字」，可以被討論、被談掉、被記錄。
 */
export function riskReserve(sim, level = 0.8) {
  if (!sim || !sim.cost) return { amount: 0, error: '沒有模擬結果' };
  const key = level >= 0.95 ? 'p95' : level >= 0.9 ? 'p90' : level >= 0.8 ? 'p80' : 'p50';
  const at = sim.cost[key];
  const base = sim.cost.p50;
  if (!isNum(at) || !isNum(base)) return { amount: 0, error: '模擬結果缺少分位數' };
  return {
    amount: r2(Math.max(0, at - base)),
    level, atLabel: key.toUpperCase(), at: r2(at), base: r2(base),
    note: `${key.toUpperCase()} 減 P50。基準取中位數而非平均 —— 分布右偏時平均高於中位數，用平均當基準會低估準備金。`,
  };
}

/**
 * 漏項保留 —— 自動抓量被擋下或無法分辨的圖層，估一個金額出來。
 *
 * 使用者指定用「同類工項的均價」。同類定義為**同一個 WBS 大類**
 * （工項代碼的前綴，例如 321.01 與 321.02 同屬 321）。
 *
 * 關鍵：這些圖層的**幾何量是算得出來的**，算不出來的只是「該算到哪個工項」。
 * 所以不是憑空估，是「已知數量 × 同類均價」。
 *
 * 重複描繪被擋下的圖層用**聯集長度**而不是總長 —— 總長本來就灌了水，
 * 拿灌水的數字去估保留會二次高估。
 *
 * missed: [{ layer, level, qty, unit, candidates:[工項代碼], wbs }]
 */
export function shortfallReserve(missed = [], items = [], opts = {}) {
  const byCode = new Map(items.map((it) => [it.code, it]));
  const rows = [];
  let total = 0;

  for (const m of missed) {
    if (m.level !== 'bad') continue;                 // 只有「擋下」的才估列，未對映的多半是註記層
    if (!isNum(m.qty) || m.qty <= 0) {
      rows.push({ layer: m.layer, amount: 0, why: '無法取得該圖層的幾何量，無法估列' });
      continue;
    }
    // 優先用「分不出來的那幾個候選」的均價；沒有候選才退回同 WBS 大類
    const cands = (m.candidates || []).filter(Boolean);
    let pool = cands.map((c) => byCode.get(c)).filter(Boolean);
    let how = `候選工項（${cands.join('、')}）均價`;
    if (!pool.length && m.wbs) {
      pool = items.filter((it) => String(it.wbs) === String(m.wbs));
      how = `同類 WBS ${m.wbs} 均價`;
    }
    if (!pool.length) {
      // 連一個候選工項都沒有 —— 這一層連「像哪個工項」都判斷不出來。
      // 說清楚，不要顯示「候選工項（）」這種看不懂的空括號。
      rows.push({ layer: m.layer, qty: m.qty, unit: m.unit || '', amount: 0,
        why: '沒有任何候選工項可參考，也沒有 WBS 大類可退回 —— 請人工指定工項後再估列' });
      continue;
    }
    const priced = pool.filter((it) => isNum(it.unitPrice) && it.unitPrice > 0);
    if (!priced.length) {
      rows.push({ layer: m.layer, amount: 0, why: `${how}：同類工項都沒有單價，無法估列` });
      continue;
    }
    const avg = priced.reduce((a, it) => a + it.unitPrice, 0) / priced.length;
    const amount = m.qty * avg;
    total += amount;
    rows.push({
      layer: m.layer, qty: m.qty, unit: m.unit || '', avgPrice: r2(avg), amount: r2(amount),
      why: `${how} NT$ ${r2(avg)} × ${m.qty}${m.unit || ''}（${priced.length} 項有單價）`,
    });
  }

  return {
    amount: r2(total), rows,
    note: '這是估計值，不是量出來的。目的在於讓「這一層沒算到」不要在總價裡變成 0 —— '
      + '漏項在總價裡歸零，是系統性低估，比估得不準危險。',
  };
}

/**
 * 逾期罰款情境 —— 這是情境，不是預測。
 *
 * 使用者的合約是每日千分之一。工序模組算得出要徑與浮時，
 * 但「會延誤幾天」不是工具能預測的，所以這裡只回答
 * 「延誤 N 天要賠多少、吃掉多少利潤」。
 */
export function delayScenarios(contractPrice, profit, dailyRate = 0.001, days = [7, 14, 30, 60, 90]) {
  if (!isNum(contractPrice) || contractPrice <= 0) return [];
  return days.map((d) => {
    const penalty = contractPrice * dailyRate * d;
    return {
      days: d,
      penalty: r2(penalty),
      // 吃掉幾成利潤 —— 這比「賠多少錢」更能說明嚴重性
      profitEaten: isNum(profit) && profit > 0 ? +(penalty / profit).toFixed(4) : null,
      wipesOutProfit: isNum(profit) && profit > 0 && penalty >= profit,
    };
  });
}

/** 罰款吃光利潤需要幾天 —— 一個數字就講完風險。 */
export function breakEvenDelayDays(contractPrice, profit, dailyRate = 0.001) {
  if (!isNum(contractPrice) || contractPrice <= 0 || !isNum(profit) || profit <= 0 || !dailyRate) return null;
  return Math.ceil(profit / (contractPrice * dailyRate));
}

/**
 * 反推：要達到某個目標標價，直接成本的空間剩多少。
 * 業主有預算上限、或要對標競爭對手的價格時用。
 */
export function affordableDirect(targetTotal, opts = {}) {
  const markups = opts.markups || DEFAULT_MARKUPS;
  const taxRate = isNum(opts.taxRate) ? opts.taxRate : DEFAULT_TAX;
  const reserve = isNum(opts.reserve) ? opts.reserve : 0;
  const shortfall = isNum(opts.shortfall) ? opts.shortfall : 0;
  if (!isNum(targetTotal) || targetTotal <= 0) return null;

  const preTax = targetTotal / (1 + taxRate);
  const sumP = markups.filter((m) => m.basis === 'price').reduce((a, m) => a + (m.rate || 0), 0);
  if (sumP >= 1) return null;
  const K = preTax * (1 - sumP);
  const costMul = markups.filter((m) => m.basis !== 'price')
    .reduce((a, m) => a * (1 + (m.rate || 0)), 1);   // 逐層疊加 = 連乘
  const base = (K - reserve) / costMul;
  return r2(base - shortfall);
}
