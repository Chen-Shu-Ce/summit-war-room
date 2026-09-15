/**
 * baseline.js — 採購基準版（Baseline）與請購單（PR）。
 *
 * 對應流程圖末段：採購需求/Package → 工程確認 → Baseline/PR → 正式發包。
 *
 * Baseline 的意義不是「禁止改動」，而是讓「改了什麼、誰改的、為什麼」無所遁形。
 * 凍結後資料仍可改，但每一項異動都會被對照出來 —— 這才是基準版的用途。
 *
 * 純函式模組，不依賴 DOM。
 */

import * as Q from './quantity.js';

/* ────────── PR 編號 ────────── */

export const DEFAULT_PR_TEMPLATE = 'PR-{YYYY}{MM}{DD}{SEQ:4}';

const pad = (n, w) => String(n).padStart(w, '0');

/**
 * 依樣板產生編號。支援 {YYYY} {YY} {MM} {DD} {SEQ:n}。
 * 例：'PR-{YYYY}{MM}{DD}{SEQ:4}' + 2026-09-13 + 1 → PR-202609130001
 */
export function formatPrNo(template, date, seq) {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  return String(template || DEFAULT_PR_TEMPLATE)
    .replace(/\{YYYY\}/g, String(d.getFullYear()))
    .replace(/\{YY\}/g, pad(d.getFullYear() % 100, 2))
    .replace(/\{MM\}/g, pad(d.getMonth() + 1, 2))
    .replace(/\{DD\}/g, pad(d.getDate(), 2))
    .replace(/\{SEQ(?::(\d+))?\}/g, (_, w) => pad(seq, Number(w) || 1));
}

/**
 * 由樣板推導流水號的重置範圍 —— 避免「編碼到日、流水號卻全年連續」這種自相矛盾。
 * 可用 override 明確指定。
 */
export function resetScopeOf(template, override) {
  if (override) return override;
  const t = String(template || DEFAULT_PR_TEMPLATE);
  if (t.includes('{DD}')) return 'day';
  if (t.includes('{MM}')) return 'month';
  if (t.includes('{YYYY}') || t.includes('{YY}')) return 'year';
  return 'never';
}

/** 樣板中除了流水號以外的固定前綴（同前綴者視為同一個流水區間）。 */
export function prPrefix(template, date) {
  return formatPrNo(template, date, 0).replace(/\{SEQ(?::\d+)?\}/g, '').replace(/0+$/, '');
}

/**
 * 下一個 PR 編號。
 * existing：已存在的編號陣列。同一重置區間內取最大流水號 +1。
 */
export function nextPrNo(existing = [], template = DEFAULT_PR_TEMPLATE, date = new Date(), override) {
  const scope = resetScopeOf(template, override);
  const d = date instanceof Date ? date : new Date(date);
  const probe = formatPrNo(template, d, 0);
  const seqMatch = String(template).match(/\{SEQ(?::(\d+))?\}/);
  const width = seqMatch ? Number(seqMatch[1]) || 1 : 4;
  const seqAt = probe.length - width;
  const prefix = probe.slice(0, seqAt);

  let max = 0;
  for (const no of existing) {
    const s = String(no || '');
    if (scope !== 'never' && !s.startsWith(prefix)) continue;
    if (scope === 'never' && !s.startsWith(prefix.replace(/\d+$/, ''))) continue;
    const tail = parseInt(s.slice(seqAt), 10);
    if (Number.isFinite(tail)) max = Math.max(max, tail);
  }
  return formatPrNo(template, d, max + 1);
}

/* ────────── Baseline ────────── */

/** 凍結時保存的欄位。改了任何一個，都會在變更對照裡被抓出來。 */
export const TRACKED_FIELDS = [
  { key: 'spec', label: '規格', kind: 'text' },
  { key: 'unit', label: '單位', kind: 'text' },
  { key: 'basis', label: '採購基準', kind: 'text' },
  { key: 'basisValue', label: '基準量', kind: 'number' },
  { key: 'wasteRate', label: '損耗率', kind: 'number' },
  { key: 'suggestQty', label: '建議採購量', kind: 'number' },
  { key: 'orderQty', label: '下單量', kind: 'number' },
  { key: 'deliveredQty', label: '到貨量', kind: 'number' },
  { key: 'unitPrice', label: '單價', kind: 'number' },
  { key: 'cost', label: '預估金額', kind: 'number' },
  { key: 'band', label: '可信度等級', kind: 'text' },
  { key: 'leadTimeDays', label: '前置期', kind: 'number' },
];

