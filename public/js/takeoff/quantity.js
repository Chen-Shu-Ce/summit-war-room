/**
 * quantity.js — 數量來源比較、可信度評分、損耗與建議採購量。
 *
 * 純函式模組，不依賴 DOM，可在 Node 下單元測試（見 tests/quantity.test.mjs）。
 *
 * 設計原則
 *  1. 任何數字都必須能回答「這個數字從哪來、誰簽的、差異多少」。
 *  2. 可信度是「可稽核的啟發式評分」，不是統計信賴區間 —— UI 必須照實揭露。
 *  3. 基準量的選取規則是明文、可重現的，不允許黑箱。
 */

export const SOURCE_META = {
  manual:  { key: 'manual',  label: '人工確認', short: '人工', base: 88, indep: true  },
  drawing: { key: 'drawing', label: '圖面量',   short: '圖面', base: 78, indep: true  },
  boq:     { key: 'boq',     label: 'BOQ量',    short: 'BOQ',  base: 70, indep: true  },
  vendor:  { key: 'vendor',  label: '供應商量', short: '廠商', base: 66, indep: true  },
  history: { key: 'history', label: '歷史類比', short: '歷史', base: 52, indep: false },
};

/** 自動選基準時的優先序（僅在差異規則未攔截時適用）。 */
export const BASIS_PRIORITY = ['manual', 'drawing', 'boq', 'vendor', 'history'];

/**
 * 交叉驗證只採計「獨立量測來源」。
 * 人工確認是對其他來源做的判斷、歷史類比是外插，兩者都不是獨立觀測，
 * 若納入一致性計算會造成自我印證（circular corroboration），把信心分數灌水。
 */
export const INDEPENDENT_SOURCES = ['drawing', 'boq', 'vendor'];

/** 正分上限：信心不可能高過最佳來源本身太多，但扣分不設下限（可扣到 0）。 */
export const MAX_BONUS = 12;

export const DEFAULT_SETTINGS = {
  varianceWarn: 0.05,   // 差異率 ≤ 5%：可直接採用圖面量（公司容忍值）
  varianceStop: 0.10,   // 差異率 > 10%：鎖定，強制人工確認後才可轉採購
  gateBand: 'C',        // 低於此可信度等級不得轉採購包
  defaultWasteRate: 0.03,
  contractType: 'remeasure',   // remeasure = 實作實算；lumpsum = 總價承攬
};

/**
 * 合約型態決定「差異」的意義，這不是算術問題而是計價問題。
 *   實作實算：數量按實際施作量計價，圖面量高於標單 → 可請領的增量，但要走數量變更／估驗計量。
 *   總價承攬：總價固定，圖面量高於標單 → 原則上由承包商吸收，除非構成契約變更。
 */
export const CONTRACT_TYPES = {
  remeasure: { key: 'remeasure', label: '實作實算', short: '實算' },
  lumpsum: { key: 'lumpsum', label: '總價承攬', short: '總價' },
};

const EPS = 1e-9;

export function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

export function roundTo(v, digits = 2) {
  if (!isNum(v)) return null;
  const f = Math.pow(10, digits);
  return Math.round((v + Number.EPSILON * Math.abs(v)) * f) / f;
}

/** 向上進位到 step 的整數倍；用相對誤差吸收浮點雜訊，避免 1751/1 進位成 1752。 */
export function ceilTo(v, step) {
  if (!isNum(v)) return null;
  const s = isNum(step) && step > 0 ? step : 1;
  const n = v / s;
  const ni = Math.ceil(n - Math.abs(n) * 1e-9 - 1e-12);
  return roundTo(ni * s, 6);
}

/** 取得所有有值的來源。 */
export function presentSources(qty = {}) {
  return BASIS_PRIORITY.filter((k) => isNum(qty[k]));
}

/** 有值的獨立量測來源（排除人工確認與歷史類比）。 */
export function independentSources(qty = {}) {
  return INDEPENDENT_SOURCES.filter((k) => isNum(qty[k]));
}

