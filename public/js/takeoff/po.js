/**
 * 發包單（PO）。
 *
 * PR 與 PO 的差別不只是換個名字：
 *
 *   PR（請購單）是**對內**的：我要買這些東西，請核准。量是「建議採購量」，
 *                             價是估價時的單價，還沒有對手方。
 *   PO（發包單）是**對外**的：我跟這一家用這個價買這些。它是契約文件，
 *                             有對手方、有議定價、有交貨期、有付款條件。
 *
 * ── 三個一開始就必須做對的結構決定 ──
 *
 * **一、PR 與 PO 是多對多，不是一對一。**
 * 一張 PR 可以拆給兩家廠商（分散風險、或一家產能不夠）；
 * 兩張 PR 也可以合併成一張 PO（同一家廠商合併下單省運費）。
 * 寫死 1:1 之後要改，等於整個資料模型重來。
 *
 * **二、議定價與估價要分開存，不可以覆蓋。**
 * 議價的差額（省下或超出多少）是回饋給估價的唯一依據。
 * 直接把估價改成議定價，等於把「我估得準不準」這個資訊永久刪掉。
 *
 * **三、超發要擋。**
 * 同一張 PR 已經開出去的量 + 這次要開的量 > 請購量，就是超發。
 * 這是採購最容易出事、也最難事後查的一種錯 ——
 * 兩張 PO 各自看都合理，加起來才超過。所以必須在開單當下擋。
 */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const r2 = (v) => Math.round(v * 100) / 100;
const s = (v) => String(v ?? '').trim();

/**
 * 請購單明細的工項代碼欄位叫 `itemCode`（見 baseline.js 的 createPr），
 * 不是 `code`。這裡統一從這個函式取，不要在各處自己寫 `ln.code`。
 *
 * 這一行是踩過坑才有的：原本直接用 `ln.code`，全部讀到 undefined，
 * 於是 `new Map(lines.map(l => [l.code, l]))` 整份只剩一筆，
 * 每一列都拿到最後一列的資料 —— 超發檢查等於完全失效，
 * 而畫面上還是會生出一張看起來正常的發包單。
 */
const codeOf = (ln) => s(ln && (ln.itemCode || ln.code));

export const DEFAULT_PO_TEMPLATE = 'PO-{YYYY}{MM}-{###}';

export const PO_STATUS = {
  draft: { key: 'draft', label: '草稿', editable: true },
  issued: { key: 'issued', label: '已發出', editable: false },
  acked: { key: 'acked', label: '廠商已確認', editable: false },
  closed: { key: 'closed', label: '已結案', editable: false },
  cancelled: { key: 'cancelled', label: '已取消', editable: false },
};

