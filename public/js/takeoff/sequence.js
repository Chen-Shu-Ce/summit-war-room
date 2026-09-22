/**
 * sequence.js — 施工工序、Gate、與由工序反推的採購日期鏈。
 *
 * 這個模組要回答的不是「什麼時候做」，而是三件事：
 *   1. 要做哪些事（工序樹）
 *   2. 誰卡誰（工序關聯表：前置工序 + FS/SS + Gate）
 *   3. 為了不卡住，材料最晚什麼時候要 PR、發包、送審、進場
 *
 * 最重要的一條原則：**不得將一般工程慣例冒充圖說要求。**
 * 範本產生的工序一律標為「建議工序／需工程確認」（confidence = 'suggested'），
 * 只有在已載入文件中找到具體證據，才升級為「圖說可證」（'drawing'）並附來源。
 *
 * 純函式模組，不依賴 DOM。
 */

import * as Q from './quantity.js';

/* ────────── 十六類必須特別識別的工序 ────────── */

export const TASK_KINDS = {
  submittal: { key: 'submittal', label: '送審', gate: true, check: '送審核准', hidden: false, lane: '採購', kw: ['送審', '審核', 'submittal', '樣品', '型錄'] },
  embed: { key: 'embed', label: '預埋', gate: false, check: 'PM 確認', hidden: true, lane: '土建', kw: ['預埋', '埋設', 'embed'] },
  sleeve: { key: 'sleeve', label: '套管', gate: false, check: '隱蔽檢查', hidden: true, lane: '給排水', kw: ['套管', 'sleeve'] },
  opening: { key: 'opening', label: '開孔', gate: false, check: '結構確認', hidden: true, lane: '土建', kw: ['開孔', '留孔', 'opening'] },
  base: { key: 'base', label: '基座', gate: false, check: '尺寸確認', hidden: false, lane: '土建', kw: ['基座', '基礎', '墩座'] },
  hanger: { key: 'hanger', label: '吊架', gate: false, check: '載重確認', hidden: false, lane: '給排水', kw: ['吊架', '支撐', 'hanger', '支吊'] },
  mainPipe: { key: 'mainPipe', label: '主管', gate: false, check: '自主檢查', hidden: false, lane: '給排水', kw: ['主管', '幹管', '主幹'] },
  branch: { key: 'branch', label: '支管', gate: false, check: '自主檢查', hidden: false, lane: '給排水', kw: ['支管', '分支'] },
  equipment: { key: 'equipment', label: '設備安裝', gate: false, check: '定位確認', hidden: false, lane: '機電', kw: ['設備安裝', '機具安裝', '吊裝'] },
  pressure: { key: 'pressure', label: '試壓', gate: true, check: '試壓合格', hidden: false, lane: '品管', kw: ['試壓', '水壓試驗', '壓力試驗'] },
  insulation: { key: 'insulation', label: '絕緣測試', gate: true, check: '絕緣值合格', hidden: false, lane: '品管', kw: ['絕緣測試', '絕緣電阻', 'megger'] },
  unitTest: { key: 'unitTest', label: '單機測試', gate: true, check: '單機功能正常', hidden: false, lane: '品管', kw: ['單機測試', '單體測試', '試運轉'] },
  systemTest: { key: 'systemTest', label: '系統測試', gate: true, check: '系統功能正常', hidden: false, lane: '品管', kw: ['系統測試', 'TAB', '平衡'] },
  interlock: { key: 'interlock', label: '聯動測試', gate: true, check: '聯動正常', hidden: false, lane: '品管', kw: ['聯動測試', '連動', '整合測試'] },
  hiddenAcc: { key: 'hiddenAcc', label: '隱蔽驗收', gate: true, check: '監造簽認', hidden: true, lane: '品管', kw: ['隱蔽驗收', '隱蔽檢查', '封板前檢查'] },
  finalAcc: { key: 'finalAcc', label: '竣工驗收', gate: true, check: '業主簽認', hidden: false, lane: '品管', kw: ['竣工驗收', '驗收', '交屋'] },
  other: { key: 'other', label: '其他', gate: false, check: '自主檢查', hidden: false, lane: '工程/PM', kw: [] },
};

export const LANES = ['工程/PM', '土建', '裝修', '電氣', '給排水', '消防', '空調', '弱電', '採購', '品管', '機電'];