/**
 * 兩來源差異。回傳 { abs, pct, base }。
 * pct 以「BOQ 量」為分母（契約基準），BOQ 為 0 時退回以較大值為分母，避免除零。
 */
export function variance(drawing, boq) {
  if (!isNum(drawing) || !isNum(boq)) return null;
  const abs = roundTo(drawing - boq, 6);
  const denom = Math.abs(boq) > EPS ? Math.abs(boq) : Math.max(Math.abs(drawing), EPS);
  return { abs, pct: abs / denom, denom };
}

/** 多來源離散度（變異係數 CV），用於三個以上來源的一致性評分。 */
export function dispersion(values) {
  const v = values.filter(isNum);
  if (v.length < 2) return null;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  if (Math.abs(mean) < EPS) return null;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  return { mean, sd, cv: sd / Math.abs(mean) };
}

/**
 * 決定正式採購基準。
 * 明文規則（依序判斷）：
 *   R1 人工確認存在 → 採人工確認（人工凌駕自動，但必須留紀錄）。
 *   R2 圖面量與 BOQ 量皆存在：
 *        |差異率| ≤ varianceWarn → 採圖面量（施工實需量）。
 *        varianceWarn < |差異率| ≤ varianceStop → 採圖面量，狀態 = 需複核。
 *        |差異率| > varianceStop → 狀態 = 鎖定，不指定基準，強制人工確認。
 *   R3 其餘 → 依 BASIS_PRIORITY 取第一個有值來源。
 */
export function resolveBasis(item, settings = DEFAULT_SETTINGS) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const qty = item.qty || {};
  if (item.basisOverride && isNum(qty[item.basisOverride])) {
    // 手動指定基準不得靜默繞過差異閘門：差異仍超上限時，狀態維持「需複核」。
    const vo = variance(qty.drawing, qty.boq);
    const over = vo && Math.abs(vo.pct) > s.varianceStop;
    return {
      basis: item.basisOverride, value: qty[item.basisOverride],
      status: over ? 'review' : 'ok', locked: false,
      rule: over ? `使用者指定基準，但差異 ${pct(vo.pct)} 仍超過上限 ${pct(s.varianceStop)}，需複核` : '使用者指定基準',
    };
  }
  if (isNum(qty.manual)) {
    return { basis: 'manual', value: qty.manual, status: 'ok', rule: 'R1 人工確認優先', locked: false };
  }
  const vr = variance(qty.drawing, qty.boq);
  if (vr) {
    const d = Math.abs(vr.pct);
    if (d <= s.varianceWarn) {
      return { basis: 'drawing', value: qty.drawing, status: 'ok', rule: `R2 差異 ${pct(vr.pct)} ≤ 容忍 ${pct(s.varianceWarn)}`, locked: false };
    }
    if (d <= s.varianceStop) {
      return { basis: 'drawing', value: qty.drawing, status: 'review', rule: `R2 差異 ${pct(vr.pct)} 超過容忍 ${pct(s.varianceWarn)}，需複核`, locked: false };
    }
    return { basis: null, value: null, status: 'blocked', rule: `R2 差異 ${pct(vr.pct)} 超過上限 ${pct(s.varianceStop)}，鎖定待人工確認`, locked: true };
  }
  for (const k of BASIS_PRIORITY) {
    if (isNum(qty[k])) {
      return { basis: k, value: qty[k], status: k === 'history' ? 'review' : 'ok', rule: `R3 單一來源（${SOURCE_META[k].label}）`, locked: false };
    }
  }
  return { basis: null, value: null, status: 'empty', rule: '無任何數量來源', locked: true };
}

