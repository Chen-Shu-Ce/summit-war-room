/**
 * pricing.js — 原料行情連動（純函式，無 DOM、無 I/O）
 *
 * 這個模組刻意**不做**的事：不把行情價當成單價，也不預測價格。
 *
 * 「銅價 13,700 美元，所以電纜多少錢」是錯的問法。
 * 一米 XLPE 電纜的單價裡，銅只佔一部分，其餘是押出、被覆、運費、廠商毛利。
 * 正確的做法是**物價指數調整式**：只讓單價裡的原料部分隨行情浮動，其餘固定。
 *
 *   P_adj = P_base × ( a + Σ s_k × I_k / I_k0 )     其中 a = 1 − Σ s_k
 *         = P_base × ( 1 + Σ s_k × (I_k/I_k0 − 1) )
 *
 * 這就是 FIDIC Red Book 13.8（Adjustments for Changes in Cost）的結構，
 * 也是台灣公共工程物價指數調整條款的結構。`a` 是不調整部分。
 *
 * 三個一定要做對、否則整套數字都是假的地方：
 *   1. 幣別 —— 銅鋁 PP 報美元、鋼報台幣。銅漲 10% 而台幣貶 5%，台幣成本是漲 15.5%，不是 10%。
 *   2. 基準日 —— 不知道 NT$780 是在哪個行情水準報的，就算不出調整額。沒有基準就回 0，不猜。
 *   3. 指數對應 —— SUS304 的價格由鎳driven，不是鋼筋。行情表沒有鎳指數，就標「無指數」，不硬接。
 */

import * as Q from './quantity.js';

/* ────────── 指數定義 ────────── */

export const INDEX_META = {
  copper:    { id: 'copper',    label: '銅',     ccy: 'USD', per: 't', src: 'LME Copper' },
  aluminium: { id: 'aluminium', label: '鋁',     ccy: 'USD', per: 't', src: 'LME Aluminium' },
  steel:     { id: 'steel',     label: '鋼',     ccy: 'TWD', per: 't', src: '中鋼盤元' },
  pp:        { id: 'pp',        label: '塑膠粒', ccy: 'USD', per: 't', src: 'PP Resin' },
};

export const LINKABLE = ['copper', 'aluminium', 'steel', 'pp'];

/** 連動品質。這是誠實欄位，不是裝飾。 */
export const LINK_GRADE = {
  direct:   { label: '直接',   level: 'ok',   note: '指數標的就是該材料主成分，走勢可直接套用。' },
  proxy:    { label: '代理',   level: 'warn', note: '相關但非同一材料，走勢只有部分重合，幅度會失真。' },
  estimate: { label: '估計',   level: 'warn', note: '原料用量為概估，應以廠商自己的原料調整條款取代。' },
  none:     { label: '無指數', level: 'bad',  note: '行情表沒有對應指數，不得連動 —— 硬接一個相近的指數只會產生看起來很精確的錯誤。' },
};

/** 合理的原料佔比區間。落在區間外代表資料有問題，不是行情有問題。 */
export const SHARE_MIN = 0.02;
export const SHARE_MAX = 1;

/* ────────── 指數正規化（一律換成 台幣/公斤） ────────── */

/**
 * 把行情表的一筆報價換成「台幣每公斤」。
 * 美元報價會乘上匯率 —— 漏掉這一步，台幣貶值造成的成本上升就會憑空消失。
 */
export function indexTwdPerKg(market, id) {
  const meta = INDEX_META[id];
  if (!meta || !market) return null;
  const items = market.items || [];
  const row = items.find((x) => x.id === id);
  if (!row || !Q.isNum(row.price)) return null;
  let fx = 1;
  if (meta.ccy === 'USD') {
    const f = items.find((x) => x.id === 'fx');
    if (!f || !Q.isNum(f.price) || f.price <= 0) return null;   // 沒有匯率就算不出台幣價，不用預設值蒙混
    fx = f.price;
  }
  return {
    id, label: meta.label, ccy: meta.ccy,
    quoted: row.price, fx,
    twdPerKg: (row.price * fx) / 1000,
    changePct: Q.isNum(row.changePct) ? row.changePct : null,
  };
}