/**
 * 辨識優先序：特定構件 > 通用動作。
 *
 * 「套管預埋」同時命中「套管」與「預埋」。預埋是動作、套管是構件，
 * 這道工序的本質是裝套管，所以構件要贏。同理「隱蔽驗收」必須贏過「驗收」，
 * 否則所有隱蔽檢查都會被歸成竣工驗收。
 */
export const KIND_PRIORITY = [
  'hiddenAcc', 'finalAcc',                                   // 隱蔽驗收要贏過驗收
  'interlock', 'systemTest', 'unitTest', 'insulation', 'pressure',
  'submittal',
  'sleeve', 'opening', 'base', 'hanger', 'mainPipe', 'branch', 'equipment',
  'embed',                                                   // 通用動作放最後
];

/** 由工序名稱判斷屬於十六類的哪一類。 */
export function kindOf(name) {
  const n = String(name || '');
  for (const key of KIND_PRIORITY) {
    const k = TASK_KINDS[key];
    if (k && k.kw.some((w) => n.includes(w))) return key;
  }
  return 'other';
}

/* ────────── 關聯與 Gate ────────── */

export const RELATIONS = {
  FS: { key: 'FS', label: 'FS 完成後開始', note: 'A 做完，B 才能開始' },
  SS: { key: 'SS', label: 'SS 可同步', note: 'A 開始後，B 可同步開始' },
};

export const GATE_STATUS = {
  unchecked: { key: 'unchecked', label: '未檢查', pass: false, level: 'muted' },
  pass: { key: 'pass', label: 'Pass', pass: true, level: 'ok' },
  fail: { key: 'fail', label: 'Fail', pass: false, level: 'bad' },
};

export const CONFIDENCE = {
  drawing: { key: 'drawing', label: '圖說可證', level: 'ok' },
  suggested: { key: 'suggested', label: '建議工序／需工程確認', level: 'warn' },
};

/* ────────── 日期工具（工作日 vs 日曆日） ────────── */

const MS = 86400000;
export const toDate = (d) => (d instanceof Date ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) : new Date(`${String(d).slice(0, 10)}T00:00:00Z`));
export const toISO = (d) => toDate(d).toISOString().slice(0, 10);

/** 日曆日加減 —— 採購前置期用這個。廠商不會因為週末就停止製造。 */
export function addDays(d, n) { return toISO(new Date(toDate(d).getTime() + n * MS)); }

/**
 * 工作日加減 —— 工序工期用這個。
 * 混用工作日與日曆日是排程最常見的錯誤來源，所以兩者在本模組是不同的函式，不共用。
 */
export function addWorkdays(d, n, cal = {}) {
  const weekend = cal.weekend || [0, 6];              // 預設週六日休
  const holidays = new Set(cal.holidays || []);
  let cur = toDate(d);
  if (n === 0) return toISO(cur);
  const step = n > 0 ? 1 : -1;
  let left = Math.abs(n);
  while (left > 0) {
    cur = new Date(cur.getTime() + step * MS);
    const iso = toISO(cur);
    if (!weekend.includes(cur.getUTCDay()) && !holidays.has(iso)) left -= 1;
  }
  return toISO(cur);
}

/** 把日期推到下一個工作日（含當日）。 */
export function nextWorkday(d, cal = {}) {
  const weekend = cal.weekend || [0, 6];
  const holidays = new Set(cal.holidays || []);
  let cur = toDate(d);
  for (let i = 0; i < 400; i++) {
    const iso = toISO(cur);
    if (!weekend.includes(cur.getUTCDay()) && !holidays.has(iso)) return iso;
    cur = new Date(cur.getTime() + MS);
  }
  return toISO(cur);
}

export const diffDays = (a, b) => Math.round((toDate(b).getTime() - toDate(a).getTime()) / MS);

/* ────────── 排程 ────────── */

export const DEFAULT_SCHEDULE = {
  projectStart: null,       // 未設就用今天
  calendar: { weekend: [0, 6], holidays: [] },
  siteBufferDays: 3,        // 進場到開工的緩衝（日曆日）
  submittalDays: 14,        // 發包 → 送審核准（日曆日）
  prToPoDays: 7,            // PR → 發包 的內部核決（日曆日）
};

/**
 * 正向排程（最早開始／最早完成）＋ 反向排程（最晚開始／最晚完成）＋ 浮時／要徑。
 *
 * 關聯：FS（前置完成後開始）、SS（前置開始後可同步開始），皆可帶 lag（工作日）。
 * 迴圈相依會被偵測並回報，不會讓程式空轉。
 */