export function pct(v, digits = 1) {
  if (!isNum(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

/**
 * 可信度評分（0–100）。回傳分數、等級與逐項因子，UI 必須能攤開每一分的來源。
 * ctx: { calibration: 'vector-rms'|'two-point'|'declared-scale'|'none', rms: number,
 *        cadUnitsKnown: bool }
 */
export function confidence(item, opts = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...(opts.settings || {}) };
  const ctx = opts.ctx || {};
  const qty = item.qty || {};
  const res = opts.basis || resolveBasis(item, settings);
  const factors = [];
  const add = (label, delta, note) => { if (delta) factors.push({ label, delta, note }); };

  if (!res.basis) {
    return { score: 0, band: 'D', basis: res, factors: [{ label: '無有效基準量', delta: 0, note: res.rule }] };
  }

  const meta = SOURCE_META[res.basis];
  let score = meta.base;
  factors.push({ label: `基準來源：${meta.label}`, delta: meta.base, note: '來源基礎分' });

  // 1) 圖面量的量測品質
  if (res.basis === 'drawing') {
    if (item.drawingSource === 'measure') {
      const cal = ctx.calibration || item.calibration || 'none';
      if (cal === 'vector-rms' || cal === 'two-point') {
        const rms = isNum(ctx.rms) ? ctx.rms : (isNum(item.calibrationRms) ? item.calibrationRms : 0);
        if (rms <= 0.005) add('比例校正殘差 ≤0.5%', +6, `RMS ${pct(rms, 2)}`);
        else if (rms <= 0.02) add('比例校正殘差 ≤2%', +2, `RMS ${pct(rms, 2)}`);
        else add('比例校正殘差過大', -6, `RMS ${pct(rms, 2)}`);
      } else if (cal === 'declared-scale') {
        add('採用圖框標註比例（未實測校正）', -2, '未以已知尺寸反算');
      } else if (item.sourceKind === 'dxf' || ctx.sourceKind === 'dxf') {
        add(ctx.cadUnitsKnown === false ? 'DXF 單位未定義' : 'DXF 原生座標', ctx.cadUnitsKnown === false ? -8 : +5, 'INSUNITS');
      } else {
        add('未做比例校正', -20, 'PDF 量測未校正等同無效尺寸');
      }
    } else if (item.drawingSource === 'auto') {
      add('圖層自動彙總（非逐段量測）', -4, '依圖層規則加總');
    }
  }

  // 2) 跨來源一致性（僅採計獨立量測來源）
  const indep = independentSources(qty);
  const vals = indep.map((k) => qty[k]);
  const vr = variance(qty.drawing, qty.boq);
  if (vals.length >= 3) {
    const d = dispersion(vals);
    if (d) {
      if (d.cv <= 0.02) add('三來源以上高度一致', +10, `CV ${pct(d.cv, 2)}`);
      else if (d.cv <= 0.05) add('三來源以上大致一致', +5, `CV ${pct(d.cv, 2)}`);
      else if (d.cv <= 0.10) add('來源略有分歧', -4, `CV ${pct(d.cv, 2)}`);
      else add('來源顯著分歧', -16, `CV ${pct(d.cv, 2)}`);
    }
  } else if (vr) {
    const d = Math.abs(vr.pct);
    if (d <= 0.02) add('圖面量與 BOQ 量高度一致', +10, `差異 ${pct(vr.pct)}`);
    else if (d <= 0.05) add('圖面量與 BOQ 量大致一致', +5, `差異 ${pct(vr.pct)}`);
    else if (d <= 0.10) add('圖面量與 BOQ 量有落差', -12, `差異 ${pct(vr.pct)}`);
    else add('圖面量與 BOQ 量嚴重落差', -22, `差異 ${pct(vr.pct)}`);
  } else {
    add('僅單一來源，無交叉驗證', -10, '缺少獨立第二來源');
  }

  // 3) 幾何完整性
  if (item.measureType === 'area' || item.measureType === 'volume') {
    if (item.closed === false) add('面積/體積取自未封閉輪廓', -15, '邊界未閉合，面積不可信');
    else add('封閉輪廓', +4, '邊界閉合');
  }
  if (item.layerMapped === false) add('圖層對映為模糊比對', -5, '未建立明確圖層規則');
  else if (item.layerMapped === true) add('圖層對映明確', +3, '已建立圖層規則');

  // 4) 圖面涵蓋率
  if (item.coverage === 'partial') add('圖面涵蓋不完整', -8, '尚有圖號未量測');
  else if (item.coverage === 'none') add('未連結任何圖面', -12, '無圖面佐證');
  else if (item.coverage === 'full') add('圖面涵蓋完整', +4, '相關圖號已全量測');

  // 5) 人工確認的稽核品質
  if (res.basis === 'manual') {
    const hasNote = !!(item.manualNote && String(item.manualNote).trim());
    const hasBy = !!(item.manualBy && String(item.manualBy).trim());
    if (hasNote && hasBy) add('人工確認具簽核人與理由', +6, `${item.manualBy}`);
    else add('人工確認缺少簽核人或理由', -8, '無法稽核');
    // 人工值必須落在獨立來源的區間內，否則屬於「無佐證的覆寫」。
    if (vals.length) {
      const lo = Math.min(...vals), hi = Math.max(...vals);
      if (qty.manual < lo - EPS || qty.manual > hi + EPS) {
        const ref = qty.manual < lo ? lo : hi;
        const off = Math.abs(ref) > EPS ? Math.abs(qty.manual - ref) / Math.abs(ref) : 1;
        add('人工值落在量測來源區間外', off > 0.1 ? -18 : -10, `偏離最近來源 ${pct(off)}（區間 ${fmt(lo)}–${fmt(hi)}）`);
      }
    }
  }

  // 6) 差異狀態懲罰
  if (res.status === 'review') add('狀態：需複核', -5, res.rule);

  // 正分封頂、負分不封底：避免分數飽和在 100 而失去鑑別力。
  const bonus = factors.filter((f) => f.delta > 0 && f.label.indexOf('基準來源') !== 0).reduce((a, f) => a + f.delta, 0);
  const penalty = factors.filter((f) => f.delta < 0).reduce((a, f) => a + f.delta, 0);
  const cappedBonus = Math.min(bonus, MAX_BONUS);
  if (bonus > MAX_BONUS) {
    factors.push({ label: `正分封頂（+${bonus} → +${MAX_BONUS}）`, delta: MAX_BONUS - bonus, note: '信心不得高於來源本質上限' });
  }
  score = meta.base + cappedBonus + penalty;
  score = Math.max(0, Math.min(100, roundTo(score, 1)));
  return { score, band: bandOf(score), basis: res, factors };
}

export function bandOf(score) {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  return 'D';
}

const BAND_ORDER = { A: 4, B: 3, C: 2, D: 1 };
export function bandAtLeast(band, min) {
  return (BAND_ORDER[band] || 0) >= (BAND_ORDER[min] || 0);
}

/**
 * 建議採購量。
 *   需求量（建議採購量）= 基準量 × (1 + 損耗率)          ← 對應人工報表的「建議採購量」
 *   下單量 = ceil(需求量 ÷ 每訂購單位含量, 包裝倍數)，再套 MOQ
 *   到貨量 = 下單量 × 每訂購單位含量                      ← 實際會進場的材料量
 */
export function suggestPurchase(item, settings = DEFAULT_SETTINGS) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const res = resolveBasis(item, s);
  const wasteRate = isNum(item.wasteRate) ? item.wasteRate : s.defaultWasteRate;
  if (!isNum(res.value)) {
    return { basis: res, wasteRate, baseQty: null, wasteQty: null, suggestQty: null, orderQty: null, deliveredQty: null, overshoot: null, cost: null, blocked: true };
  }
  const baseQty = res.value;
  const wasteQty = roundTo(baseQty * wasteRate, 4);
  const suggestQty = roundTo(baseQty + wasteQty, 4);

  const ord = item.order || {};
  const unitFactor = isNum(ord.unitFactor) && ord.unitFactor > 0 ? ord.unitFactor : 1;
  const packMultiple = isNum(ord.packMultiple) && ord.packMultiple > 0 ? ord.packMultiple : 1;
  const moq = isNum(ord.moq) && ord.moq > 0 ? ord.moq : 0;

  let orderQty = ceilTo(suggestQty / unitFactor, packMultiple);
  let moqApplied = false;
  if (moq && orderQty < moq) { orderQty = moq; moqApplied = true; }
  const deliveredQty = roundTo(orderQty * unitFactor, 4);
  const overshoot = baseQty > 0 ? roundTo((deliveredQty - baseQty) / baseQty, 6) : null;
  const cost = isNum(item.unitPrice) ? roundTo(deliveredQty * item.unitPrice, 2) : null;

  return {
    basis: res, wasteRate, baseQty, wasteQty, suggestQty,
    orderUnit: ord.unit || item.unit, unitFactor, packMultiple, moq, moqApplied,
    orderQty, deliveredQty, overshoot, cost, blocked: res.locked,
  };
}

/**
 * 計價影響：把「圖面量 vs BOQ 量」的差異翻譯成合約語言。
 * 回傳 { level, label, note }，level 用於上色（ok / info / warn / bad）。
 */
export function paymentImpact(item, settings = DEFAULT_SETTINGS) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const type = s.contractType === 'lumpsum' ? 'lumpsum' : 'remeasure';
  const v = variance(item.qty && item.qty.drawing, item.qty && item.qty.boq);
  if (!v) return { level: 'info', label: '—', note: '缺圖面量或 BOQ 量，無法判斷計價影響' };
  const d = v.pct;
  const mag = Math.abs(d);
  const unit = item.unit || '';
  const amt = `${fmt(Math.abs(v.abs), 2)} ${unit}`;
  if (mag <= 0.0005) return { level: 'ok', label: '無差異', note: '圖面量與標單一致' };

  if (type === 'remeasure') {
    if (d > 0) {
      return {
        level: mag > s.varianceStop ? 'warn' : 'info',
        label: `可計價增量 +${amt}`,
        note: mag > s.varianceWarn
          ? `實作實算：增量可請領，但差異 ${pct(d)} 已超過容忍 ${pct(s.varianceWarn)}，應先辦理數量變更／取得監造確認再施作，否則估驗時易被剔除。`
          : `實作實算：增量依實際施作量計價，估驗計量時檢附本項數量出處即可。`,
      };
    }
    return {
      level: mag > s.varianceWarn ? 'warn' : 'info',
      label: `計價減量 −${amt}`,
      note: `實作實算：實作量低於標單，估驗時將扣減 ${amt}。採購若照標單量下單會多買，請以圖面量為採購基準。`,
    };
  }
  // 總價承攬
  if (d > 0) {
    return {
      level: mag > s.varianceWarn ? 'bad' : 'warn',
      label: `自行吸收風險 +${amt}`,
      note: `總價承攬：超出標單的 ${amt} 原則上由承包商吸收。若屬設計變更或標單漏項，必須在施作前提出變更主張並留證，事後難以追償。`,
    };
  }
  return {
    level: 'ok',
    label: `潛在節餘 −${amt}`,
    note: `總價承攬：實作量低於標單，價差為承包商節餘。仍須確認不是漏算或漏繪造成的假節餘。`,
  };
}