/**
 * 凍結一份行情快照。
 * Baseline 凍結時必須連同快照一起存 —— 否則行情每天在動，
 * 對照基準版就會天天冒出「單價變了」的幽靈差異，而其實沒有人改過任何東西。
 */
export function snapshotIndices(market, at) {
  const out = { at: at || (market && market.updatedAt) || new Date().toISOString(), idx: {} };
  for (const id of LINKABLE) {
    const v = indexTwdPerKg(market, id);
    if (v) out.idx[id] = { twdPerKg: v.twdPerKg, quoted: v.quoted, fx: v.fx, ccy: v.ccy };
  }
  const f = market && (market.items || []).find((x) => x.id === 'fx');
  out.fx = f && Q.isNum(f.price) ? f.price : null;
  out.mode = market && market.mode ? market.mode : null;
  out.sourceUpdatedAt = market && market.sourceUpdatedAt ? market.sourceUpdatedAt : null;
  return out;
}

export function indexAt(snap, id) {
  const v = snap && snap.idx && snap.idx[id];
  return v && Q.isNum(v.twdPerKg) ? v.twdPerKg : null;
}

/* ────────── 原料佔比 ────────── */

/**
 * 算出這個工項對某個指數的原料佔比 s。
 *
 * 兩種來源，優先用前者：
 *   kg  —— 每單位的原料用量（公斤）。s = kg × 指數 / 基準單價。
 *          可稽核：1.02 kg 銅/M 可以拿電纜規格書去對，而「57%」不能。
 *   share —— 直接宣告的佔比。用於算不出用量的組裝品（盤體、主機）。
 */
export function shareOf(link, basePrice, baseIdx) {
  if (!link || !Q.isNum(basePrice) || basePrice <= 0) return null;
  if (Q.isNum(link.kg) && Q.isNum(baseIdx)) {
    return { share: (link.kg * baseIdx) / basePrice, from: 'kg', kg: link.kg };
  }
  if (Q.isNum(link.share)) return { share: link.share, from: 'share' };
  return null;
}

/**
 * 檢查連動設定站不站得住腳。
 * 這裡擋掉的是資料錯誤，不是行情異常 —— 兩者混在一起會讓人怪錯對象。
 */
export function validateLink(item, snap) {
  const links = (item && item.priceLink) || [];
  const errs = [];
  if (!links.length) return { ok: true, errs, total: 0 };
  if (!Q.isNum(item.unitPrice) || item.unitPrice <= 0) {
    errs.push({ level: 'bad', msg: '沒有基準單價，無法連動。' });
    return { ok: false, errs, total: 0 };
  }
  let total = 0;
  for (const l of links) {
    const meta = INDEX_META[l.index];
    if (!meta) { errs.push({ level: 'bad', index: l.index, msg: `行情表沒有「${l.index}」這個指數。` }); continue; }
    // 標記為 none 是一個刻意的判斷（例如不鏽鋼），不是錯誤。它代表「這筆曝險量不出來」，要被看見而不是被當成錯誤吞掉。
    if (l.grade === 'none') {
      errs.push({ level: 'info', index: l.index, msg: `${meta.label}：已判定無對應指數，不連動。${l.note || ''}這筆金額的原料曝險仍然存在，只是這張行情表量不出來。` });
      continue;
    }
    const baseIdx = indexAt(item.priceBase || snap, l.index);
    const s = shareOf(l, item.unitPrice, baseIdx);
    if (!s) { errs.push({ level: 'warn', index: l.index, msg: `${meta.label}：缺用量或佔比，無法計算。` }); continue; }
    if (s.share <= 0) { errs.push({ level: 'bad', index: l.index, msg: `${meta.label}：佔比為 0 或負值。` }); continue; }
    if (s.share < SHARE_MIN) {
      // 組裝品（estimate）的原料佔比本來就低 —— 一台冰水主機的價值在壓縮機與變頻器，不在鋼板。
      // 但「材料本身就是產品」的直接／代理連動若算出極低佔比，幾乎一定是單價的單位錯了。
      errs.push(l.grade === 'estimate'
        ? { level: 'info', index: l.index, msg: `${meta.label}：佔比僅 ${(s.share * 100).toFixed(1)}%。組裝品的價值不在原料，連動幾乎沒有影響 —— 這是預期內的。` }
        : { level: 'warn', index: l.index, msg: `${meta.label}：佔比僅 ${(s.share * 100).toFixed(1)}%，低於 ${SHARE_MIN * 100}%。這個工項的材料本身就是產品，佔比不該這麼低 —— 單價的單位很可能錯了（例如填成整捲／整箱價）。` });
    }
    if (s.share > SHARE_MAX) {
      errs.push({ level: 'bad', index: l.index, msg: `${meta.label}：佔比 ${(s.share * 100).toFixed(0)}% 超過 100%，代表單價低於原料成本。這不可能 —— 是單價、用量或單位錯了。` });
    }
    total += s.share;
  }
  if (total > SHARE_MAX) {
    errs.push({ level: 'bad', msg: `各指數佔比合計 ${(total * 100).toFixed(0)}%，超過 100%。` });
  }
  return { ok: !errs.some((e) => e.level === 'bad'), errs, total };
}