export function schedule(tasks, opts = {}) {
  const s = { ...DEFAULT_SCHEDULE, ...opts };
  const cal = s.calendar || DEFAULT_SCHEDULE.calendar;
  const start0 = nextWorkday(s.projectStart || new Date(), cal);
  const byCode = new Map(tasks.map((t) => [t.code, t]));

  // 拓撲排序（Kahn），順便抓迴圈
  const indeg = new Map(tasks.map((t) => [t.code, 0]));
  const succ = new Map(tasks.map((t) => [t.code, []]));
  const missing = [];
  for (const t of tasks) {
    for (const p of (t.preds || [])) {
      if (!byCode.has(p.code)) { missing.push({ task: t.code, pred: p.code }); continue; }
      indeg.set(t.code, indeg.get(t.code) + 1);
      succ.get(p.code).push({ code: t.code, rel: p.rel || 'FS', lag: p.lag || 0 });
    }
  }
  const queue = tasks.filter((t) => indeg.get(t.code) === 0).map((t) => t.code);
  const order = [];
  while (queue.length) {
    const c = queue.shift();
    order.push(c);
    for (const sc of succ.get(c)) {
      indeg.set(sc.code, indeg.get(sc.code) - 1);
      if (indeg.get(sc.code) === 0) queue.push(sc.code);
    }
  }
  const cyclic = tasks.filter((t) => !order.includes(t.code)).map((t) => t.code);

  // 正向
  const es = new Map(), ef = new Map();
  for (const code of order) {
    const t = byCode.get(code);
    const dur = Math.max(1, t.duration || 1);
    let start = start0;
    for (const p of (t.preds || [])) {
      const pt = byCode.get(p.code);
      if (!pt) continue;
      const lag = p.lag || 0;
      const cand = (p.rel || 'FS') === 'SS'
        ? addWorkdays(es.get(p.code) || start0, lag, cal)
        : addWorkdays(ef.get(p.code) || start0, 1 + lag, cal);
      if (toDate(cand) > toDate(start)) start = cand;
    }
    start = nextWorkday(start, cal);
    es.set(code, start);
    ef.set(code, addWorkdays(start, dur - 1, cal));
  }
  for (const code of cyclic) { es.set(code, start0); ef.set(code, start0); }

  const projectFinish = order.length
    ? order.reduce((m, c) => (toDate(ef.get(c)) > toDate(m) ? ef.get(c) : m), ef.get(order[0]))
    : start0;

  // 反向
  const ls = new Map(), lf = new Map();
  for (let i = order.length - 1; i >= 0; i--) {
    const code = order[i];
    const t = byCode.get(code);
    const dur = Math.max(1, t.duration || 1);
    let latestFinish = t.requiredFinish ? t.requiredFinish : projectFinish;
    for (const sc of succ.get(code)) {
      const lsS = ls.get(sc.code);
      if (!lsS) continue;
      const cand = sc.rel === 'SS'
        ? addWorkdays(lsS, -sc.lag + dur - 1, cal)      // LS_A ≤ LS_B − lag → LF_A = LS_A + dur − 1
        : addWorkdays(lsS, -(1 + sc.lag), cal);
      if (toDate(cand) < toDate(latestFinish)) latestFinish = cand;
    }
    lf.set(code, latestFinish);
    ls.set(code, addWorkdays(latestFinish, -(dur - 1), cal));
  }
  for (const code of cyclic) { ls.set(code, start0); lf.set(code, start0); }

  const out = tasks.map((t) => {
    const floatDays = diffDays(es.get(t.code), ls.get(t.code));
    return {
      ...t,
      es: es.get(t.code), ef: ef.get(t.code),
      ls: ls.get(t.code), lf: lf.get(t.code),
      float: floatDays,
      critical: floatDays <= 0,
      cyclic: cyclic.includes(t.code),
    };
  });

  return {
    tasks: out, projectStart: start0, projectFinish,
    order, cyclic, missingPreds: missing,
    criticalPath: out.filter((t) => t.critical).map((t) => t.code),
  };
}

/* ────────── Gate ────────── */

/**
 * Gate 阻擋分析。
 * 不是所有箭頭都只代表先後順序 —— 有些節點沒有核准就不得往後走。
 * 回傳每個被擋住的工序，以及擋住它的是哪些 Gate。
 */