/** 把一個工項當下的採購狀態壓成可比對的快照。 */
export function snapshotItem(item, settings) {
  const p = Q.suggestPurchase(item, settings);
  const c = Q.confidence(item, { settings, basis: p.basis });
  return {
    code: item.code, wbs: item.wbs, name: item.name, erpCode: item.erpCode || '',
    spec: item.spec || '', unit: item.unit,
    basis: p.basis.basis ? Q.SOURCE_META[p.basis.basis].label : '待確認',
    basisValue: p.baseQty, wasteRate: p.wasteRate,
    suggestQty: p.suggestQty, orderQty: p.orderQty, orderUnit: p.orderUnit,
    deliveredQty: p.deliveredQty, unitPrice: Q.isNum(item.unitPrice) ? item.unitPrice : null,
    cost: p.cost, score: c.score, band: c.band, leadTimeDays: item.leadTimeDays || 0,
    // 圖號要跟著凍結。基準版是「這個數量當時依據什麼」的證據，
    // 少了出自哪張圖，事後要對帳只能靠記憶。
    sheetNo: (item.provenance && item.provenance.sheetNo) || '',
  };
}

/**
 * 凍結採購包為基準版。
 * 「工程確認」是流程圖上 Package 與 Baseline 之間的那一關 —— 沒有確認人就不是基準版，
 * 只是一份沒人負責的快照，所以這裡強制要求。
 */
export function freezeBaseline(pkg, items, settings, payload = {}) {
  const confirmedBy = String(payload.confirmedBy || '').trim();
  if (!confirmedBy) return { error: '必須填工程確認人 —— 沒人確認的快照不是基準版' };
  if (!items.length) return { error: '採購包裡沒有工項' };

  const prev = payload.previous || null;
  const snaps = items.map((it) => snapshotItem(it, settings));
  const cost = snaps.reduce((a, s) => a + (Q.isNum(s.cost) ? s.cost : 0), 0);
  return {
    baseline: {
      id: payload.id || 'bl' + Math.random().toString(36).slice(2, 9),
      code: payload.code || nextBaselineCode(payload.existing || [], pkg.code),
      packageCode: pkg.code,
      packageName: pkg.name || '',
      rev: prev ? (prev.rev || 1) + 1 : 1,
      supersedes: prev ? prev.id : null,
      frozenAt: new Date().toISOString(),
      confirmedBy,
      note: String(payload.note || '').trim(),
      items: snaps,
      totals: { count: snaps.length, cost: Q.roundTo(cost, 2) },
      unpriced: snaps.filter((s) => !Q.isNum(s.cost)).length,
      // 行情快照必須跟著凍結。否則原料指數天天在動，對照基準版就會天天冒出
      // 「單價變了」的差異，而其實沒有人改過任何東西 —— 幽靈差異會讓變更管理失去意義。
      priceBase: payload.priceBase || null,
      marketAt: payload.priceBase ? payload.priceBase.at : null,
    },
  };
}

export function nextBaselineCode(existing = [], packageCode = 'PKG') {
  const prefix = `BL-${packageCode}-`;
  const max = existing.reduce((m, b) => {
    if (!String(b.code || '').startsWith(prefix)) return m;
    const n = parseInt(String(b.code).slice(prefix.length), 10);
    return Number.isFinite(n) ? Math.max(m, n) : m;
  }, 0);
  return `${prefix}${pad(max + 1, 2)}`;
}

/**
 * 與基準版比對。回傳每個有異動的工項與異動欄位。
 * 相對誤差 1e-9 以內視為相同，避免浮點雜訊被當成變更。
 */