/* ────────── 連動後單價 ────────── */

/**
 * 依物價指數調整式算出連動後單價。
 *
 * 沒有價格基準快照（item.priceBase）時回 0 調整，並明白說明原因。
 * 拿今天的行情同時當基準與現值，調整額必然是 0 —— 那不是「沒有波動」，是「沒有基準」。
 * 很多工具在這裡靜默地混過去，然後宣稱自己在跑即時行情。
 */
export function linkedPrice(item, snap) {
  const base = Q.isNum(item && item.unitPrice) ? item.unitPrice : null;
  const links = (item && item.priceLink || []).filter((l) => l.grade !== 'none' && INDEX_META[l.index]);
  const out = {
    itemCode: item && item.code, basePrice: base, price: base,
    delta: 0, deltaPct: 0, parts: [], fixedShare: 1,
    linked: false, reason: null, baseAt: (item && item.priceBase && item.priceBase.at) || null,
  };
  if (base == null) { out.reason = 'no-price'; return out; }
  if (!links.length) { out.reason = 'no-link'; return out; }
  if (!item.priceBase) { out.reason = 'no-base'; return out; }

  let adj = 0, sumShare = 0;
  for (const l of links) {
    const i0 = indexAt(item.priceBase, l.index);
    const i1 = indexAt(snap, l.index);
    const s = shareOf(l, base, i0);
    if (!s || !Q.isNum(i0) || !Q.isNum(i1) || i0 <= 0) continue;
    const ratio = i1 / i0;
    const contrib = s.share * (ratio - 1);
    adj += contrib;
    sumShare += s.share;
    out.parts.push({
      index: l.index, label: INDEX_META[l.index].label, grade: l.grade || 'proxy',
      share: s.share, from: s.from, kg: s.kg ?? null,
      base: i0, now: i1, ratio, contribPct: contrib * 100, contribAmt: base * contrib,
    });
  }
  if (!out.parts.length) { out.reason = 'no-index'; return out; }
  out.linked = true;
  out.fixedShare = 1 - sumShare;
  out.delta = base * adj;
  out.deltaPct = adj * 100;
  out.price = base + out.delta;
  return out;
}

export const LINK_REASON = {
  'no-price': '沒有基準單價。',
  'no-link': '未設定原料連動。',
  'no-base': '沒有價格基準日 —— 不知道這個單價是在哪個行情水準報的，就算不出調整額。請先凍結一次行情基準。',
  'no-index': '設定的指數在目前行情表中都取不到值。',
};

/* ────────── 曝險與敏感度（不預測，只量化） ────────── */

/**
 * 一個工項的原料曝險：採購金額裡有多少錢是隨行情浮動的。
 * 這是可以講給老闆聽的數字 ——「銅漲 10%，這批線多付 NT$X」，
 * 而不是「銅價 13,700 美元」這種對採購決策毫無用處的資訊。
 */
