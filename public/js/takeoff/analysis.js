/**
 * analysis.js — 圖說解析中心的規則引擎。
 *
 * 這裡沒有黑箱。九項指標與每一筆 RFI 都是由「已載入文件的實際內容」用明文規則算出來的，
 * 每一條都附證據（哪份文件、哪一行、哪個數字）。沒有載入的東西不會被猜出數字來。
 *
 * 若日後接上語言模型做語意比對，請把它當成「第二意見」寫進 evidence，
 * 不要讓它取代這些可重現的規則 —— 稽核要的是可重現。
 */

import * as Q from './quantity.js';

export const DOC_KINDS = {
  drawing: { key: 'drawing', label: '圖說', accept: '.dxf,.dwg,.pdf' },
  spec: { key: 'spec', label: '規範', accept: '.pdf,.txt,.md,.csv' },
  boq: { key: 'boq', label: 'BOQ', accept: '.csv,.txt' },
  equipment: { key: 'equipment', label: '設備表', accept: '.csv,.txt' },
};

export const SHEET_TYPES = {
  plan: { key: 'plan', label: '平面圖', hints: ['平面', 'plan', '-P-', 'PLAN'] },
  system: { key: 'system', label: '系統圖', hints: ['系統', 'system', '-s-', 'riser', 'diagram', 'schematic', '單線'] },
  detail: { key: 'detail', label: '詳圖', hints: ['詳圖', 'detail', '大樣'] },
  schedule: { key: 'schedule', label: '表單', hints: ['表', 'schedule', 'list'] },
  other: { key: 'other', label: '其他', hints: [] },
};

/** 由檔名猜圖別；猜錯可以在 UI 改，但預設值要合理。 */
export function guessSheetType(name) {
  const n = String(name || '');
  for (const t of Object.values(SHEET_TYPES)) {
    if (t.hints.some((h) => n.toLowerCase().includes(String(h).toLowerCase()))) return t.key;
  }
  return 'other';
}

/* ────────── 規格屬性抽取 ────────── */

