/**
 * 廠商主檔與建議廠商。
 *
 * 原本 `vendor` 只是採購包上的一個自由輸入字串 —— 打錯字就變成另一家，
 * 也沒有任何資料可以回答「為什麼建議這一家」。
 *
 * 這個模組的設計原則跟 layermatch.js 一樣，而且理由更強：
 *
 *   1. **不合格是否決，不是扣分。** 證照過期、被停權、交期趕不上，
 *      分數再高都不能建議 —— 那不是「比較差」，是「不能用」。
 *   2. **分數相近就承認分不出來。** 兩家廠商差 3 分就說某一家比較好，
 *      是拿雜訊當訊號。採購要的是「這兩家你自己比」，不是一個假的排名。
 *   3. **每一分都附理由。** 事後被問「為什麼給這家」要答得出來。
 *      公共工程採購尤其如此。
 *
 * 另外兩件工具必須主動講、而排名本身講不出來的事：
 *
 *   **集中度**：把所有包都給分數最高的那一家，是採購最常見也最貴的錯。
 *   一家出事，整個案子停。排名越準，越會往這個坑裡走 —— 所以要反著提醒。
 *
 *   **關係人疑慮**：幾家「互相競爭」的廠商共用同一個聯絡電話、同一個地址、
 *   同一個負責人或同一個匯款帳戶。這是事實比對，不是指控 ——
 *   工具只負責把它攤開來，判斷是人的事。
 */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const r2 = (v) => Math.round(v * 100) / 100;
const s = (v) => String(v ?? '').trim();

/** 廠商狀態。suspended / blacklisted 是否決，不是扣分。 */
export const STATUS = {
  active: { key: 'active', label: '合格', blocks: false },
  probation: { key: 'probation', label: '觀察中', blocks: false, penalty: 15 },
  suspended: { key: 'suspended', label: '停權', blocks: true },
  blacklisted: { key: 'blacklisted', label: '黑名單', blocks: true },
};

export const WEIGHTS = {
  coverage: 30,      // 品類涵蓋：這家做不做這類東西
  onTime: 25,        // 交期達成率
  quality: 20,       // 品質（以不良率反推）
  price: 15,         // 報價競爭力
  payment: 10,       // 付款條件對我方現金流的好壞
  capacity: 10,      // 產能相對於這一包的金額
  history: 10,       // 合作筆數（有紀錄比沒紀錄可信）
};

/** 前兩名差距在這個比例內視為分不出來。 */
export const TIE_RATIO = 0.08;
/** 單一廠商的發包金額佔比超過這個數就提醒集中度風險。 */
export const CONCENTRATION_WARN = 0.4;

/** 把外部匯入的廠商資料正規化成一致的形狀，缺的欄位就是缺，不假裝有。 */
export function normalize(v = {}) {
  return {
    code: s(v.code) || s(v.taxId) || s(v.name),
    name: s(v.name),
    taxId: s(v.taxId),
    status: STATUS[v.status] ? v.status : 'active',
    categories: (v.categories || []).map(s).filter(Boolean),   // WBS 大類代碼，如 ['321','323']
    leadDays: isNum(v.leadDays) ? v.leadDays : null,
    capacity: isNum(v.capacity) ? v.capacity : null,           // 單月可承接金額
    onTimeRate: isNum(v.onTimeRate) ? v.onTimeRate : null,     // 0–1
    defectRate: isNum(v.defectRate) ? v.defectRate : null,     // 0–1
    priceIndex: isNum(v.priceIndex) ? v.priceIndex : null,     // 1.0 = 市場行情，<1 較便宜
    paymentDays: isNum(v.paymentDays) ? v.paymentDays : null,  // 帳期，越長對我方越好
    orders: isNum(v.orders) ? v.orders : 0,                    // 歷史合作筆數
    certExpiry: s(v.certExpiry),                               // 證照／資格有效期 YYYY-MM-DD
    contact: s(v.contact), phone: s(v.phone), email: s(v.email),
    address: s(v.address), owner: s(v.owner), bankAccount: s(v.bankAccount),
    note: s(v.note),
    demo: !!v.demo,
  };
}

/**
 * 資格檢查 —— 回傳的是**否決理由**，不是扣分項。
 * 空陣列代表這家可以被建議。
 */
export function eligibility(v, opts = {}) {
  const at = opts.at ? new Date(opts.at) : new Date();
  const out = [];
  const st = STATUS[v.status] || STATUS.active;
  if (st.blocks) out.push(`廠商狀態為「${st.label}」`);
  if (v.certExpiry) {
    const exp = new Date(`${v.certExpiry}T23:59:59`);
    if (!Number.isNaN(exp.getTime()) && exp < at) out.push(`資格／證照已於 ${v.certExpiry} 到期`);
  }
  if (opts.needDate && isNum(v.leadDays)) {
    const need = new Date(`${opts.needDate}T00:00:00`);
    const canArrive = new Date(at.getTime() + v.leadDays * 86400000);
    if (!Number.isNaN(need.getTime()) && canArrive > need) {
      out.push(`前置期 ${v.leadDays} 天，趕不上需求到貨日 ${opts.needDate}`);
    }
  }
  return out;
}