export function gateBlocks(scheduled) {
  const byCode = new Map(scheduled.map((t) => [t.code, t]));
  const blocked = new Map();
  const memo = new Map();

  const upstreamGates = (code, seen = new Set()) => {
    if (memo.has(code)) return memo.get(code);
    if (seen.has(code)) return [];
    seen.add(code);
    const t = byCode.get(code);
    const acc = [];
    for (const p of (t && t.preds) || []) {
      const pt = byCode.get(p.code);
      if (!pt) continue;
      if (pt.isGate && !(GATE_STATUS[pt.gateStatus] || GATE_STATUS.unchecked).pass) acc.push(pt);
      acc.push(...upstreamGates(p.code, seen));
    }
    const uniq = [...new Map(acc.map((x) => [x.code, x])).values()];
    memo.set(code, uniq);
    return uniq;
  };

  for (const t of scheduled) {
    const gates = upstreamGates(t.code);
    if (gates.length) blocked.set(t.code, gates);
  }
  return blocked;
}

export function gateSummary(scheduled) {
  const gates = scheduled.filter((t) => t.isGate);
  const by = { unchecked: 0, pass: 0, fail: 0 };
  for (const g of gates) by[g.gateStatus || 'unchecked'] = (by[g.gateStatus || 'unchecked'] || 0) + 1;
  return { total: gates.length, ...by, blocked: gateBlocks(scheduled).size };
}

/* ────────── 由工序反推採購日期鏈 ────────── */

/**
 * 反推鏈（全部日曆日）：
 *   工序開始日 − 進場緩衝      = 需求進場日
 *   需求進場日 − 採購 Lead     = 最晚核准日   ← Lead 從「送審核准後」起算
 *   最晚核准日 − 送審天數      = 最晚送審日 ＝ 建議發包日
 *   建議發包日 − 內部核決天數  = 建議 PR 日
 *
 * 這個順序刻意跟一般 ERP 不同：台灣營建實務是先發包、廠商送審、核准後才開始製造，
 * 不是「下單即開始製造」。把 Lead 從下單起算會讓所有日期早算掉一個送審週期。
 */
export function procurementChain(task, item, opts = {}) {
  const s = { ...DEFAULT_SCHEDULE, ...opts };
  if (!task || !task.es) return null;
  const lead = Q.isNum(item && item.leadTimeDays) ? item.leadTimeDays : 0;
  const submittal = Q.isNum(item && item.submittalDays) ? item.submittalDays : s.submittalDays;
  const prLead = Q.isNum(s.prToPoDays) ? s.prToPoDays : 7;
  const buffer = Q.isNum(s.siteBufferDays) ? s.siteBufferDays : 3;

  const needOnSite = addDays(task.es, -buffer);
  const approveBy = addDays(needOnSite, -lead);
  const submitBy = addDays(approveBy, -submittal);
  const poBy = submitBy;
  const prBy = addDays(poBy, -prLead);

  const today = toISO(opts.today || new Date());
  const slack = diffDays(today, prBy);
  return {
    taskCode: task.code, taskName: task.name, itemCode: item && item.code,
    taskStart: task.es,
    needOnSite, approveBy, submitBy, poBy, prBy,
    leadTimeDays: lead, submittalDays: submittal, prToPoDays: prLead, siteBufferDays: buffer,
    slackDays: slack,
    status: slack < 0 ? 'overdue' : slack <= 7 ? 'urgent' : 'ok',
  };
}

/**
 * 判斷一道工序是否會「實際消耗」材料。
 *
 * 送審工序會引用 BOM（為了追溯送的是哪一項），但它要的是型錄與試驗報告，不是材料本身。
 * 把送審當成消耗點會得出「送審那天材料就要進場」這種荒謬結論，
 * 進而把所有反推日期整整提前一個製造週期。
 */
export function consumesMaterial(task) {
  return task.kind !== 'submittal';
}

/**
 * 每個 BOM 工項的採購日期 —— 取「最早實際消耗它的那道工序」。
 * 同一材料被多道工序使用時，最早那道決定最晚 PR 日；晚的那道沒有話語權。
 * 只被送審工序引用、沒有任何消耗工序的材料會被回報，而不是硬算一個假日期。
 */