/** 產生單號。與 baseline.js 的 PR 單號格式一致，避免兩套規則。 */
export function nextPoNo(existing = [], template = DEFAULT_PO_TEMPLATE, date = new Date()) {
  const y = date.getFullYear(), m = String(date.getMonth() + 1).padStart(2, '0');
  const prefix = template.replace('{YYYY}', String(y)).replace('{YY}', String(y).slice(2))
    .replace('{MM}', m).replace(/\{#+\}/, '');
  const width = (template.match(/\{(#+)\}/) || [null, '###'])[1].length;
  let max = 0;
  for (const no of existing) {
    if (!String(no).startsWith(prefix)) continue;
    const n = parseInt(String(no).slice(prefix.length), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return prefix + String(max + 1).padStart(width, '0');
}

/**
 * 某張 PR 的每一個工項已經被開了多少 PO 量。
 * 這是擋超發的依據 —— 兩張 PO 各自看都合理，加起來才超過。
 */
export function issuedQty(prNo, pos = []) {
  const out = new Map();
  for (const po of pos) {
    if (po.status === 'cancelled') continue;          // 取消的不佔額度
    for (const ln of po.lines || []) {
      if (s(ln.prNo) !== s(prNo)) continue;
      const c = codeOf(ln);
      out.set(c, (out.get(c) || 0) + (isNum(ln.qty) ? ln.qty : 0));
    }
  }
  return out;
}

/**
 * 從 PR 拉出可開單的明細。
 *
 * remaining = 請購量 − 已開 PO 量。已開滿的不再列出來 ——
 * 列出來只會讓人不小心再開一次。
 */
export function openLines(pr, pos = []) {
  const done = issuedQty(pr.no, pos);
  return (pr.lines || []).map((ln) => {
    const code = codeOf(ln);
    const already = done.get(code) || 0;
    const remaining = r2(Math.max(0, (isNum(ln.qty) ? ln.qty : 0) - already));
    return { ...ln, code, already: r2(already), remaining };
  }).filter((ln) => ln.remaining > 0);
}

/**
 * 開立發包單。
 *
 * payload.lines: [{ code, qty, unitPrice }]  —— qty 與 unitPrice 是**議定後**的值
 * 估價時的單價會另外存成 estUnitPrice，兩者都留著才算得出議價差額。
 */
export function createPo(pr, vendor, payload = {}, existingPos = []) {
  if (!pr || !pr.no) return { error: '沒有來源請購單' };
  const vName = s(vendor && (vendor.name || vendor.code));
  if (!vName) return { error: '必須指定廠商 —— 發包單是對外契約，沒有對手方就不是發包單' };
  const by = s(payload.by);
  if (!by) return { error: '必須填發包人 —— 沒有人負責的發包單不能發出去' };

  const prLine = new Map((pr.lines || []).map((ln) => [codeOf(ln), ln]).filter(([c]) => c));
  if (!prLine.size) return { error: '來源請購單的明細沒有工項代碼，無法對應' };
  const done = issuedQty(pr.no, existingPos);
  const lines = [];
  const rejected = [];

  for (const want of payload.lines || []) {
    const code = codeOf(want);
    // 沒有代碼就直接拒絕 —— 讓它落進 Map 的 undefined 鍵，是上面那段註解講的那個 bug
    if (!code) { rejected.push({ code: '', why: '這一列沒有工項代碼' }); continue; }
    const src = prLine.get(code);
    if (!src) { rejected.push({ code, why: '這個工項不在來源請購單裡' }); continue; }
    const qty = isNum(want.qty) ? want.qty : src.qty;
    if (!isNum(qty) || qty <= 0) { rejected.push({ code, why: '數量必須大於 0' }); continue; }

    // 超發檢查：已開 + 這次 > 請購量
    const already = done.get(code) || 0;
    const allow = (isNum(src.qty) ? src.qty : 0) - already;
    if (qty > allow + 1e-9) {
      rejected.push({ code,
        why: `超發：請購 ${src.qty}${src.unit || ''}，已開 ${r2(already)}，本次 ${qty} —— 超出 ${r2(qty - allow)}` });
      continue;
    }

    const est = isNum(src.unitPrice) ? src.unitPrice : null;
    const neg = isNum(want.unitPrice) ? want.unitPrice : est;
    lines.push({
      prNo: pr.no, code, erpCode: src.erpCode || '', name: src.name, spec: src.spec || '',
      sheetNo: src.sheetNo || '',
      unit: src.unit, qty: r2(qty),
      estUnitPrice: est,                       // 估價時的單價 —— 不覆蓋，這是回饋估價的唯一依據
      unitPrice: neg,                          // 議定單價
      amount: isNum(neg) ? r2(qty * neg) : null,
      estAmount: isNum(est) ? r2(qty * est) : null,
      leadTimeDays: src.leadTimeDays || 0,
    });
  }

  if (!lines.length) {
    return { error: '沒有任何可開立的明細' + (rejected.length ? `（${rejected[0].why}）` : ''), rejected };
  }

  const taxRate = isNum(payload.taxRate) ? payload.taxRate : (isNum(pr.taxRate) ? pr.taxRate : 0.05);
  const subtotal = lines.reduce((a, x) => a + (x.amount || 0), 0);
  const estSubtotal = lines.reduce((a, x) => a + (x.estAmount || 0), 0);
  const tax = subtotal * taxRate;

  const po = {
    no: nextPoNo(existingPos.map((p) => p.no), payload.template || DEFAULT_PO_TEMPLATE, payload.date ? new Date(payload.date) : new Date()),
    at: new Date().toISOString(),
    status: 'draft',
    prNos: [pr.no],
    packageCode: pr.packageCode || '', packageName: pr.packageName || '',
    baselineCode: pr.baselineCode || '',
    vendor: vName, vendorCode: s(vendor.code), vendorTaxId: s(vendor.taxId),
    by, dept: s(payload.dept || pr.dept),
    deliveryDate: s(payload.deliveryDate || pr.needDate),
    deliveryTo: s(payload.deliveryTo),
    paymentTerms: s(payload.paymentTerms) || (isNum(vendor.paymentDays) ? `月結 ${vendor.paymentDays} 天` : ''),
    penaltyClause: s(payload.penaltyClause),
    lines, rejected, taxRate,
    subtotal: r2(subtotal), tax: r2(tax), total: r2(subtotal + tax),
    estSubtotal: r2(estSubtotal),
    // 議價差額：負數 = 談下來了，正數 = 比估價貴。
    // 這是回饋估價準不準的唯一數字，所以放在最上層而不是要人自己減。
    variance: r2(subtotal - estSubtotal),
    variancePct: estSubtotal > 0 ? +((subtotal - estSubtotal) / estSubtotal).toFixed(6) : null,
    note: s(payload.note),
  };
  return { po };
}

/**
 * 開單前的檢查 —— 回傳的是**要人看過才能發出去**的事情。
 * 跟 PR 的 prReadiness 同樣的精神：不擋，但要講。
 */
export function poReadiness(po, opts = {}) {
  const issues = [];
  if (!po) return issues;
  if (!po.deliveryDate) issues.push({ level: 'warn', msg: '沒有交貨日期 —— 逾期罰款無從起算' });
  if (!po.paymentTerms) issues.push({ level: 'warn', msg: '沒有付款條件 —— 帳期未約定' });
  if (!po.penaltyClause) issues.push({ level: 'info', msg: '沒有引用逾期條款 —— 建議註明合約條次' });
  const unpriced = po.lines.filter((x) => !isNum(x.unitPrice));
  if (unpriced.length) {
    issues.push({ level: 'bad', msg: `${unpriced.length} 項沒有議定單價（${unpriced.slice(0, 3).map((x) => x.code).join('、')}）—— 不可發出` });
  }
  // 議價差額異常：比估價貴很多，或便宜到不合理
  if (isNum(po.variancePct)) {
    if (po.variancePct > 0.1) {
      issues.push({ level: 'warn', msg: `議定價比估價高 ${(po.variancePct * 100).toFixed(1)}% —— 確認是漲價還是估價漏了東西` });
    } else if (po.variancePct < -0.25) {
      issues.push({ level: 'warn',
        msg: `議定價比估價低 ${(-po.variancePct * 100).toFixed(1)}% —— 過低的報價要確認規格是否被降級，這是最常見的糾紛起點` });
    }
  }
  if (opts.relatedParties && opts.relatedParties.length) {
    issues.push({ level: 'warn', msg: `此廠商與其他廠商共用識別資訊（${opts.relatedParties.map((x) => x.label).join('、')}）—— 若這幾家一起比過價，比價結果需重新檢視` });
  }
  if (isNum(opts.share) && opts.share > 0.4) {
    issues.push({ level: 'warn', msg: `發包後此廠商佔總發包金額 ${(opts.share * 100).toFixed(0)}% —— 單一廠商出事會波及整個案子` });
  }
  return issues;
}

/** 狀態變更。已發出的不可以再改內容，只能取消後重開 —— 契約文件不能偷偷改。 */
export function setStatus(po, next, by = '') {
  if (!PO_STATUS[next]) return { error: `未知狀態 ${next}` };
  const order = ['draft', 'issued', 'acked', 'closed'];
  const from = order.indexOf(po.status), to = order.indexOf(next);
  if (next !== 'cancelled' && from >= 0 && to >= 0 && to < from) {
    return { error: `不可從「${PO_STATUS[po.status].label}」退回「${PO_STATUS[next].label}」—— 已發出的契約文件不能倒退，要改請取消後重開` };
  }
  return {
    po: { ...po, status: next,
      history: [...(po.history || []), { at: new Date().toISOString(), from: po.status, to: next, by: s(by) }] },
  };
}

/** PR 的達成狀況：這張請購單開了幾張 PO、還剩多少沒開。 */
export function prFulfilment(pr, pos = []) {
  const done = issuedQty(pr.no, pos);
  const rows = (pr.lines || []).map((ln) => {
    const code = codeOf(ln);
    const q = isNum(ln.qty) ? ln.qty : 0;
    const got = done.get(code) || 0;
    return { code, name: ln.name, unit: ln.unit, requested: r2(q), issued: r2(got),
      remaining: r2(Math.max(0, q - got)), full: got + 1e-9 >= q };
  });
  const related = pos.filter((p) => (p.lines || []).some((l) => s(l.prNo) === s(pr.no)) && p.status !== 'cancelled');
  return {
    rows, poCount: related.length, poNos: related.map((p) => p.no),
    complete: rows.every((r) => r.full),
    open: rows.filter((r) => !r.full).length,
  };
}