/**
 * 單一廠商對某一包的得分。
 *
 * 缺資料就不給那一項的分，也**不給平均值** —— 沒有交期紀錄的廠商
 * 不該因為「大家平均 90%」而拿到 90% 的分。缺資料本身就是一種資訊。
 */
export function scoreVendor(v, pkg = {}, opts = {}) {
  const reasons = [];
  const missing = [];
  let score = 0, possible = 0;

  // 品類涵蓋 —— 完全不涵蓋是否決，不是零分
  const need = (pkg.categories || []).map(s).filter(Boolean);
  possible += WEIGHTS.coverage;
  if (!need.length) {
    score += WEIGHTS.coverage * 0.5;
    reasons.push('這一包沒有標示品類，涵蓋度無法判斷（給一半分）');
  } else {
    const hit = need.filter((c) => v.categories.includes(c));
    if (!hit.length) {
      return { code: v.code, name: v.name, score: 0, reasons: [`不承作本包品類（${need.join('、')}）`],
        missing, blocked: true, blockers: [`不承作本包品類（${need.join('、')}）`] };
    }
    const cov = hit.length / need.length;
    score += WEIGHTS.coverage * cov;
    reasons.push(cov === 1 ? `品類全涵蓋（${hit.join('、')}）`
      : `品類涵蓋 ${hit.length}/${need.length}（缺 ${need.filter((c) => !hit.includes(c)).join('、')}）`);
  }

  possible += WEIGHTS.onTime;
  if (isNum(v.onTimeRate)) {
    score += WEIGHTS.onTime * Math.min(Math.max(v.onTimeRate, 0), 1);
    reasons.push(`交期達成率 ${(v.onTimeRate * 100).toFixed(0)}%`);
  } else missing.push('交期達成率');

  possible += WEIGHTS.quality;
  if (isNum(v.defectRate)) {
    // 不良率 0 → 滿分；5% 以上 → 0 分。營建材料的不良率超過 5% 已經是災難
    const q = Math.max(0, 1 - v.defectRate / 0.05);
    score += WEIGHTS.quality * Math.min(q, 1);
    reasons.push(`不良率 ${(v.defectRate * 100).toFixed(1)}%`);
  } else missing.push('不良率');

  possible += WEIGHTS.price;
  if (isNum(v.priceIndex)) {
    // 0.8 → 滿分；1.2 → 0 分。線性內插
    const p = Math.min(Math.max((1.2 - v.priceIndex) / 0.4, 0), 1);
    score += WEIGHTS.price * p;
    reasons.push(`報價指數 ${v.priceIndex.toFixed(2)}（1.00 = 市場行情）`);
  } else missing.push('報價指數');

  possible += WEIGHTS.payment;
  if (isNum(v.paymentDays)) {
    const p = Math.min(Math.max(v.paymentDays / 90, 0), 1);   // 90 天帳期給滿分
    score += WEIGHTS.payment * p;
    reasons.push(`帳期 ${v.paymentDays} 天`);
  } else missing.push('付款條件');

  possible += WEIGHTS.capacity;
  const amount = isNum(pkg.amount) ? pkg.amount : null;
  if (isNum(v.capacity) && amount != null) {
    if (v.capacity < amount) {
      reasons.push(`月產能 ${v.capacity} 低於本包金額 ${r2(amount)} —— 可能需分批或分包`);
    } else {
      score += WEIGHTS.capacity;
      reasons.push('產能足以承接本包');
    }
  } else missing.push('產能');

  possible += WEIGHTS.history;
  if (v.orders > 0) {
    // 合作 10 筆以上視為有足夠紀錄
    score += WEIGHTS.history * Math.min(v.orders / 10, 1);
    reasons.push(`歷史合作 ${v.orders} 筆`);
  } else {
    reasons.push('無合作紀錄 —— 首次往來，建議先小額試單');
  }

  const st = STATUS[v.status] || STATUS.active;
  if (st.penalty) { score -= st.penalty; reasons.push(`狀態「${st.label}」扣 ${st.penalty} 分`); }

  const blockers = eligibility(v, { at: opts.at, needDate: pkg.needDate });
  return {
    code: v.code, name: v.name,
    score: Math.max(0, Math.round(score)),
    possible: Math.round(possible),
    // 資料完整度：分數是在多少比例的資訊上算出來的。
    // 90 分但只有三成資料，跟 90 分而資料齊全，不是同一件事。
    coverage: possible > 0 ? +(1 - missing.length / 7).toFixed(2) : 0,
    missing, reasons, blocked: blockers.length > 0, blockers,
  };
}