export function materialChains(scheduled, items, opts = {}) {
  const byItem = new Map();
  const refOnly = new Map();
  for (const t of scheduled) {
    for (const code of (t.bomCodes || [])) {
      if (!consumesMaterial(t)) {
        if (!refOnly.has(code)) refOnly.set(code, []);
        refOnly.get(code).push(t.code);
        continue;
      }
      const cur = byItem.get(code);
      if (!cur || toDate(t.es) < toDate(cur.es)) byItem.set(code, t);
    }
  }
  const out = [];
  for (const [code, task] of byItem) {
    const item = items.find((i) => i.code === code);
    if (!item) continue;
    const chain = procurementChain(task, item, opts);
    if (chain) {
      out.push({
        ...chain, itemName: item.name, unit: item.unit,
        usedBy: scheduled.filter((t) => (t.bomCodes || []).includes(code) && consumesMaterial(t)).map((t) => t.code),
        submittedBy: refOnly.get(code) || [],
      });
    }
  }
  out.sort((a, b) => toDate(a.prBy) - toDate(b.prBy));
  // 只出現在送審工序、沒有任何消耗工序的材料：回報而非硬算日期
  const orphans = [...refOnly.keys()].filter((c) => !byItem.has(c)).map((c) => {
    const item = items.find((i) => i.code === c);
    return { itemCode: c, itemName: item ? item.name : c, submittedBy: refOnly.get(c) };
  });
  out.orphans = orphans;
  return out;
}

/**
 * 最早可行開工日 —— 反推鏈的必然結論。
 *
 * 材料需求日表如果整片紅字（每一項都已逾期），真正要回答的問題不是「哪幾項遲了」，
 * 而是「那我最早能哪天開工」。做法是拿最緊的那條鏈的負浮時把開工日往後推，
 * 再用真正的 schedule() 重跑一次，而不是把工作日當成日曆日線性外插 ——
 * 週末與國定假日會讓線性外插偏早，偏早的答案比沒有答案更危險。
 *
 * 收斂性：開工日往後移不可能讓任何 ES 提前，所以浮時單調遞增；
 * 每次推進量剛好等於最大缺口，通常 1～2 圈就收斂。
 */
export function earliestFeasibleStart(tasks, items, opts = {}, maxIter = 12) {
  const today = toISO(opts.today || new Date());
  const cal = opts.calendar || DEFAULT_SCHEDULE.calendar;
  const origin = nextWorkday(opts.projectStart || new Date(), cal);
  let start = origin;
  for (let i = 0; i <= maxIter; i++) {
    const r = schedule(tasks, { ...opts, projectStart: start });
    const chains = materialChains(r.tasks, items, { ...opts, today });
    let worst = null;
    for (const c of chains) if (!worst || c.slackDays < worst.slackDays) worst = c;
    if (!worst || worst.slackDays >= 0) {
      return {
        feasible: true, iterations: i,
        projectStart: origin, earliestStart: start,
        shiftDays: diffDays(origin, start),
        driver: worst, projectFinish: r.projectFinish,
      };
    }
    if (i === maxIter) {
      return {
        feasible: false, iterations: i,
        projectStart: origin, earliestStart: start,
        shiftDays: diffDays(origin, start),
        driver: worst, projectFinish: r.projectFinish,
      };
    }
    start = nextWorkday(addDays(start, -worst.slackDays), cal);
  }
  return null;  // 不會走到
}

/* ────────── 證據：不得把慣例冒充圖說 ────────── */

/**
 * 在已載入文件中尋找這道工序的證據。
 * 找到 → confidence 升級為 'drawing' 並附出處；找不到 → 維持 'suggested'。
 *
 * 這是整個模組最重要的一條規則：範本產生的工序是「工程慣例」，
 * 沒有證據就不得標成圖說要求。
 */
export function findEvidence(task, docs = []) {
  const keys = [task.name, ...(TASK_KINDS[task.kind] || TASK_KINDS.other).kw].filter(Boolean);
  for (const d of docs) {
    const text = d.text || '';
    if (!text) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const hit = keys.find((k) => k && lines[i].includes(k));
      if (hit) return { doc: d.name, line: i + 1, text: lines[i].trim().slice(0, 160), matched: hit };
    }
  }
  return null;
}

/** 把一批工序對照文件標註可信度。未找到證據者一律維持「建議工序／需工程確認」。 */
export function annotateConfidence(tasks, docs = []) {
  return tasks.map((t) => {
    const ev = findEvidence(t, docs);
    return ev
      ? { ...t, confidence: 'drawing', evidence: ev, sourceDrawing: t.sourceDrawing || ev.doc }
      : { ...t, confidence: 'suggested', evidence: null };
  });
}