export function exposure(item, qty, snap) {
  const lp = linkedPrice(item, snap);
  const price = Q.isNum(lp.price) ? lp.price : (item.unitPrice ?? 0);
  const amount = Q.isNum(qty) ? qty * price : 0;
  const by = {};
  let total = 0;
  const links = (item.priceLink || []).filter((l) => l.grade !== 'none' && INDEX_META[l.index]);
  for (const l of links) {
    const i0 = indexAt(item.priceBase || snap, l.index);
    const i1 = indexAt(snap, l.index);
    const s = shareOf(l, item.unitPrice, i0);
    if (!s || s.share <= 0 || !Q.isNum(i1) || !Q.isNum(i0) || i0 <= 0) continue;
    // 曝險要用**現在**的原料價值算，不是基準日的佔比。
    // 原料漲了而加工運費毛利沒漲，原料佔比就變大了 —— 沿用基準日的佔比會低估曝險，
    // 而低估正是這個模組最不能犯的錯。
    const matUnit = s.from === 'kg' ? s.kg * i1 : s.share * item.unitPrice * (i1 / i0);
    const amt = (Q.isNum(qty) ? qty : 0) * matUnit;
    by[l.index] = (by[l.index] || 0) + amt;
    total += amt;
  }
  const uncovered = (item.priceLink || []).some((l) => l.grade === 'none') && total === 0;
  return {
    itemCode: item.code, itemName: item.name, qty, unit: item.unit,
    basePrice: item.unitPrice ?? null, price, amount,
    by, exposed: total, fixed: uncovered ? 0 : amount - total,
    exposedPct: amount > 0 ? (total / amount) * 100 : 0,
    uncovered,
    grades: links.map((l) => l.grade || 'proxy'),
    linked: lp.linked, reason: lp.reason,
  };
}

export function portfolioExposure(rows) {
  const by = {};
  let amount = 0, exposed = 0, uncovered = 0, unlinked = 0;
  const uncoveredRows = [];
  for (const r of rows) {
    amount += r.amount || 0;
    exposed += r.exposed || 0;
    for (const [k, v] of Object.entries(r.by || {})) by[k] = (by[k] || 0) + v;
    // 明確判定「無指數」的工項（不鏽鋼等）仍有原料曝險，只是這張表量不出來。
    // 把它併進「固定」會讓總曝險被低估，而低估比高估危險。
    if (r.uncovered) { uncovered += r.amount || 0; uncoveredRows.push({ code: r.itemCode, name: r.itemName, amount: r.amount || 0 }); }
    else if (!r.linked && r.reason === 'no-link') unlinked += r.amount || 0;
  }
  const ranked = Object.entries(by).map(([id, amt]) => ({
    id, label: (INDEX_META[id] || {}).label || id, amount: amt,
    pct: amount > 0 ? (amt / amount) * 100 : 0,
  })).sort((a, b) => b.amount - a.amount);
  uncoveredRows.sort((a, b) => b.amount - a.amount);
  return {
    amount, exposed, fixed: amount - exposed - uncovered,
    exposedPct: amount > 0 ? (exposed / amount) * 100 : 0,
    uncovered, uncoveredPct: amount > 0 ? (uncovered / amount) * 100 : 0, uncoveredRows,
    unlinked,
    by: ranked,
  };
}

/**
 * 敏感度：每個指數各自 ±shock 時，總金額變多少。
 * 這是情境，不是預測。沒有人知道銅價下個月往哪走 ——
 * 但「往上走 10% 我要多付 NT$X」是現在就能知道、而且能拿去談判的。
 */
export function sensitivity(rows, shocks = [-0.1, -0.05, 0.05, 0.1]) {
  const port = portfolioExposure(rows);
  return port.by.map((b) => ({
    id: b.id, label: b.label, exposure: b.amount,
    cells: shocks.map((s) => ({ shock: s, delta: b.amount * s })),
  }));
}

/* ────────── 鎖價窗口（接施工工序的反推日期） ────────── */

/**
 * 議價窗口：從今天到建議發包日，還剩幾天可以談。
 * 發包當天價格就定了 —— 在那之後行情怎麼走都跟這一批無關，
 * 所以「要不要現在鎖價」這個問題，只有在窗口還開著的時候才存在。
 */