export const SPEC_ATTRS = [
  {
    key: 'material', label: '材質',
    re: /(SUS\s?3\d{2}|SS\s?400|SGP|SPCC|HDPE|LSZH|XLPE|PVC|PE\b|CU\b|AL\b|不鏽鋼|熱浸鍍鋅|鍍鋅|黑鐵|銅|鋁|礦纖|石英磚|竹節)/gi,
  },
  {
    key: 'size', label: '規格尺寸',
    re: /(φ\s?\d+(\.\d+)?|\d+(\.\d+)?\s?[×xX]\s?\d+(\.\d+)?(\s?[×xX]\s?\d+(\.\d+)?)?|#\d+|D\d{2}|\d+(\.\d+)?\s?(mm|cm|吋|")|\d+C\s?[×xX]\s?\d+(\.\d+)?\s?mm²|t=\d+(\.\d+)?)/g,
  },
  {
    key: 'grade', label: '等級性能',
    re: /(Sch\s?\d+|IP\d{2}|K\d{2,3}|\d+(\.\d+)?\s?(V|A|W|RT|CMD|hr|min|℃|K\b)|f'c\s?=?\s?\d+|SD\d{3}|[甲乙丙]種|[ABC]\s?級|\d+P\d?W|省水|變頻|二段式|光電式|向上型|雙面)/g,
  },
  {
    key: 'standard', label: '適用標準',
    re: /(CNS\s?\d+|JIS\s?[A-Z]?\s?\d+|ASTM\s?[A-Z]?\d+|IEC\s?\d+|TIA-\d+[\w.-]*|SMACNA|NFPA\s?\d+|ISO\s?\d+)/gi,
  },
];

export function specAttrs(text) {
  const out = {};
  const s = String(text || '');
  for (const a of SPEC_ATTRS) {
    const m = s.match(new RegExp(a.re.source, a.re.flags));
    out[a.key] = m ? [...new Set(m.map((x) => normToken(x)))] : [];
  }
  return out;
}

/**
 * 衝突判定只用「具體到可以爭議」的屬性值。
 * 「不鏽鋼」這種泛稱兩邊都會出現，拿它比對會把 SUS304 vs SUS316 的真衝突洗掉；
 * 反過來拿模糊詞宣稱衝突則會製造假 RFI。所以另立一組高特異性 token。
 */
export const CONFLICT_ATTRS = [
  { key: 'materialGrade', label: '材質等級', re: /(SUS\s?3\d{2}|SS\s?400|SGP|SPCC|HDPE|LSZH|XLPE|PVC|PE\b|CU\b|AL\b)/gi },
  { key: 'classGrade', label: '等級分類', re: /(Sch\s?\d+|IP\d{2}|SD\d{3}|K\d{2,3}|[甲乙丙]種|[ABC]\s?級)/g },
];

export function conflictAttrs(text) {
  const out = {};
  const s = String(text || '');
  for (const a of CONFLICT_ATTRS) {
    const m = s.match(new RegExp(a.re.source, a.re.flags));
    out[a.key] = m ? [...new Set(m.map(normToken))] : [];
  }
  return out;
}

export function normToken(t) {
  return String(t).toUpperCase().replace(/\s+/g, '').replace(/[，,]/g, '');
}

/**
 * 依工項性質決定哪些規格屬性是必要的。
 *
 * 不能一律要求「材質＋尺寸＋標準」：混凝土的規格就是強度（f'c=280），要它填「材質、尺寸」
 * 只會生出假 RFI —— 假 RFI 比沒有 RFI 更糟，它會讓人開始忽略整張清單。
 * 工項可用 requiredSpec 覆寫預設。統包項（式）不判。
 */
export const REQUIRED_BY_TYPE = {
  length: ['material', 'size', 'standard'],
  area: ['material', 'size', 'standard'],
  volume: ['grade', 'standard'],          // 混凝土：強度等級 + 標準
  weight: ['grade', 'size', 'standard'],  // 鋼筋：SD420W + #8 + CNS
  count: ['size', 'grade'],
};

export function requiredAttrs(item) {
  if (Array.isArray(item.requiredSpec)) return item.requiredSpec;
  return REQUIRED_BY_TYPE[item.measureType] || [];
}

export function specCompleteness(item) {
  const need = requiredAttrs(item);
  if (!need.length) return { ok: true, missing: [], need, found: {} };
  const found = specAttrs(`${item.spec || ''} ${item.name || ''}`);
  const missing = need.filter((k) => !found[k] || !found[k].length);
  return { ok: missing.length === 0, missing, need, found };
}

/* ────────── 設備標籤比對 ────────── */

const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 計算某個標籤在文字中的「實例數」：MCC-1、MCC-2 算兩個；找不到編號時退回出現次數。 */
export function countTag(text, tag) {
  if (!tag || !text) return { instances: [], count: 0 };
  const re = new RegExp(`${escRe(tag)}[\\s_-]?(\\d{1,3})?`, 'gi');
  const seen = new Set();
  let bare = 0; let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) seen.add(`${tag}-${parseInt(m[1], 10)}`); else bare += 1;
  }
  return { instances: [...seen], count: seen.size || bare };
}

/* ────────── RFI 引擎 ────────── */

export const RFI_TYPES = {
  'drawing-vs-boq': { label: '圖說 ≠ BOQ', ask: '設計單位／業主' },
  'drawing-vs-spec': { label: '圖說 ≠ 規範', ask: '設計單位' },
  'plan-vs-system': { label: '平面圖 ≠ 系統圖', ask: '設計單位' },
  'equip-vs-detail': { label: '設備表 ≠ 詳圖', ask: '設計單位' },
  'qty-undeterminable': { label: '數量無法判斷', ask: '設計單位／監造' },
  'spec-incomplete': { label: '規格不完整', ask: '設計單位' },
};

const SEV_ORDER = { high: 0, med: 1, low: 2 };

/**
 * 產出 RFI 候選。
 * ctx = { items, docs, settings, scope }  scope 為大類代碼陣列，空陣列代表全工程。
 */