/**
 * 對一包建議廠商。
 *
 * 回傳一定包含 `ambiguous` —— 前兩名太接近時**不指定第一名**。
 * 廠商評分的輸入是歷史統計，本來就有雜訊；差 3 分說某家比較好是自欺。
 */
export function suggest(vendors = [], pkg = {}, opts = {}) {
  const all = vendors.map(normalize).map((v) => scoreVendor(v, pkg, opts));
  const usable = all.filter((x) => !x.blocked).sort((a, b) => b.score - a.score);
  const blocked = all.filter((x) => x.blocked);

  if (!usable.length) {
    return { best: null, ranked: [], blocked, ambiguous: [],
      why: blocked.length ? '所有廠商都不符資格，請看否決理由' : '廠商主檔是空的' };
  }
  const top = usable[0];
  const rivals = usable.filter((x) => x !== top && x.score >= top.score * (1 - TIE_RATIO));
  return {
    best: rivals.length ? null : top.code,
    top: top.code,
    ranked: usable,
    blocked,
    ambiguous: rivals.length ? [top.code, ...rivals.map((x) => x.code)] : [],
    why: rivals.length
      ? `前 ${rivals.length + 1} 家分數相近（${[top, ...rivals].map((x) => `${x.name} ${x.score}`).join('、')}），差距在雜訊範圍內，請人工比較`
      : `${top.name}（${top.score} 分）：${top.reasons.slice(0, 3).join('；')}`,
  };
}

/**
 * 發包集中度。
 *
 * 排名越準，越會把所有包都給同一家 —— 而那是採購最常見也最貴的錯。
 * 這個函式存在的目的就是反著提醒：一家出事，整個案子停。
 *
 * awards: [{ vendor, amount }]
 */
export function concentration(awards = [], opts = {}) {
  const warn = isNum(opts.warn) ? opts.warn : CONCENTRATION_WARN;
  const by = new Map();
  let total = 0;
  for (const a of awards) {
    if (!isNum(a.amount) || a.amount <= 0) continue;
    const k = s(a.vendor) || '（未指定）';
    by.set(k, (by.get(k) || 0) + a.amount);
    total += a.amount;
  }
  const rows = [...by.entries()]
    .map(([vendor, amount]) => ({ vendor, amount: r2(amount), share: total > 0 ? +(amount / total).toFixed(4) : 0 }))
    .sort((a, b) => b.amount - a.amount);
  const over = rows.filter((x) => x.share > warn);
  // Herfindahl 指數：1 = 全部給同一家，越小越分散
  const hhi = rows.reduce((a, x) => a + x.share * x.share, 0);
  return {
    total: r2(total), rows, warn, over, hhi: +hhi.toFixed(4),
    note: over.length
      ? `${over.map((x) => `${x.vendor} 佔 ${(x.share * 100).toFixed(0)}%`).join('、')} —— 單一廠商出事會波及整個案子，建議至少保留第二供應來源。`
      : '發包分布尚可，沒有單一廠商超過門檻。',
  };
}

/** 比對用：去掉空白、全形與常見標點，讓「02-1234-5678」與「0212345678」視為相同。 */
function key(v) {
  return s(v).replace(/[\s\-()（）．.·　]/g, '').toLowerCase();
}

/**
 * 關係人疑慮 —— 幾家「互相競爭」的廠商共用同一組識別資訊。
 *
 * **這是事實比對，不是指控。** 共用地址可能是同一棟商辦，
 * 共用電話可能是總機。工具只負責把它攤開，判斷是人的事 ——
 * 但在三家報價裡有兩家其實是同一個人的情況下，比價本身就沒有意義了。
 */
export function relatedParties(vendors = []) {
  const list = vendors.map(normalize);
  const fields = [
    { key: 'phone', label: '聯絡電話' },
    { key: 'email', label: '電子郵件' },
    { key: 'address', label: '地址' },
    { key: 'owner', label: '負責人' },
    { key: 'bankAccount', label: '匯款帳戶' },
    { key: 'taxId', label: '統一編號' },
  ];
  const out = [];
  for (const f of fields) {
    const by = new Map();
    for (const v of list) {
      const k = key(v[f.key]);
      if (!k) continue;
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(v);
    }
    for (const [k, group] of by) {
      if (group.length < 2) continue;
      out.push({ field: f.key, label: f.label, value: group[0][f.key],
        vendors: group.map((v) => ({ code: v.code, name: v.name })),
        why: `${group.length} 家廠商共用同一組${f.label}` });
    }
  }
  return out;
}

/**
 * 一包的品類：取工項 WBS 大類的相異集合。
 * 建議廠商要先知道「這一包在買什麼」。
 */
export function categoriesOf(items = []) {
  return [...new Set(items.map((it) => s(it.wbs)).filter(Boolean))];
}
