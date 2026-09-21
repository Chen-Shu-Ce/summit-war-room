/**
 * costing.js —— 造價層。
 *
 * ── 為什麼需要這一層 ──
 *
 * 原本這個工具的鏈是：BOM → 採購包 → 請購單 → 發包單。
 * 那是**採購鏈**，起點是「我要買多少」。
 *
 * 造價的鏈不一樣：計量規則 → 計價數量 → 人材機單價分析 → 複價 → 取費。
 * 起點是「這個工項按什麼規則計、單價怎麼組成」。
 *
 * 兩條鏈算出來的數字**本來就不一樣**，而且不該互相取代：
 *
 *   採購數量 = 計價數量 → 再套包裝倍數、MOQ、訂購單位
 *   計價數量 = 圖面淨量 → 再套損耗率與施工預留
 *
 * 把「建議採購量」當成計價數量送進標單，等於把包裝進位與最小訂購量
 * 一起報給業主 —— 6M/支的管子算 100M 會進位成 102M，那 2M 是採購的事，
 * 不是計價的事。這個錯誤在總價上看起來完全正常。
 *
 * ── 這個模組刻意不做的事 ──
 *
 * 不內建任何定額庫、不內建計量規則（模板扣除規則、鋼筋搭接係數…）。
 * 那些是地區性、法規性的東西（台灣 PCCES、公共工程細目編碼；
 * 大陸 GB50500；英國 NRM/SMM），猜一套出來比沒有更危險。
 * 這裡只提供**結構**：欄位、分級、彙總、與「不確定就不計入總價」的規則。
 */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const s = (v) => String(v ?? '').trim();
const r2 = (v) => Math.round(v * 100) / 100;
const r4 = (v) => Math.round(v * 10000) / 10000;

/* ────────── 信心分數與 A/B/C 分類 ────────── */

/**
 * 信心分級。門檻直接採用使用者給的造價作業規則：
 *
 *   90–100：圖面清楚、尺寸完整、規格明確 → 可直接計算
 *   75–89 ：圖面清楚，但部分規格或施工條件需確認
 *   50–74 ：可初估，但缺尺寸／詳圖／規範／剖面
 *   <50   ：不得納入正式造價，只能列為疑點
 */
export const BANDS = [
  { key: 'A', min: 90, label: '可直接計算', cls: 'A' },
  { key: 'B', min: 75, label: '部分規格待確認', cls: 'B' },
  { key: 'C', min: 50, label: '可初估，缺詳圖／規範', cls: 'B' },
  { key: 'D', min: 0, label: '不得納入正式造價', cls: 'C' },
];

/**
 * A / B / C 三類的意義（使用者定義）：
 *   A：可直接納入 BOM
 *   B：可暫估，但需人工確認
 *   C：不可估，需補圖或詢問設計單位 —— **不得計入正式總價**
 */
export const CLASSES = {
  A: { key: 'A', label: '可直接納入', inTotal: true, needCheck: false },
  B: { key: 'B', label: '可暫估，需人工確認', inTotal: true, needCheck: true },
  C: { key: 'C', label: '不可估，需補圖／詢問設計單位', inTotal: false, needCheck: true },
};

/** 風險等級：由分類與價格敏感度合併判定。C 類一律高風險。 */
export const RISK = { high: '高', mid: '中', low: '低' };

export function classify(score) {
  const n = isNum(score) ? score : 0;
  const b = BANDS.find((x) => n >= x.min) || BANDS[BANDS.length - 1];
  return { score: n, band: b.key, bandLabel: b.label, cls: b.cls, ...CLASSES[b.cls] };
}

/* ────────── 價格波動敏感的材料 ────────── */

/**
 * 使用者指名要另外列為敏感項目的材料。
 * 比對的是**工項名稱與規格**的合併字串，不是猜的 —— 比不到就不是敏感項，
 * 不會因為「看起來像金屬」就被標記。
 */