export function detectRfi(ctx) {
  const items = scopedItems(ctx);
  const docs = ctx.docs || [];
  const s = { ...Q.DEFAULT_SETTINGS, ...(ctx.settings || {}) };
  const out = [];
  const push = (o) => out.push({ id: `${o.type}:${o.itemCode || o.key || out.length}`, status: 'open', ...o });

  const drawingDocs = docs.filter((d) => d.kind === 'drawing');
  const specDocs = docs.filter((d) => d.kind === 'spec');
  const equipDocs = docs.filter((d) => d.kind === 'equipment');
  const planText = drawingDocs.filter((d) => d.sheetType === 'plan').map((d) => d.text || '').join('\n');
  const sysText = drawingDocs.filter((d) => d.sheetType === 'system').map((d) => d.text || '').join('\n');
  const allDrawText = drawingDocs.map((d) => d.text || '').join('\n');

  for (const it of items) {
    // 1) 圖說 ≠ BOQ
    const v = Q.variance(it.qty.drawing, it.qty.boq);
    if (v && Math.abs(v.pct) > s.varianceWarn) {
      const over = Math.abs(v.pct) > s.varianceStop;
      push({
        type: 'drawing-vs-boq', itemCode: it.code, wbs: it.wbs,
        severity: over ? 'high' : 'med',
        title: `${it.name} 圖面量與 BOQ 量差異 ${Q.pct(v.pct)}`,
        question: `本項圖面量 ${Q.fmt(it.qty.drawing, 2)} ${it.unit}、BOQ 量 ${Q.fmt(it.qty.boq, 2)} ${it.unit}，差異 ${Q.fmt(v.abs, 2)} ${it.unit}（${Q.pct(v.pct)}）。請確認應以何者為計價數量，是否需辦理數量變更。`,
        evidence: [
          { label: '圖面量', value: `${Q.fmt(it.qty.drawing, 2)} ${it.unit}`, from: provLabel(it) },
          { label: 'BOQ 量', value: `${Q.fmt(it.qty.boq, 2)} ${it.unit}`, from: 'BOQ' },
          { label: '差異率', value: Q.pct(v.pct), from: `容忍 ${Q.pct(s.varianceWarn)}` },
        ],
      });
    }

    // 2) 圖說 ≠ 規範（材質／等級 token 衝突）
    for (const doc of specDocs) {
      const conflict = specConflict(it, doc);
      if (conflict) {
        push({
          type: 'drawing-vs-spec', itemCode: it.code, wbs: it.wbs, severity: 'high',
          title: `${it.name} 規格與規範不一致（${conflict.attrLabel}）`,
          question: `工項規格載明「${conflict.itemValues.join('、')}」，但規範文件《${doc.name}》第 ${conflict.line} 行載明「${conflict.docValues.join('、')}」。請確認應依何者施作。`,
          evidence: [
            { label: '工項規格', value: it.spec || '', from: it.code },
            { label: '規範原文', value: conflict.text.slice(0, 120), from: `${doc.name} L${conflict.line}` },
          ],
        });
        break;
      }
    }

    // 3) 平面圖 ≠ 系統圖
    if (it.equipTag && planText && sysText) {
      const p = countTag(planText, it.equipTag);
      const y = countTag(sysText, it.equipTag);
      if (p.count && y.count && p.count !== y.count) {
        push({
          type: 'plan-vs-system', itemCode: it.code, wbs: it.wbs,
          severity: Math.abs(p.count - y.count) > 1 ? 'high' : 'med',
          title: `${it.name}（${it.equipTag}）平面圖 ${p.count} 處、系統圖 ${y.count} 處`,
          question: `標籤 ${it.equipTag} 在平面圖出現 ${p.count} 處、系統圖出現 ${y.count} 處，數量不一致。請確認正確數量與位置。`,
          evidence: [
            { label: '平面圖', value: `${p.count} 處 ${p.instances.slice(0, 8).join('、')}`, from: '平面圖' },
            { label: '系統圖', value: `${y.count} 處 ${y.instances.slice(0, 8).join('、')}`, from: '系統圖' },
          ],
        });
      }
    }

    // 4) 設備表 ≠ 詳圖
    if (it.equipTag && equipDocs.length && allDrawText) {
      const inSchedule = equipDocs.reduce((a, d) => a + countTag(d.text || '', it.equipTag).count, 0);
      const inDrawing = countTag(allDrawText, it.equipTag).count;
      if (inSchedule && !inDrawing) {
        push({
          type: 'equip-vs-detail', itemCode: it.code, wbs: it.wbs, severity: 'med',
          title: `${it.name}（${it.equipTag}）設備表有 ${inSchedule} 項，圖面找不到`,
          question: `設備表列有 ${it.equipTag} 共 ${inSchedule} 項，但已載入圖面中查無此標籤。請確認設備位置圖或補充詳圖。`,
          evidence: [{ label: '設備表', value: `${inSchedule} 項`, from: equipDocs.map((d) => d.name).join('、') }, { label: '圖面', value: '0 處', from: drawingDocs.map((d) => d.name).join('、') || '未載入圖面' }],
        });
      } else if (!inSchedule && inDrawing) {
        push({
          type: 'equip-vs-detail', itemCode: it.code, wbs: it.wbs, severity: 'med',
          title: `${it.name}（${it.equipTag}）圖面有 ${inDrawing} 處，設備表未列`,
          question: `圖面出現 ${it.equipTag} 共 ${inDrawing} 處，但設備表未列此項。請確認是否漏列或圖面誤標。`,
          evidence: [{ label: '圖面', value: `${inDrawing} 處`, from: drawingDocs.map((d) => d.name).join('、') }, { label: '設備表', value: '未列', from: equipDocs.map((d) => d.name).join('、') }],
        });
      }
    }

    // 5) 數量無法判斷
    const reason = qtyUndeterminable(it);
    if (reason) {
      push({
        type: 'qty-undeterminable', itemCode: it.code, wbs: it.wbs,
        severity: Q.isNum(it.qty.boq) ? 'med' : 'high',
        title: `${it.name} 數量無法從現有資料判斷`,
        question: `${reason} 請提供可據以計量的圖面或數量依據。`,
        evidence: [
          { label: '圖面量', value: Q.isNum(it.qty.drawing) ? String(it.qty.drawing) : '無', from: provLabel(it) },
          { label: 'BOQ 量', value: Q.isNum(it.qty.boq) ? String(it.qty.boq) : '無', from: 'BOQ' },
          { label: '原因', value: reason, from: '規則判定' },
        ],
      });
    }

    // 6) 規格不完整
    const sc = specCompleteness(it);
    if (!sc.ok) {
      const labels = sc.missing.map((k) => (SPEC_ATTRS.find((a) => a.key === k) || {}).label || k);
      push({
        type: 'spec-incomplete', itemCode: it.code, wbs: it.wbs,
        severity: sc.missing.includes('material') || sc.missing.includes('size') ? 'high' : 'low',
        title: `${it.name} 規格缺少：${labels.join('、')}`,
        question: `本項規格「${it.spec || '（空白）'}」缺少 ${labels.join('、')}，無法據以詢價與驗收。請補充。`,
        evidence: [{ label: '現有規格', value: it.spec || '（空白）', from: it.code }, { label: '缺少屬性', value: labels.join('、'), from: '規格完整性規則' }],
      });
    }
  }

  out.sort((a, b) => (SEV_ORDER[a.severity] - SEV_ORDER[b.severity]) || String(a.wbs).localeCompare(String(b.wbs)));
  return out.map((r, i) => ({ ...r, code: `RFI-${String(i + 1).padStart(3, '0')}`, askTo: RFI_TYPES[r.type].ask }));
}