/** 千分位格式化。 */
export function fmt(v, digits = 0) {
  if (!isNum(v)) return '—';
  const d = Number.isInteger(v) ? 0 : digits;
  return v.toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: Math.max(d, digits) });
}

/**
 * 前置期分桶。拆包的第一原則是「不要讓快的被慢的綁架」——
 * 一個包的交期等於包裡最慢那一項，所以前置期差一個量級的東西不該同包。
 */
export const LEAD_BUCKETS = [
  { key: 'spot', max: 14, label: '即時料', note: '兩週內可到，接近下單即用' },
  { key: 'short', max: 45, label: '短前置', note: '一個半月內，按施工排程滾動下單' },
  { key: 'mid', max: 90, label: '中前置', note: '三個月內，需併入採購主排程' },
  { key: 'long', max: Infinity, label: '長前置', note: '超過三個月，屬要徑物料，應優先發包' },
];

export function leadBucket(days) {
  const d = isNum(days) ? days : 0;
  return LEAD_BUCKETS.find((b) => d <= b.max) || LEAD_BUCKETS[LEAD_BUCKETS.length - 1];
}

/**
 * 依「前置期分桶 × 供應商」自動建議拆包。
 * 未通過閘門（鎖定、可信度不足、或有未結案 RFI）的項目一律排除並回報原因 —— 不讓有問題的量混進 RFQ。
 * opts: { today: Date, bufferDays: number, blocked: Map<itemCode, reason> }
 *   blocked 由呼叫端算好（例如 RFI 閘門），這裡不反向依賴解析模組。
 */