/* ────────── 匯出用的十六欄 ────────── */

export const TASK_COLUMNS = [
  { key: 'seq', label: 'SequenceCode' },
  { key: 'wbs', label: 'WBS' },
  { key: 'name', label: '工序名稱' },
  { key: 'content', label: '施工內容' },
  { key: 'predText', label: '前置工序' },
  { key: 'relText', label: '關聯FS/SS' },
  { key: 'precondition', label: '前置條件' },
  { key: 'bomText', label: '使用BOM' },
  { key: 'crew', label: '施工單位' },
  { key: 'interfaceText', label: '介面工種' },
  { key: 'checkpoint', label: '檢查點' },
  { key: 'hiddenText', label: '是否隱蔽' },
  { key: 'gateText', label: '是否Gate' },
  { key: 'succText', label: '後續工序' },
  { key: 'sourceDrawing', label: '來源圖號' },
  { key: 'confidenceText', label: '可信度' },
];

/** 把工序攤平成十六欄的一列。 */
export function toRow(task, all, items = []) {
  const byCode = new Map(all.map((t) => [t.code, t]));
  const nameOf = (c) => (byCode.get(c) ? `${c} ${byCode.get(c).name}` : c);
  const succ = all.filter((t) => (t.preds || []).some((p) => p.code === task.code));
  const itemName = (c) => { const i = items.find((x) => x.code === c); return i ? `${c} ${i.name}` : c; };
  return {
    seq: task.seq, wbs: task.wbs, name: task.name, content: task.content || '',
    predText: (task.preds || []).map((p) => nameOf(p.code)).join('、') || '—',
    relText: (task.preds || []).map((p) => `${p.rel || 'FS'}${p.lag ? `+${p.lag}d` : ''}`).join('、') || '—',
    precondition: task.precondition || '',
    bomText: (task.bomCodes || []).map(itemName).join('、') || '—',
    crew: task.crew || '', interfaceText: (task.interfaces || []).join('、') || '—',
    checkpoint: task.checkpoint || '',
    hiddenText: task.hidden ? '是' : '否',
    gateText: task.isGate ? `是（${(GATE_STATUS[task.gateStatus] || GATE_STATUS.unchecked).label}）` : '否',
    succText: succ.map((t) => nameOf(t.code)).join('、') || '—',
    sourceDrawing: task.sourceDrawing || '',
    confidenceText: (CONFIDENCE[task.confidence] || CONFIDENCE.suggested).label,
  };
}

/* ────────── 工序樹 ────────── */

/** 依 WBS 分組成可展開的樹；同組內按 seq 排序。 */
export function buildTree(tasks, nodeByCode = new Map()) {
  const groups = new Map();
  for (const t of tasks) {
    if (!groups.has(t.wbs)) groups.set(t.wbs, []);
    groups.get(t.wbs).push(t);
  }
  return [...groups.entries()]
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .map(([wbs, list]) => ({
      wbs, name: (nodeByCode.get(wbs) || {}).name || wbs,
      tasks: list.slice().sort((a, b) => String(a.seq).localeCompare(String(b.seq))),
    }));
}

/** 泳道圖資料：每條泳道一個工種，工序按時間排。 */
export function buildSwimlanes(scheduled) {
  const lanes = new Map();
  for (const t of scheduled) {
    const lane = t.crew || (TASK_KINDS[t.kind] || TASK_KINDS.other).lane || '工程/PM';
    if (!lanes.has(lane)) lanes.set(lane, []);
    lanes.get(lane).push(t);
  }
  const all = scheduled.map((t) => toDate(t.es).getTime());
  const ends = scheduled.map((t) => toDate(t.ef).getTime());
  const min = all.length ? Math.min(...all) : Date.now();
  const max = ends.length ? Math.max(...ends) : Date.now();
  const span = Math.max(1, Math.round((max - min) / MS) + 1);
  const order = LANES.filter((l) => lanes.has(l)).concat([...lanes.keys()].filter((l) => !LANES.includes(l)));
  return {
    start: toISO(new Date(min)), end: toISO(new Date(max)), spanDays: span,
    lanes: order.map((name) => ({
      name,
      tasks: lanes.get(name).slice().sort((a, b) => toDate(a.es) - toDate(b.es)).map((t) => ({
        ...t,
        offset: Math.round((toDate(t.es).getTime() - min) / MS),
        length: Math.max(1, diffDays(t.es, t.ef) + 1),
      })),
    })),
  };
}