function provLabel(it) {
  if (!it.provenance) return it.drawingSource === 'auto' ? '圖層彙總' : '未連結圖面';
  return it.provenance.kind === 'dxf-layer' ? `圖層 ${it.provenance.layer}` : `量測 ${it.provenance.drawing || ''}`;
}

function qtyUndeterminable(it) {
  const hasD = Q.isNum(it.qty.drawing), hasB = Q.isNum(it.qty.boq);
  if (!hasD && !hasB) return '既無圖面量也無 BOQ 量。';
  if (!hasD && it.coverage === 'none') return '無圖面量，且本項未連結任何圖面，無法核對 BOQ 量。';
  if (hasD && (it.measureType === 'area' || it.measureType === 'volume') && it.closed === false) return '面積／體積取自未封閉輪廓，數值不可信。';
  return null;
}

/** 規範衝突：同一屬性上，工項與規範各自出現了不同的值。 */
export function specConflict(item, doc) {
  const text = doc.text || '';
  if (!text) return null;
  const keys = [item.name, item.equipTag, item.code].filter(Boolean);
  const lines = text.split(/\r?\n/);
  const itemAttr = conflictAttrs(`${item.spec || ''} ${item.name || ''}`);
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!keys.some((k) => ln.includes(k))) continue;
    const docAttr = conflictAttrs(ln);
    for (const a of CONFLICT_ATTRS) {
      const mine = itemAttr[a.key] || [], theirs = docAttr[a.key] || [];
      if (!mine.length || !theirs.length) continue;
      if (mine.some((x) => theirs.includes(x))) continue;      // 有交集就不算衝突
      return {
        attr: a.key, attrLabel: a.label,
        itemValues: mine, docValues: theirs, line: i + 1, text: ln.trim(),
      };
    }
  }
  return null;
}

/* ────────── 九項指標 ────────── */