export const SENSITIVE = [
  { key: 'cu', label: '銅', pats: ['銅', 'CU', 'COPPER'] },
  { key: 'al', label: '鋁', pats: ['鋁', 'AL/', 'ALUM'] },
  { key: 'fe', label: '鋼', pats: ['鋼', 'STEEL', 'SS400', 'SUS'] },
  { key: 'pvc', label: 'PVC', pats: ['PVC', '塑膠'] },
  { key: 'cable', label: '電纜', pats: ['電纜', 'CABLE', 'XLPE'] },
  { key: 'gen', label: '發電機', pats: ['發電機', 'GENERATOR'] },
  { key: 'san', label: '衛浴', pats: ['衛浴', '馬桶', '洗面', '面盆'] },
  { key: 'hvac', label: '空調設備', pats: ['空調', '冰水主機', '箱型', 'AHU', 'FCU', 'CHILLER'] },
];

/**
 * 短的英文代號要卡邊界，不可以直接用 includes。
 *
 * `CU` 是銅，但 `CIRCUIT` 裡面也有 CU —— 直接比子字串會把「迴路」
 * 標成價格敏感的銅材。同理 `AL` 之於 `VALVE`、`ALARM`。
 * 中文字不會有這個問題（不是拼音文字），所以只對純 ASCII 的短字樣卡邊界。
 */