export function suggestPackages(items, settings = DEFAULT_SETTINGS, opts = {}) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const buffer = isNum(opts.bufferDays) ? opts.bufferDays : 7;
  const today = opts.today instanceof Date ? opts.today : new Date();
  const groups = new Map();
  const excluded = [];

  const blocked = opts.blocked instanceof Map ? opts.blocked : new Map();
  for (const it of items) {
    const p = suggestPurchase(it, s);
    const c = confidence(it, { settings: s, basis: p.basis });
    const ext = blocked.get(it.code);
    if (p.blocked || !bandAtLeast(c.band, s.gateBand) || ext) {
      excluded.push({
        code: it.code, name: it.name,
        reason: p.blocked ? p.basis.rule : ext || `可信度 ${c.band} 低於門檻 ${s.gateBand}`,
      });
      continue;
    }
    const b = leadBucket(it.leadTimeDays);
    const vendor = (it.vendor || '').trim();
    const key = `${b.key}|${vendor}`;
    if (!groups.has(key)) groups.set(key, { bucket: b, vendor, items: [], cost: 0, maxLead: 0 });
    const g = groups.get(key);
    g.items.push(it);
    if (isNum(p.cost)) g.cost += p.cost;
    g.maxLead = Math.max(g.maxLead, it.leadTimeDays || 0);
  }

  // 長前置在前：要徑物料要先發包，排序本身就是提醒
  const order = { long: 0, mid: 1, short: 2, spot: 3 };
  const list = [...groups.values()].sort((a, b) =>
    (order[a.bucket.key] - order[b.bucket.key]) || (b.maxLead - a.maxLead) || a.vendor.localeCompare(b.vendor));

  return {
    packages: list.map((g, i) => {
      const need = new Date(today.getTime() + (g.maxLead + buffer) * 86400000);
      return {
        code: `PKG-${g.bucket.key.toUpperCase()}-${String(i + 1).padStart(2, '0')}`,
        name: `${g.bucket.label}${g.vendor ? ` · ${g.vendor}` : ''}（最長前置 ${g.maxLead} 天）`,
        vendor: g.vendor,
        needDate: need.toISOString().slice(0, 10),
        itemCodes: g.items.map((x) => x.code),
        bucket: g.bucket.key,
        maxLead: g.maxLead,
        cost: roundTo(g.cost, 2),
        reason: `${g.bucket.note}；同包內前置期同一量級，交期不會被拖累。`,
      };
    }),
    excluded,
  };
}

/** 整份清單的彙總，用於右欄與採購包統計。 */
export function summarize(items, settings = DEFAULT_SETTINGS) {
  const out = { count: items.length, cost: 0, blocked: 0, review: 0, bands: { A: 0, B: 0, C: 0, D: 0 }, unpriced: 0 };
  for (const it of items) {
    const p = suggestPurchase(it, settings);
    const c = confidence(it, { settings, basis: p.basis });
    out.bands[c.band] = (out.bands[c.band] || 0) + 1;
    if (p.blocked) out.blocked += 1;
    if (p.basis.status === 'review') out.review += 1;
    if (isNum(p.cost)) out.cost += p.cost; else out.unpriced += 1;
  }
  out.cost = roundTo(out.cost, 2);
  return out;
}