export function scopedItems(ctx) {
  const items = ctx.items || [];
  const scope = ctx.scope || [];
  if (!scope.length) return items;
  return items.filter((it) => scope.includes(String(it.wbs).slice(0, 1) + '00'));
}

/**
 * 圖說完整性：五個可查證的比例加權，不是黑箱百分比。
 * UI 必須把 parts 攤開，讓人能問「為什麼是 78% 而不是 92%」。
 */
export function completeness(ctx, rfis) {
  const items = scopedItems(ctx);
  const docs = (ctx.docs || []).filter((d) => d.kind === 'drawing');
  if (!items.length) {
    // 沒有工項就沒有完整性可言。給 0 並說明，不要靠「沒有 RFI」湊出分數。
    return {
      value: 0,
      parts: [{ key: 'none', label: '尚無工項可評估', weight: 1, score: 0, note: '請先載入 BOQ 或建立工項' }],
    };
  }
  const n = items.length;
  const ratio = (f) => items.filter(f).length / n;

  const openByItem = new Set((rfis || []).filter((r) => r.status !== 'closed' && r.itemCode).map((r) => r.itemCode));
  const parts = [
    { key: 'qty', label: '工項有數量來源', weight: 0.30, score: ratio((it) => Q.presentSources(it.qty).length > 0), note: '圖面量或 BOQ 量至少有一' },
    { key: 'link', label: '工項已連結圖面', weight: 0.25, score: ratio((it) => !!it.drawingSource || !!it.provenance), note: '量測或圖層彙總' },
    { key: 'spec', label: '規格完整', weight: 0.25, score: ratio((it) => specCompleteness(it).ok), note: '材質／尺寸／等級／標準' },
    { key: 'scale', label: '圖面已設定比例', weight: 0.10, score: docs.length ? docs.filter((d) => d.scaleSet).length / docs.length : 0, note: docs.length ? `${docs.filter((d) => d.scaleSet).length}/${docs.length} 份圖面` : '尚未載入圖面' },
    { key: 'rfi', label: '無未解 RFI', weight: 0.10, score: 1 - Math.min(1, openByItem.size / n), note: `${openByItem.size} 項工項有未解 RFI` },
  ];
  const value = parts.reduce((a, p) => a + p.weight * p.score, 0);
  return { value: Q.roundTo(value, 4), parts };
}

export function metrics(ctx) {
  const s = { ...Q.DEFAULT_SETTINGS, ...(ctx.settings || {}) };
  const longLead = Q.isNum(s.longLeadDays) ? s.longLeadDays : 90;
  const items = scopedItems(ctx);
  const rfis = ctx.rfis || detectRfi(ctx);
  const wbsSet = new Set(items.map((it) => it.wbs));
  let confirmed = 0, variance = 0;
  for (const it of items) {
    const b = Q.resolveBasis(it, s);
    if (b.basis && b.status === 'ok') confirmed += 1;
    const v = Q.variance(it.qty.drawing, it.qty.boq);
    if (v && Math.abs(v.pct) > s.varianceWarn) variance += 1;
  }
  const comp = completeness({ ...ctx, items }, rfis);
  return {
    completeness: comp,
    wbsCount: wbsSet.size,
    itemCount: items.length,
    materialCount: items.filter((it) => it.measureType !== 'lumpsum').length,
    qtyConfirmed: confirmed,
    specialCount: items.filter((it) => it.special).length,
    varianceCount: variance,
    rfiCount: rfis.filter((r) => r.status !== 'closed').length,
    longLeadCount: items.filter((it) => (it.leadTimeDays || 0) >= longLead).length,
    rfis,
  };
}

/** 施工工序 → 採購 → 發包 的階段模型，用於流程列。 */
export const STAGES = [
  { key: 'ingest', label: '圖說解析', done: (m) => (m.docs || 0) > 0 },
  { key: 'wbs', label: 'WBS', done: (m) => m.wbsCount > 0 },
  { key: 'qto', label: '規格 + QTO', done: (m) => m.qtyConfirmed > 0 },
  { key: 'diff', label: '差異 / 特殊規格', done: (m) => m.varianceCount + m.specialCount >= 0 && m.itemCount > 0 },
  { key: 'rfi', label: 'RFI', done: (m) => m.rfiCount === 0, warn: (m) => m.rfiCount > 0 },
  { key: 'package', label: '採購需求 / Package', done: (m) => (m.packages || 0) > 0 },
  { key: 'baseline', label: 'Baseline / PR', done: (m) => (m.baseline || 0) > 0 },
];
