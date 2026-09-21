/**
 * pcces.js —— 公共工程細目編碼（PCCES）標單的匯入與匯出。
 *
 * ── 為什麼這是整個造價方向的關鍵 ──
 *
 * 工具原本用的是自訂 WBS 與自訂工項碼，跟任何官方體系都對不起來。
 * 做出來的 Excel 再漂亮，都不能當標單交出去，因為機關要的是
 * PCCES 的四表：總表、詳細價目表、單價分析表、資源統計表。
 *
 * PCCES 檔案本身就帶著使用者一直說「沒有電子檔」的那份工項編碼表 ——
 * 細目碼、工項名稱、單位、單價分析的工料組成，全都在標單裡。
 * 所以正確的方向不是自己編一套碼，是**把他們的標單讀進來當骨架**，
 * 算量掛上去，再照原格式吐回去。
 *
 * ── 這個模組刻意不做的事 ──
 *
 * 不驗證細目碼是否合乎工程會最新版編碼規則。碼長在真實檔案裡
 * 從 10 到 15 都有（12 碼最多），還有 `,#`、`,*` 這類旗標。
 * 拿一套自己猜的規則去擋使用者的真實資料，只會擋錯。
 * 這裡忠實保留原字串，不改寫、不補零、不截斷。
 */

const s = (v) => String(v ?? '').trim();
/** 把全形空白與連續空白壓掉再比對 —— PCCES 的表頭是「項 次」「項  目  及  說  明」。 */
const squash = (v) => s(v).replace(/[\s　]+/g, '');
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** 「1,234.5」「 12 」→ 數字；空白或非數字 → null（不是 0）。 */
export function num(v) {
  const t = s(v).replace(/,/g, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/* ────────── 詳細價目表 ────────── */

/** 詳細價目表的欄位位置。以表頭文字定位，不寫死欄號。 */
const DETAIL_COLS = [
  { key: 'no', names: ['項次'] },
  { key: 'name', names: ['項目及說明', '工作項目'] },
  { key: 'unit', names: ['單位'] },
  { key: 'qty', names: ['數量'] },
  { key: 'unitPrice', names: ['單價'] },
  { key: 'amount', names: ['複價'] },
  { key: 'code', names: ['編碼(備註)', '編碼', '編碼（備註）'] },
  { key: 'weight', names: ['權重比%', '權重比'] },
];

/**
 * 找表頭列並回傳「欄位 → 欄號」。
 * 真實檔案前面有機關名稱、工程名稱、日期等好幾列，不能假設表頭在第 1 列。
 */
export function findHeader(rows, cols = DETAIL_COLS) {
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const r = rows[i] || [];
    const map = {};
    r.forEach((cell, j) => {
      const t = squash(cell);
      if (!t) return;
      for (const c of cols) if (c.names.some((n) => squash(n) === t) && map[c.key] == null) map[c.key] = j;
    });
    // 至少要同時認得「項次」與「數量」才算表頭，避免把總表的標題列誤判成表頭
    if (map.no != null && map.qty != null) return { row: i, map };
  }
  return null;
}

/**
 * 解析詳細價目表。
 *
 * 兩個在真實檔案裡一定會遇到、不處理就會出錯的狀況：
 *
 * 1. **名稱會跨列**。「施工圍籬，安全圍籬,甲種安全圍籬」下一列接
 *    「240cm含止水墩、夜間警示燈)」。續列的項次是空的。
 * 2. **續列也可能有數字**（複價欄 0、編碼欄 `,*`）。
 *    所以判斷「是不是新的一列工項」只能看項次欄，不能看有沒有數字 ——
 *    看數字會把續列當成一筆金額 0 的工項，混進項數統計裡。
 */
export function parseDetail(rows) {
  const h = findHeader(rows);
  if (!h) return { error: '找不到詳細價目表的表頭（需要同時有「項次」與「數量」欄）' };
  const { map } = h;
  const at = (r, k) => (map[k] == null ? '' : s(r[map[k]]));
  const items = [];
  let cur = null;

  for (let i = h.row + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const no = at(r, 'no');
    if (!no) {
      // 續列：只補名稱，其餘一律忽略
      const extra = at(r, 'name');
      if (cur && extra) cur.name += extra;
      continue;
    }
    const parts = no.split('.').filter(Boolean);
    const rawCode = at(r, 'code');
    const [code, ...flags] = rawCode.split(',');
    cur = {
      no,
      level: parts.length,
      parent: parts.length > 1 ? parts.slice(0, -1).join('.') : null,
      name: at(r, 'name'),
      unit: at(r, 'unit'),
      qty: num(at(r, 'qty')),
      unitPrice: num(at(r, 'unitPrice')),
      amount: num(at(r, 'amount')),
      code: s(code),
      flags: flags.map(s).filter(Boolean),
      weight: num(at(r, 'weight')),
      row: i,
    };
    items.push(cur);
  }
  return { items, header: h.row, cols: map };
}

/**
 * 分出「有數量的細項」與「純標題層」。
 *
 * 只有細項要算量、要掛單價。標題層（壹、壹.一、壹.一.甲…）的金額是
 * 底下細項加總出來的 —— 把它們也當成工項，金額會被重複計一次以上。
 */
export function leaves(items) {
  const hasChild = new Set(items.map((x) => x.parent).filter(Boolean));
  return items.filter((x) => !hasChild.has(x.no) && x.qty != null);
}

/** 標題層。 */
export function groups(items) {
  const hasChild = new Set(items.map((x) => x.parent).filter(Boolean));
  return items.filter((x) => hasChild.has(x.no));
}

/**
 * 逐層驗算：每一個標題層的金額，是否等於其直屬子項的複價總和。
 *
 * 這是 PCCES 標單自己就帶著的一個**驗算靶** ——
 * 對不上就代表這份標單本身有問題（有人手改了數字、或漏了項），
 * 在把它當成算量骨架之前就該知道。
 */
export function checkRollup(items, tol = 1) {
  const byNo = new Map(items.map((x) => [x.no, x]));
  const kids = new Map();
  for (const x of items) {
    if (!x.parent || !byNo.has(x.parent)) continue;
    if (!kids.has(x.parent)) kids.set(x.parent, []);
    kids.get(x.parent).push(x);
  }
  const bad = [];
  for (const [no, list] of kids) {
    const g = byNo.get(no);
    if (!isNum(g.amount)) continue;
    const sum = list.reduce((a, x) => a + (isNum(x.amount) ? x.amount : 0), 0);
    const diff = Math.round((g.amount - sum) * 100) / 100;
    if (Math.abs(diff) > tol) bad.push({ no, name: g.name, declared: g.amount, sum: Math.round(sum * 100) / 100, diff });
  }
  return bad;
}

/** 每一細項的「單價 × 數量 = 複價」是否對得上。 */
export function checkLineMath(items, tol = 1) {
  const bad = [];
  for (const x of items) {
    if (!isNum(x.qty) || !isNum(x.unitPrice) || !isNum(x.amount)) continue;
    const calc = x.qty * x.unitPrice;
    const diff = Math.round((x.amount - calc) * 100) / 100;
    if (Math.abs(diff) > tol) bad.push({ no: x.no, name: x.name, qty: x.qty, unitPrice: x.unitPrice, declared: x.amount, calc: Math.round(calc * 100) / 100, diff });
  }
  return bad;
}

/* ────────── 單價分析表 ────────── */

/**
 * 解析單價分析表 → 每個工作項目的工料組成。
 *
 * 這一張表是人材機拆分的**唯一可靠來源**。使用者說「單價都靠廠商報價」，
 * 但他們自己的 PCCES 檔案裡就有完整的工料明細 —— 資料一直都在。
 *
 * 表的結構是重複的區塊：
 *   項次：<no> | 工作項目：<name> | 單位：<u> | 計價代碼：<code>
 *   工料名稱 | 單位 | 數量 | 單價 | 複價 | 編碼(備註)
 *   ...明細列...
 */
export function parseAnalysis(rows) {
  const out = [];
  let cur = null;
  const label = (cell) => {
    const t = s(cell);
    const m = t.match(/^(項次|工作項目|單位|計價代碼)[：:]\s*(.*)$/);
    return m ? { k: m[1], v: s(m[2]) } : null;
  };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || [];
    const fields = {};
    let any = false;
    for (const cell of r) {
      const l = label(cell);
      if (l) { fields[l.k] = l.v; any = true; }
    }
    // 「項次：」有時單獨一格、值在下一列的第 0 欄
    if (any && (fields['工作項目'] || fields['計價代碼'])) {
      const no = fields['項次'] || s(r[0]);
      cur = { no: s(no), name: fields['工作項目'] || '', unit: fields['單位'] || '', code: fields['計價代碼'] || '', lines: [] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    // 明細列：第 1 欄有名稱、第 2 欄有單位、第 3 欄是數字
    const nm = s(r[1]), u = s(r[2]), q = num(r[3]);
    if (nm && u && q != null) {
      cur.lines.push({ name: nm, unit: u, qty: q, unitPrice: num(r[4]), amount: num(r[5]), code: s(r[6]).split(',')[0] });
    } else if (nm && !u && cur.lines.length) {
      cur.lines[cur.lines.length - 1].name += nm;   // 工料名稱也會跨列
    }
  }
  return out.filter((x) => x.lines.length);
}

/* ────────── 工料分類：人／材／機 ────────── */

/**
 * PCCES 的資源分類沒有一個放諸四海的欄位，實務上靠工料名稱判斷。
 * 所以這裡**只在看得出來時才分類**，看不出來就是 'unknown' ——
 * 猜錯會讓人工費或材料費整段偏掉，而總價看起來完全正常。
 */
const LABOR = ['工資', '人工', '工班', '技術工', '普通工', '大工', '小工', '模板工', '鋼筋工', '泥水', '油漆工', '電匠', '焊工'];
const MACHINE = ['機具', '機械', '吊車', '怪手', '挖土機', '壓路機', '發電機租', '租賃', '台班', '泵浦車', '拌合'];

export function resourceKind(name) {
  const t = s(name);
  if (!t) return 'unknown';
  if (LABOR.some((k) => t.includes(k))) return 'labor';
  if (MACHINE.some((k) => t.includes(k))) return 'machine';
  return 'material';
}

/**
 * 把一個工作項目的單價拆成材料／人工／機具。
 * 分不出來的歸 unknown，**不併進材料** —— 併進去就等於偷偷假設。
 */
export function splitUnitPrice(analysis) {
  const out = { material: 0, labor: 0, machine: 0, unknown: 0 };
  for (const l of analysis.lines || []) {
    const v = isNum(l.amount) ? l.amount
      : (isNum(l.qty) && isNum(l.unitPrice) ? l.qty * l.unitPrice : null);
    if (v == null) continue;
    out[resourceKind(l.name)] += v;
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  return {
    material: r2(out.material), labor: r2(out.labor), machine: r2(out.machine), unknown: r2(out.unknown),
    total: r2(out.material + out.labor + out.machine + out.unknown),
    complete: out.unknown === 0,
  };
}

/* ────────── 匯出回 PCCES 格式 ────────── */

export const DETAIL_HEAD = ['項 次', '項  目  及  說  明', '單 位', '數 量', '單 價', '複 價', '', '編碼(備註)', '權重比%'];

/**
 * 依原詳細價目表的骨架吐回去，只換掉數量（與連動的複價）。
 *
 * 刻意**只換數量**：項次、細目碼、名稱、單位一律照抄原檔。
 * 那些是機關認的東西，工具沒有立場改；改了就對不上原標單，
 * 而承辦人不會逐列比對，只會看到一份「看起來對」的檔案。
 */
export function toDetailRows(items, qtyByNo = new Map()) {
  const rows = [DETAIL_HEAD.slice()];
  for (const x of items) {
    const q = qtyByNo.has(x.no) ? qtyByNo.get(x.no) : x.qty;
    const amt = isNum(q) && isNum(x.unitPrice) ? Math.round(q * x.unitPrice * 100) / 100 : x.amount;
    rows.push([
      x.no, x.name, x.unit,
      q ?? '', x.unitPrice ?? '', amt ?? '',
      '', [x.code, ...x.flags].filter(Boolean).join(','), x.weight ?? '',
    ]);
  }
  return rows;
}

/** 匯入後的摘要 —— 讓人一眼看出這份標單讀進來多少、對不對得上。 */
export function summary(parsed) {
  const items = parsed.items || [];
  const lv = leaves(items);
  const withCode = lv.filter((x) => x.code).length;
  const priced = lv.filter((x) => isNum(x.unitPrice)).length;
  return {
    rows: items.length,
    groups: groups(items).length,
    leaves: lv.length,
    withCode, noCode: lv.length - withCode,
    priced, unpriced: lv.length - priced,
    total: Math.round(lv.reduce((a, x) => a + (isNum(x.amount) ? x.amount : 0), 0) * 100) / 100,
    rollupErrors: checkRollup(items),
    lineErrors: checkLineMath(lv),
  };
}