function hit(hay, pat) {
  const P = pat.toUpperCase();
  if (/^[A-Z0-9/]{1,3}$/.test(P)) {
    const esc = P.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Z0-9])${esc}([^A-Z0-9]|$)`).test(hay);
  }
  return hay.includes(P);
}

export function sensitivityOf(item) {
  const hay = `${s(item.name)} ${s(item.spec)} ${s(item.material)}`.toUpperCase();
  return SENSITIVE.filter((x) => x.pats.some((p) => hit(hay, p))).map((x) => x.label);
}

/* ────────── 單價：材料／人工／機具 ────────── */

/**
 * 單價取得。
 *
 * 舊資料只有一個 `unitPrice`，**不知道它是材料價還是全包價**。
 * 猜錯的後果不對稱：
 *   - 當成材料價 → 之後填了人工價，總價憑空多一截
 *   - 當成全包價 → 人工欄永遠是空的，但至少不會重複計
 *
 * 所以這裡用 `priceKind` 明講：'all-in'（未拆分，預設）或 'split'（已拆分）。
 * 未拆分時材料／人工欄不會各填一個數字充數，而是標「未拆分」。
 */
export function priceOf(item) {
  const kind = item.priceKind === 'split' ? 'split' : 'all-in';
  const mat = isNum(item.matPrice) ? item.matPrice : null;
  const lab = isNum(item.labPrice) ? item.labPrice : null;
  const eqp = isNum(item.eqpPrice) ? item.eqpPrice : null;
  if (kind === 'split') {
    const parts = [mat, lab, eqp].filter(isNum);
    const missing = [];
    if (mat == null) missing.push('材料');
    if (lab == null) missing.push('人工');
    return {
      kind, mat, lab, eqp,
      total: parts.length ? r4(parts.reduce((a, b) => a + b, 0)) : null,
      missing, quoted: parts.length > 0,
    };
  }
  const all = isNum(item.unitPrice) ? item.unitPrice : null;
  return {
    kind, mat: null, lab: null, eqp: null, total: all,
    missing: all == null ? ['單價'] : [], quoted: all != null, allIn: all,
  };
}

/* ────────── 計價數量 ────────── */

/**
 * 計價數量。
 *
 * 計價數量 = 圖面淨量 × (1 + 損耗率) + 施工預留量
 *
 * ── 一個會重複計而且看不出來的陷阱 ──
 *
 * 如果單價是從**定額**來的，定額的單價分析裡本來就含損耗。
 * 這時再把數量乘一次 (1+損耗率)，損耗就被算了兩次 ——
 * 以 8% 損耗計，總價會多 8%，而每一列看起來都很正常。
 *
 * 所以 `wasteInUnitPrice` 為真時，計價數量 = 淨量，不再乘損耗，
 * 並在計算式裡寫明原因。這個旗標預設 false，但只要單價有值就會提醒。
 */
export function billQty(item, settings = {}) {
  const net = isNum(item.qty && item.qty.drawing) ? item.qty.drawing
    : isNum(item.qty && item.qty.manual) ? item.qty.manual
      : isNum(item.qty && item.qty.boq) ? item.qty.boq : null;
  const src = !isNum(item.qty && item.qty.drawing) && isNum(item.qty && item.qty.manual) ? 'manual'
    : !isNum(item.qty && item.qty.drawing) && isNum(item.qty && item.qty.boq) ? 'boq'
      : isNum(item.qty && item.qty.drawing) ? 'drawing' : null;
  if (net == null) return { net: null, waste: null, reserve: 0, qty: null, src: null, wasteSkipped: false };

  const wasteRate = isNum(item.wasteRate) ? item.wasteRate
    : isNum(settings.defaultWasteRate) ? settings.defaultWasteRate : 0;
  const reserve = isNum(item.reserveQty) ? item.reserveQty : 0;
  const skip = !!settings.wasteInUnitPrice;
  const withWaste = skip ? net : net * (1 + wasteRate);
  return {
    net: r4(net), waste: wasteRate, reserve: r4(reserve),
    qty: r4(withWaste + reserve), src, wasteSkipped: skip,
  };
}

/** 人看得懂、可以自己驗一次的計算式。 */
export function calcExpr(item, bq, settings = {}) {
  if (!bq || bq.qty == null) return '';
  const u = s(item.unit);
  const from = item.calcNote ? s(item.calcNote)
    : item.provenance && item.provenance.kind === 'dxf-layer' ? `圖層 ${s(item.provenance.layer)}`
      : item.provenance && item.provenance.kind === 'measure'
        ? `圖面量測 ${(item.provenance.measurements || []).length} 筆` : '';
  const head = `${from ? from + ' ' : ''}${fmt(bq.net)} ${u}`;
  if (bq.wasteSkipped) {
    return `${head}（損耗已含在單價分析內，不再乘）${bq.reserve ? ` + 預留 ${fmt(bq.reserve)}` : ''} = ${fmt(bq.qty)} ${u}`;
  }
  const w = `× (1 + ${(bq.waste * 100).toFixed(2)}%)`;
  return `${head} ${w}${bq.reserve ? ` + 預留 ${fmt(bq.reserve)} ${u}` : ''} = ${fmt(bq.qty)} ${u}`;
}

function fmt(v, d = 2) {
  if (!isNum(v)) return '—';
  return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/* ────────── 一列造價 BOM ────────── */

/** 使用者指定的 22 欄，順序固定。 */
export const COST_HEAD = ['序號', '系統別', '工程類別', '樓層', '區域', '圖號', '工項名稱', '規格', '材質',
  '單位', '圖面數量', '損耗率', '計價數量', '材料單價', '人工單價', '複價', '計算式', '資料來源',
  '信心分數', '風險等級', '是否需人工確認', '備註'];

const SRC_LABEL = { drawing: '圖面量測／圖層彙總', manual: '人工確認量', boq: '標單／契約量' };

/**
 * 產生一列。
 *
 * ctx 需要：{ seq, score, system, sheetNo, provenanceNote, settings }
 * 分數由外部（quantity.js 的可信度）傳進來 —— 這個模組不自己算可信度，
 * 免得同一件事在兩個地方各算一套、日後分歧。
 */
export function costRow(item, ctx = {}) {
  const st = ctx.settings || {};
  const bq = billQty(item, st);
  const pr = priceOf(item);
  const cl = classify(ctx.score);
  const sens = sensitivityOf(item);

  // 複價：C 類不給金額 —— 給了就會有人把它加進總價
  const amount = cl.inTotal && bq.qty != null && isNum(pr.total) ? r2(bq.qty * pr.total) : null;

  const notes = [];
  if (!pr.quoted) notes.push('待詢價');
  else if (pr.kind === 'all-in') notes.push('單價未拆分人材機');
  else if (pr.missing.length) notes.push(`缺${pr.missing.join('／')}單價`);
  if (bq.wasteSkipped) notes.push('損耗已含在單價分析內');
  if (sens.length) notes.push(`價格敏感：${sens.join('、')}`);
  if (!cl.inTotal) notes.push('不計入正式總價');
  if (ctx.note) notes.push(s(ctx.note));

  const risk = !cl.inTotal ? RISK.high
    : cl.cls === 'B' || sens.length ? RISK.mid : RISK.low;

  return [
    ctx.seq ?? '',
    s(ctx.system) || '未分類',
    s(item.category) || s(ctx.category) || '',
    s(item.floor) || '未指定',
    s(item.area) || '未指定',
    s(ctx.sheetNo) || '',
    s(item.name),
    s(item.spec),
    s(item.material) || '',
    s(item.unit),
    bq.net,
    bq.wasteSkipped ? 0 : r4(bq.waste),
    bq.qty,
    pr.kind === 'split' ? (pr.mat ?? '') : (pr.allIn ?? ''),
    pr.kind === 'split' ? (pr.lab ?? '') : '未拆分',
    amount ?? '',
    calcExpr(item, bq, st),
    bq.src ? SRC_LABEL[bq.src] : '無數量',
    cl.score,
    risk,
    cl.needCheck ? '是' : '否',
    notes.join('；'),
  ];
}

/* ────────── 五張彙總表 ────────── */

const COL = Object.fromEntries(COST_HEAD.map((h, i) => [h, i]));

const num = (v) => (isNum(v) ? v : 0);

/** 依任一欄分組小計。C 類的金額不併入 total，而是單獨列出。 */
function groupSum(rows, colName) {
  const map = new Map();
  for (const r of rows) {
    const k = s(r[COL[colName]]) || '未指定';
    if (!map.has(k)) map.set(k, { key: k, n: 0, amount: 0, excluded: 0, needCheck: 0, high: 0 });
    const g = map.get(k);
    g.n++;
    if (r[COL['是否需人工確認']] === '是') g.needCheck++;
    if (r[COL['風險等級']] === RISK.high) g.high++;
    const amt = num(r[COL['複價']]);
    if (r[COL['備註']].includes('不計入正式總價')) g.excluded++;
    else g.amount += amt;
  }
  return [...map.values()].sort((a, b) => b.amount - a.amount);
}

/**
 * 五張彙總表 + 總計。
 *
 * 最重要的一條規則：**C 類不計入正式總價**，而且要明白寫出「被排除了幾項」。
 * 只給一個總價而不說「另有 12 項不可估」，等於讓人以為這就是全部。
 */
export function summaries(rows) {
  const inTotal = rows.filter((r) => !r[COL['備註']].includes('不計入正式總價'));
  const excluded = rows.filter((r) => r[COL['備註']].includes('不計入正式總價'));
  const unpriced = rows.filter((r) => r[COL['備註']].includes('待詢價'));
  const highRisk = rows.filter((r) => r[COL['風險等級']] === RISK.high);
  return {
    bySystem: groupSum(rows, '系統別'),
    byMaterial: groupSum(rows, '材質'),
    byFloor: groupSum(rows, '樓層'),
    highRisk, unpriced, excluded,
    total: r2(inTotal.reduce((a, r) => a + num(r[COL['複價']]), 0)),
    counts: {
      all: rows.length,
      A: rows.filter((r) => r[COL['信心分數']] >= 90).length,
      B: rows.filter((r) => r[COL['信心分數']] >= 50 && r[COL['信心分數']] < 90).length,
      C: excluded.length,
      needCheck: rows.filter((r) => r[COL['是否需人工確認']] === '是').length,
      unpriced: unpriced.length,
    },
  };
}

/** 彙總表轉成可匯出的列。 */
export function summaryRows(title, groups) {
  return [
    [title, '項數', '金額（不含不可估項）', '需人工確認', '高風險'],
    ...groups.map((g) => [g.key, g.n, g.amount ? r2(g.amount) : '', g.needCheck, g.high]),
  ];
}