export function lockWindow(chain, today) {
  if (!chain || !chain.poBy) return null;
  const t = today ? new Date(today) : new Date();
  const iso = t.toISOString().slice(0, 10);
  const days = Math.round((new Date(chain.poBy + 'T00:00:00Z') - new Date(iso + 'T00:00:00Z')) / 86400000);
  return {
    itemCode: chain.itemCode, poBy: chain.poBy, needOnSite: chain.needOnSite,
    days,
    state: days < 0 ? 'passed' : days <= 14 ? 'closing' : 'open',
  };
}

/* ────────── 由規格猜連動設定（只是建議，不是事實） ────────── */

const SUGGEST_RULES = [
  // 不鏽鋼一律不連動：價格由鎳與鉻主導，行情表沒有鎳指數
  { re: /SUS\s?3\d\d|不鏽鋼/i, links: [{ index: 'steel', grade: 'none' }],
    why: '不鏽鋼價格由鎳（SUS304 約含 8%）與鉻主導，與鋼筋盤元走勢脫鉤。行情表沒有鎳指數，因此不連動。' },
  { re: /CU\/XLPE|電力電纜|絕緣電線|接地線|裸銅|銅導體/i, links: [{ index: 'copper', grade: 'direct' }],
    why: '導體為銅，可由截面積與 8.96 g/cm³ 推算每米銅重，是最乾淨的連動。' },
  { re: /竹節鋼筋|鋼筋|SD\d{3}/i, links: [{ index: 'steel', grade: 'direct', kg: 1 }],
    why: '鋼筋就是指數標的本身，每公斤用量為 1。' },
  { re: /鍍鋅|黑鐵管|SGP|RSC|Cable\s?Tray|電纜架|鐵板風管|防火門/i, links: [{ index: 'steel', grade: 'proxy' }],
    why: '碳鋼製品。指數為中鋼盤元（鋼筋用），與熱軋鋼捲、鍍鋅鋼板走勢相關但不相同，幅度會失真。' },
  { re: /PVC/i, links: [{ index: 'pp', grade: 'proxy' }],
    why: 'PVC 以乙烯與氯為原料，PP 以丙烯為原料，兩者原料不同。僅同屬石化下游而有弱相關 —— 這是所有連動裡最弱的一條。' },
  { re: /冰水主機|箱型|壓縮機|冷卻水塔/i,
    links: [{ index: 'copper', grade: 'estimate' }, { index: 'aluminium', grade: 'estimate' }, { index: 'steel', grade: 'estimate' }],
    why: '熱交換器銅管、冷凝器鋁鰭片、機殼與壓縮機鋼件。用量為概估，應以廠商自己的原料調整條款取代。' },
  { re: /配電盤|MCC|匯流排|開關箱/i,
    links: [{ index: 'copper', grade: 'estimate' }, { index: 'steel', grade: 'estimate' }],
    why: '銅匯流排與鋼製盤體。用量隨額定電流與防護等級變動很大，屬概估。' },
];

/** 由規格文字建議連動設定。回傳的是**建議**，未填用量前不會產生任何調整額。 */
export function suggestLink(item) {
  const text = `${item.name || ''} ${item.spec || ''}`;
  for (const r of SUGGEST_RULES) {
    if (r.re.test(text)) return { links: r.links.map((l) => ({ ...l })), why: r.why, suggested: true };
  }
  return null;
}

/** 由導體規格（如 3C×38mm²、1C×22mm²）推算每米銅重（kg/M）。算不出就回 null，不猜。 */
export function copperKgPerM(spec) {
  const m = String(spec || '').match(/(\d+)\s*C\s*[×xX*]\s*([\d.]+)\s*(?:mm2|mm²|SQ)/i);
  if (m) {
    const cores = parseInt(m[1], 10), area = parseFloat(m[2]);
    if (cores > 0 && area > 0) return +(cores * area * 8.96 / 1000).toFixed(4);
  }
  const s = String(spec || '').match(/(?:^|[^0-9])([\d.]+)\s*(?:mm2|mm²|SQ)/i);
  if (s) {
    const area = parseFloat(s[1]);
    if (area > 0) return +(area * 8.96 / 1000).toFixed(4);
  }
  return null;
}