export function diffAgainstBaseline(items, baseline, settings) {
  if (!baseline) return { changed: [], added: [], removed: [], costDelta: 0 };
  const byCode = new Map(baseline.items.map((s) => [s.code, s]));
  const changed = [], added = [];
  let costNow = 0;

  for (const it of items) {
    const now = snapshotItem(it, settings);
    if (Q.isNum(now.cost)) costNow += now.cost;
    const was = byCode.get(it.code);
    if (!was) { added.push({ code: it.code, name: it.name, now }); continue; }
    byCode.delete(it.code);
    const fields = [];
    for (const f of TRACKED_FIELDS) {
      const a = was[f.key], b = now[f.key];
      if (same(a, b, f.kind)) continue;
      fields.push({
        key: f.key, label: f.label, kind: f.kind, before: a, after: b,
        delta: f.kind === 'number' && Q.isNum(a) && Q.isNum(b) ? Q.roundTo(b - a, 6) : null,
      });
    }
    if (fields.length) changed.push({ code: it.code, name: it.name, wbs: it.wbs, fields });
  }
  const removed = [...byCode.values()].map((s) => ({ code: s.code, name: s.name, was: s }));
  return {
    changed, added, removed,
    costDelta: Q.roundTo(costNow - (baseline.totals.cost || 0), 2),
    dirty: changed.length + added.length + removed.length > 0,
  };
}

function same(a, b, kind) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (kind === 'number') {
    if (!Q.isNum(a) || !Q.isNum(b)) return String(a) === String(b);
    const scale = Math.max(Math.abs(a), Math.abs(b), 1);
    return Math.abs(a - b) <= scale * 1e-9;
  }
  return String(a) === String(b);
}

/* ────────── 請購單（PR） ────────── */

/**
 * ERP 匯入幾乎都需要料號主檔對應。沒有料號的項目寫進 PR，
 * ERP 那端也只會退件 —— 所以這裡先擋下來，而不是讓你在 ERP 前台才發現。
 */
export function prReadiness(baseline, opts = {}) {
  const needErpCode = opts.requireErpCode !== false;
  const missingCode = needErpCode ? baseline.items.filter((s) => !s.erpCode) : [];
  const missingPrice = baseline.items.filter((s) => !Q.isNum(s.unitPrice));
  return {
    ok: missingCode.length === 0 && missingPrice.length === 0,
    missingCode, missingPrice,
  };
}

/**
 * 由基準版產生請購單。表頭 + 明細兩層，對應多數 ERP 的請購單結構。
 */
export function createPr(baseline, payload = {}, existingNos = []) {
  const requester = String(payload.requester || '').trim();
  if (!requester) return { error: '必須填請購人' };
  const template = payload.template || DEFAULT_PR_TEMPLATE;
  const date = payload.date ? new Date(payload.date) : new Date();
  const taxRate = Q.isNum(payload.taxRate) ? payload.taxRate : 0.05;

  const lines = baseline.items.map((s, i) => {
    const qty = Q.isNum(s.orderQty) ? s.orderQty : s.deliveredQty;
    const unit = s.orderUnit || s.unit;
    // 單價是以「材料單位」計價的，換成訂購單位才不會把 6M/支 的管子算成 1/6 價
    const factor = Q.isNum(s.deliveredQty) && Q.isNum(s.orderQty) && s.orderQty > 0 ? s.deliveredQty / s.orderQty : 1;
    const price = Q.isNum(s.unitPrice) ? Q.roundTo(s.unitPrice * factor, 4) : null;
    return {
      seq: i + 1,
      itemCode: s.code, erpCode: s.erpCode || '',
      name: s.name, spec: s.spec, unit,
      qty, unitPrice: price,
      amount: Q.isNum(price) && Q.isNum(qty) ? Q.roundTo(price * qty, 2) : null,
      needDate: payload.needDate || '',
      sheetNo: s.sheetNo || '',
      // 圖號放進 note 而不是另開一欄：ERP 匯入表的欄位順序是對外契約，
      // 多一欄會讓對方的匯入設定失效。note 本來就是自由欄位，放這裡不會弄壞任何人。
      note: `WBS ${s.wbs}｜可信度 ${s.band}${s.band === 'A' ? '' : `（${s.score}）`}${s.sheetNo ? `｜圖號 ${s.sheetNo}` : ''}`,
    };
  });
  const subtotal = Q.roundTo(lines.reduce((a, l) => a + (Q.isNum(l.amount) ? l.amount : 0), 0), 2);
  const tax = Q.roundTo(subtotal * taxRate, 2);

  return {
    pr: {
      no: payload.no || nextPrNo(existingNos, template, date, payload.resetScope),
      status: 'draft',
      baselineId: baseline.id, baselineCode: baseline.code,
      packageCode: baseline.packageCode, packageName: baseline.packageName,
      createdAt: date.toISOString(), requester,
      dept: String(payload.dept || '').trim(),
      project: String(payload.project || '').trim(),
      vendor: String(payload.vendor || '').trim(),
      needDate: payload.needDate || '',
      currency: payload.currency || 'TWD',
      taxRate, subtotal, tax, total: Q.roundTo(subtotal + tax, 2),
      lines,
    },
  };
}

/* ────────── ERP 欄位對映 ────────── */

/**
 * 中性資料模型 → 各家 ERP 的欄位名稱。
 * 不猜你用哪一套 ERP：把對映做成設定，貼上對方的欄位清單就能接。
 */
export const PR_HEADER_FIELDS = [
  { key: 'no', label: 'PR 單號' }, { key: 'createdAt', label: '請購日期' },
  { key: 'requester', label: '請購人' }, { key: 'dept', label: '部門' },
  { key: 'project', label: '專案' }, { key: 'vendor', label: '建議供應商' },
  { key: 'needDate', label: '需求日期' }, { key: 'currency', label: '幣別' },
  { key: 'taxRate', label: '稅率' }, { key: 'subtotal', label: '未稅金額' },
  { key: 'tax', label: '稅額' }, { key: 'total', label: '含稅金額' },
  { key: 'packageCode', label: '採購包' }, { key: 'baselineCode', label: '基準版' },
];

export const PR_LINE_FIELDS = [
  { key: 'seq', label: '項次' }, { key: 'erpCode', label: '料號' },
  { key: 'itemCode', label: '工項代碼' }, { key: 'name', label: '品名' },
  { key: 'spec', label: '規格' }, { key: 'qty', label: '數量' },
  { key: 'unit', label: '單位' }, { key: 'unitPrice', label: '單價' },
  { key: 'amount', label: '金額' }, { key: 'needDate', label: '需求日期' },
  { key: 'note', label: '備註' },
];

/** 內建樣板。generic 用中文欄名；flat 把表頭欄位攤進每一列（很多 ERP 只吃單檔）。 */
export const ERP_PROFILES = {
  generic: {
    key: 'generic', label: '通用（中文欄名，表頭＋明細兩檔）', layout: 'two-file',
    header: null, line: null,
  },
  flat: {
    key: 'flat', label: '通用（單檔，表頭欄位重複於每列）', layout: 'flat',
    header: null, line: null,
  },
};

const labelOf = (fields, key) => (fields.find((f) => f.key === key) || {}).label || key;

/**
 * 產生 ERP 匯入用的資料表。
 * mapping：{ header: {key: '對方欄名'}, line: {key: '對方欄名'} }，未指定者用中文預設欄名。
 * 回傳 { files: [{name, rows}] }，rows[0] 為表頭列。
 */
export function toErpTables(pr, profileKey = 'generic', mapping = {}) {
  const profile = ERP_PROFILES[profileKey] || ERP_PROFILES.generic;
  const hName = (k) => (mapping.header && mapping.header[k]) || labelOf(PR_HEADER_FIELDS, k);
  const lName = (k) => (mapping.line && mapping.line[k]) || labelOf(PR_LINE_FIELDS, k);
  const hKeys = PR_HEADER_FIELDS.map((f) => f.key);
  const lKeys = PR_LINE_FIELDS.map((f) => f.key);
  const hVal = (k) => (k === 'createdAt' ? String(pr.createdAt).slice(0, 10) : pr[k] ?? '');

  if (profile.layout === 'flat') {
    const rows = [[...hKeys.map(hName), ...lKeys.map(lName)]];
    for (const l of pr.lines) rows.push([...hKeys.map(hVal), ...lKeys.map((k) => l[k] ?? '')]);
    return { files: [{ name: `${pr.no}.csv`, rows }] };
  }
  return {
    files: [
      { name: `${pr.no}-header.csv`, rows: [hKeys.map(hName), hKeys.map(hVal)] },
      { name: `${pr.no}-detail.csv`, rows: [[hName('no'), ...lKeys.map(lName)], ...pr.lines.map((l) => [pr.no, ...lKeys.map((k) => l[k] ?? '')])] },
    ],
  };
}
