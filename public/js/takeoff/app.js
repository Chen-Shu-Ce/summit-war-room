/**
 * app.js — 三欄式工程量清單選擇器的 UI 與流程編排。
 *   左：WBS 階層（父子連動、tri-state 多選）
 *   中：BOM 明細（多來源數量比較／可信度／建議採購量）＋ 圖面量測
 *   右：已選清單 → 採購 Package
 */

import * as Q from './quantity.js';
import * as DXF from './dxf.js';
import { Viewer, TOOLS } from './viewer.js';
import * as A from './analysis.js';
import * as B from './baseline.js';
import * as R from './risk.js';
import * as S from './sequence.js';
import * as PR from './pricing.js';
import * as CS from './calcsheet.js';
import * as ENC from './encoding.js';
import * as U from './units.js';
import * as SV from './survey.js';
import * as PS from './pdfscale.js';
import * as LM from './layermatch.js';
import * as DD from './dedupe.js';
import * as BD from './bid.js';
import * as VD from './vendors.js';
import * as PO from './po.js';
import * as VF from './verify.js';
import * as XL from './xlsx.js';
import * as SH from './sheet.js';

const LS_KEY = 'summit.takeoff.v1';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  template: null,
  nodes: [],           // { code, name, parent, children[], items[] }
  nodeByCode: new Map(),
  items: [],
  itemByCode: new Map(),
  selected: new Set(),
  expanded: new Set(),
  activeNode: null,
  search: '',
  onlyIssues: false,
  settings: { ...Q.DEFAULT_SETTINGS },
  packages: [],
  drawing: null,       // { name, kind, pages, pageNo }
  viewer: null,
  lastRowIndex: null,
  shiftDown: false,
  projName: '未命名專案',
  docs: [],            // 已載入文件（圖說／規範／BOQ／設備表）
  scope: [],           // 分析範圍：大類代碼，空 = 全工程
  analysis: null,      // 最近一次解析結果
  pendingUpKind: 'drawing',
  rfiLog: {},          // RFI 狀態紀錄，以穩定鍵索引
  rfiFilter: 'open',
  baselines: [],       // 已凍結的基準版
  prs: [],             // 已產生的請購單
  tasks: [],           // 施工工序
  seqStart: '',        // 專案開工日
  seqView: 'tree',
  sched: null,         // 最近一次排程結果
  market: null,        // /api/market-data 的行情
  marketErr: null,
  priceBase: null,     // 價格基準快照（凍結後才會有調整額）
  calc: null,          // 圖面計算式表的解析與驗算結果
  encoding: null,      // 最近一次 DXF 的編碼偵測結果
  survey: null,        // 座標與單位合理性檢查
  pdfScale: null,      // 從 PDF 圖框讀到的比例宣告
  surveyFixed: null,   // 使用者確認過的單位修正
  vendors: [],         // 廠商主檔。原本 vendor 只是一個自由輸入字串，打錯字就變成另一家
  pos: [],             // 發包單。PR 對 PO 是多對多，不是一對一
  bid: null,           // 加成設定（管理費／利潤／規費／準備金服務水準）
  missed: [],          // 最近一次自動抓量的漏項 —— 要接成金額保留，不可以在總價裡歸零
  dims: null,          // 圖面標註 vs 幾何的比對 —— 圖面自己帶著答案，原本沒人去問它
  dupe: null,          // 重複描繪分析。重複描繪會靜默把數量翻倍，比任何自動化都優先
  drawingSigs: {},     // 圖名 → 內容簽章。同名不同簽章 = 這張圖改版了
  sheetNos: {},        // 圖名 → 人工指定的圖號（A0-1）。人工填的優先，不會被自動解析蓋掉
  measureStore: {},    // 量測依「哪張圖的哪一頁」分開存，換圖不會互相污染
  measureKey: '',      // 目前顯示的是哪一組量測
};

/* ══════════ 啟動 ══════════ */

init().catch((e) => { console.error(e); alert('初始化失敗：' + e.message); });

async function init() {
  const res = await fetch('./data/wbs-template.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('無法載入 WBS 範本 (' + res.status + ')');
  state.template = await res.json();
  state.settings = {
    ...Q.DEFAULT_SETTINGS,
    prTemplate: B.DEFAULT_PR_TEMPLATE, taxRate: 0.05, dept: '', project: '',
    erpProfile: 'generic', erpMapping: { header: {}, line: {} }, requireErpCode: true,
    ...R.DEFAULT_SIM, stochastic: true,
    // 投標價組成 —— 數字來自使用者自述的實際作法，不是預設猜的
    markups: BD.DEFAULT_MARKUPS.map((m) => ({ ...m })),
    reserveLevel: 0.8,          // 風險準備金取的服務水準
    // 價格風險：**只有一個旗標**。
    // 一開始我放了 priceRiskOn 與 priceDist 兩個，結果 priceDist 一進 settings，
    // simulatePortfolio 就直接讀到它 —— 風險模擬那條路完全繞過了開關，
    // 分散效益瞬間變成負的（e2e 立刻抓到）。兩個會互相矛盾的旗標就是 bug 本身。
    // 現在 null = 關、有值 = 開，沒有第二個地方可以說謊。
    priceDist: null,
    delayDailyRate: 0.001,      // 逾期罰款每日千分之一

    ...(state.template.settings || {}),
  };
  buildModel(state.template);
  restore();
  wire();
  state.viewer = new Viewer($('#cv'));
  bindViewer(state.viewer);
  renderAll();
  // 行情是加值資訊，不是必要條件 —— 抓不到也不能擋住算量。
  loadMarket().then(renderAll).catch(() => {});
}

/**
 * 讀行情。先打 /api/market-data（有 Redis 時是每月更新的值），
 * 失敗就退回隨附的 market-seed.json，並明白標示這是離線種子資料。
 */
async function loadMarket() {
  const tries = [
    { url: '/api/market-data', live: true },
    { url: './data/market-seed.json', live: false },
  ];
  for (const t of tries) {
    try {
      const r = await fetch(t.url, { cache: 'no-store' });
      if (!r.ok) continue;
      const j = await r.json();
      if (!j || !Array.isArray(j.items)) continue;
      state.market = { ...j, _live: t.live, _url: t.url };
      state.marketErr = null;
      return state.market;
    } catch (e) { state.marketErr = String(e && e.message || e); }
  }
  state.marketErr = state.marketErr || '行情來源都讀不到';
  return null;
}

/** 目前行情快照。沒有行情就回 null —— 不用假資料撐場面。 */
function marketSnap() { return state.market ? PR.snapshotIndices(state.market) : null; }

/** 把價格基準日套進工項。沒有基準的工項連動額一律為 0。 */
function withBase(it) { return state.priceBase ? { ...it, priceBase: state.priceBase } : it; }

/** 連動後單價。沒有行情或沒有基準就回原單價。 */
function livePrice(it) {
  const snap = marketSnap();
  if (!snap) return { price: it.unitPrice ?? null, linked: false, reason: 'no-market', delta: 0, deltaPct: 0, parts: [] };
  return PR.linkedPrice(withBase(it), snap);
}

function buildModel(tpl) {
  state.nodes = tpl.nodes.map((n) => ({ ...n, children: [], items: [] }));
  state.nodeByCode = new Map(state.nodes.map((n) => [n.code, n]));
  for (const n of state.nodes) {
    if (n.parent && state.nodeByCode.has(n.parent)) state.nodeByCode.get(n.parent).children.push(n);
  }
  state.items = tpl.items.map((it) => ({
    ...it,
    qty: { drawing: null, boq: null, manual: null, vendor: null, history: null, ...(it.qty || {}) },
    order: { unit: it.unit, unitFactor: 1, packMultiple: 1, moq: 0, ...(it.order || {}) },
    provenance: it.provenance || null,
  }));
  state.itemByCode = new Map(state.items.map((i) => [i.code, i]));
  for (const it of state.items) {
    const n = state.nodeByCode.get(it.wbs);
    if (n) n.items.push(it); else console.warn('工項的 WBS 代碼不存在：', it.code, it.wbs);
  }
  state.nodes.filter((n) => !n.parent).forEach((n) => state.expanded.add(n.code));
}

/* ══════════ 持久化 ══════════ */

function persist() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      v: 1,
      items: state.items.map((i) => ({
        code: i.code, qty: i.qty, wasteRate: i.wasteRate, basisOverride: i.basisOverride,
        unitPrice: i.unitPrice, order: i.order, manualBy: i.manualBy, manualNote: i.manualNote,
        provenance: i.provenance, drawingSource: i.drawingSource, layerMapped: i.layerMapped,
        calcSource: i.calcSource, calcIssues: i.calcIssues, drawingStale: i.drawingStale,
        coverage: i.coverage, calibration: i.calibration, calibrationRms: i.calibrationRms,
        packageId: i.packageId, closed: i.closed,
      })),
      selected: [...state.selected], packages: state.packages, settings: state.settings,
      projName: state.projName, scope: state.scope, rfiLog: state.rfiLog,
      baselines: state.baselines, prs: state.prs,
      tasks: state.tasks, seqStart: state.seqStart, priceBase: state.priceBase,
      drawingSigs: state.drawingSigs,
      sheetNos: state.sheetNos,
      vendors: state.vendors, pos: state.pos,
      // 文字保留上限，避免塞爆 localStorage；超過的部分不存，重新載入文件即可還原
      docs: state.docs.map((d) => ({
        id: d.id, kind: d.kind, name: d.name, sheetType: d.sheetType, pages: d.pages,
        entities: d.entities, rows: d.rows, scaleSet: d.scaleSet, error: d.error, applied: d.applied,
        text: (d.text || '').slice(0, 120000),
      })),
    }));
  } catch (e) { console.warn('無法寫入 localStorage', e); }
}

function restore() {
  let raw;
  try { raw = localStorage.getItem(LS_KEY); } catch { return; }
  if (!raw) return;
  try {
    const d = JSON.parse(raw);
    for (const s of d.items || []) {
      const it = state.itemByCode.get(s.code);
      if (it) Object.assign(it, s, { qty: { ...it.qty, ...s.qty }, order: { ...it.order, ...s.order } });
    }
    state.selected = new Set(d.selected || []);
    state.packages = d.packages || [];
    state.settings = { ...state.settings, ...(d.settings || {}) };
    state.projName = d.projName || state.projName;
    state.scope = d.scope || [];
    state.docs = (d.docs || []).map((x) => ({ ...x, restored: true }));
    state.rfiLog = d.rfiLog || {};
    state.baselines = d.baselines || [];
    state.prs = d.prs || [];
    state.tasks = d.tasks || [];
    state.seqStart = d.seqStart || '';
    state.priceBase = d.priceBase || null;
    state.drawingSigs = d.drawingSigs || {};
    state.sheetNos = d.sheetNos || {};
    state.vendors = d.vendors || [];
    state.pos = d.pos || [];
  } catch (e) { console.warn('狀態還原失敗，改用範本預設值', e); }
}

/* ══════════ 左欄：WBS 樹 ══════════ */

function descendantItems(node) {
  const out = [...node.items];
  for (const c of node.children) out.push(...descendantItems(c));
  return out;
}

function matches(it) {
  const s = state.search.trim().toLowerCase();
  if (!s) return true;
  return [it.code, it.name, it.spec, it.unit].some((v) => String(v ?? '').toLowerCase().includes(s));
}

function nodeVisible(n) {
  const s = state.search.trim().toLowerCase();
  if (!s) return true;
  if (n.name.toLowerCase().includes(s) || n.code.toLowerCase().includes(s)) return true;
  return descendantItems(n).some(matches);
}

function renderTree() {
  const host = $('#tree');
  host.innerHTML = '';
  const roots = state.nodes.filter((n) => !n.parent);
  const walk = (n, depth) => {
    if (!nodeVisible(n)) return;
    const items = descendantItems(n);
    const selCount = items.filter((i) => state.selected.has(i.code)).length;
    const row = document.createElement('div');
    row.className = 'node' + (state.activeNode === n.code ? ' active' : '');
    row.style.paddingLeft = (8 + depth * 14) + 'px';
    const hasKids = n.children.length > 0;
    const open = state.expanded.has(n.code) || !!state.search.trim();
    row.innerHTML = `
      <span class="tw" data-tw="${esc(n.code)}">${hasKids ? (open ? '▾' : '▸') : '·'}</span>
      <input type="checkbox" data-node="${esc(n.code)}" ${selCount && selCount === items.length ? 'checked' : ''}>
      <span class="code">${esc(n.code)}</span>
      <span class="nm" data-go="${esc(n.code)}" title="${esc(n.name)}">${esc(n.name)}</span>
      <span class="cnt">${selCount ? selCount + '/' : ''}${items.length}</span>`;
    const cb = row.querySelector('input');
    cb.indeterminate = selCount > 0 && selCount < items.length;
    host.appendChild(row);
    if (hasKids && open) n.children.forEach((c) => walk(c, depth + 1));
  };
  roots.forEach((r) => walk(r, 0));
  $('#wbsCount').textContent = `${state.items.length} 項`;
}

/* ══════════ 中欄：BOM 表格 ══════════ */

function visibleItems() {
  let list = state.items;
  if (state.activeNode) {
    const n = state.nodeByCode.get(state.activeNode);
    if (n) list = descendantItems(n);
  }
  list = list.filter(matches);
  if (state.onlyIssues) {
    list = list.filter((i) => {
      const b = Q.resolveBasis(i, state.settings);
      const c = Q.confidence(i, { settings: state.settings, basis: b });
      return b.status !== 'ok' || !Q.bandAtLeast(c.band, state.settings.gateBand);
    });
  }
  return list;
}

function varianceCell(it) {
  const v = Q.variance(it.qty.drawing, it.qty.boq);
  if (!v) return '<span class="muted">—</span>';
  const a = Math.abs(v.pct);
  const cls = a <= state.settings.varianceWarn ? 'ok' : a <= state.settings.varianceStop ? 'warn' : 'bad';
  const sign = v.abs > 0 ? '+' : '';
  const pay = Q.paymentImpact(it, state.settings);
  return `<span class="chip ${cls}">${sign}${Q.fmt(v.abs, 2)} / ${Q.pct(v.pct)}</span>`
    + `<span class="pay ${pay.level}" title="${esc(pay.note)}">${esc(pay.label)}</span>`;
}

function renderTable() {
  const body = $('#boqBody');
  const list = visibleItems();
  const blockMap = state.analysis ? rfiBlockMap() : new Map();
  const blDiff = baselineDiffIndex();
  const rows = [];
  let lastWbs = null;
  list.forEach((it, idx) => {
    if (it.wbs !== lastWbs) {
      lastWbs = it.wbs;
      const n = state.nodeByCode.get(it.wbs);
      rows.push(`<tr class="grp"><td colspan="12">${esc(it.wbs)} · ${esc(n ? n.name : '未分類')}</td></tr>`);
    }
    const pi = priced(it);
    const stoch = state.settings.stochastic && R.isStochastic(it);
    const p = Q.suggestPurchase(pi, state.settings);
    const c = Q.confidence(it, { settings: state.settings, basis: p.basis });
    const sel = state.selected.has(it.code);
    const gate = Q.bandAtLeast(c.band, state.settings.gateBand) && !p.blocked;
    const basisLabel = p.basis.basis ? Q.SOURCE_META[p.basis.basis].label : '待確認';
    const statusChip = p.basis.status === 'blocked' ? '<span class="chip bad">鎖定</span>'
      : p.basis.status === 'review' ? '<span class="chip warn">需複核</span>' : '';
    rows.push(`<tr data-code="${esc(it.code)}" data-idx="${idx}" class="${sel ? 'sel' : ''}${p.blocked ? ' blocked' : ''}">
      <td><input type="checkbox" data-pick="${esc(it.code)}" ${sel ? 'checked' : ''} style="width:auto"></td>
      <td class="nm2"><b>${esc(it.name)}</b><small>${esc(it.code)} · ${esc(it.spec || '')}</small></td>
      <td>${esc(it.unit)}</td>
      <td class="num"><button class="srcbtn" data-src="${esc(it.code)}">${Q.fmt(it.qty.drawing, 2)}</button>${
        it.drawingStale && Q.isNum(it.qty.drawing) ? '<span class="chip warn" title="這個數字是這張圖的上一版算出來的，圖已改版">舊版</span>' : ''}</td>
      <td class="num">${Q.fmt(it.qty.boq, 2)}</td>
      <td class="num">${varianceCell(it)}</td>
      <td><button class="srcbtn" data-basis="${esc(it.code)}">${esc(basisLabel)}</button> ${statusChip}</td>
      <td><button class="srcbtn chip band${c.band}" data-conf="${esc(it.code)}">${c.band} ${c.score}</button></td>
      <td class="num">${stoch
        ? `<button class="srcbtn" data-dist="${esc(it.code)}">${(pi.wasteRate * 100).toFixed(2)}</button><span class="sl">P${Math.round(levelOf(it) * 100)}</span>`
        : `<input class="cellin num" type="number" step="0.5" min="0" max="100" data-waste="${esc(it.code)}" value="${Q.roundTo((it.wasteRate ?? state.settings.defaultWasteRate) * 100, 2)}">`}</td>
      <td class="num sug">${p.suggestQty == null ? '<span class="chip bad">—</span>'
        : stoch ? `<button class="srcbtn" data-dist="${esc(it.code)}">${Q.fmt(p.suggestQty, 2)} ${esc(it.unit)}</button>`
          : Q.fmt(p.suggestQty, 2) + ' ' + esc(it.unit)}</td>
      <td class="num">${p.orderQty == null ? '—' : `${Q.fmt(p.orderQty, 2)} ${esc(p.orderUnit)}${p.moqApplied ? ' <span class="chip warn">MOQ</span>' : ''}`}</td>
      <td class="num">${p.cost == null ? '—' : Q.fmt(p.cost, 0)}</td>
    </tr>`);
    const bd = blDiff.get(it.code);
    if (bd) {
      const brief = bd.fields.slice(0, 3).map((f) => `${f.label} ${f.delta != null ? (f.delta > 0 ? '+' : '') + Q.fmt(f.delta, 2) : `${f.before} → ${f.after}`}`).join('、');
      rows.push(`<tr><td></td><td colspan="11" class="blchg">較 ${esc(bd.bl.code)} 異動：${esc(brief)}${bd.fields.length > 3 ? ` 等 ${bd.fields.length} 項` : ''}</td></tr>`);
    }
    const rfiWhy = blockMap.get(it.code);
    if ((!gate || rfiWhy) && sel) {
      rows.push(`<tr><td></td><td colspan="11" class="hint" style="color:var(--bad)">此項不得轉採購：${esc(rfiWhy || `可信度 ${c.band} 低於門檻 ${state.settings.gateBand}；${p.basis.rule}`)}</td></tr>`);
    }
  });
  body.innerHTML = rows.join('') || '<tr><td colspan="12" class="hint" style="padding:22px;text-align:center">沒有符合條件的工項</td></tr>';
  $('#midTitle').textContent = `工程量清單 (BOM) · ${list.length} 項`;
}

/* ══════════ 右欄：已選 + 採購包 ══════════ */

function selectedItems() { return state.items.filter((i) => state.selected.has(i.code)); }

/**
 * 採購計算前的單一入口：把工項的損耗率換成「該服務水準下的分位數」。
 * 關掉機率模式就原封不動回傳 —— quantity.js 完全不需要知道機率的存在。
 */
/**
 * 單一入口：套用服務水準（數量）與行情連動（單價）。
 * 所有下游 —— 金額合計、採購包、基準版、請購單、Excel 匯出 —— 都走這裡，
 * 才不會出現「畫面上是連動價、匯出的是基準價」這種對不起來的情形。
 */
function priced(it) {
  let out = state.settings.stochastic ? R.withServiceLevel(it, state.settings, it.serviceLevel) : it;
  if (state.settings.priceLink !== false) {
    const lp = livePrice(it);
    if (lp.linked && Q.isNum(lp.price)) out = { ...out, unitPrice: lp.price, basePrice: it.unitPrice, priceDelta: lp.delta };
  }
  return out;
}
function pricedAll(list) { return list.map(priced); }

/** 目前套用的服務水準。 */
function levelOf(it) {
  return Q.isNum(it.serviceLevel) ? it.serviceLevel : (state.settings.serviceLevel ?? 0.8);
}

function renderCart() {
  const host = $('#cart');
  const list = selectedItems();
  $('#cartCount').textContent = String(list.length);
  if (!list.length) { host.innerHTML = '<div class="hint" style="padding:20px;text-align:center">尚未選取工項。<br>在左側勾選分類，或在中間清單勾選單項。</div>'; }
  else {
    const byWbs = new Map();
    for (const it of list) { const k = it.wbs; if (!byWbs.has(k)) byWbs.set(k, []); byWbs.get(k).push(it); }
    const out = [];
    for (const [wbs, arr] of byWbs) {
      const n = state.nodeByCode.get(wbs);
      out.push(`<div class="cartitem" style="background:var(--line2);padding:4px 12px"><b style="font-size:11.5px">${esc(wbs)} · ${esc(n ? n.name : '')}</b></div>`);
      for (const it of arr) {
        const p = Q.suggestPurchase(priced(it), state.settings);
        const c = Q.confidence(it, { settings: state.settings, basis: p.basis });
        const pkg = state.packages.find((k) => k.itemCodes.includes(it.code));
        out.push(`<div class="cartitem">
          <div class="g">
            <b>${esc(it.name)}</b>
            <div class="hint">${esc(it.code)} · ${esc(it.spec || '')}</div>
            <div class="hint">基準 ${esc(p.basis.basis ? Q.SOURCE_META[p.basis.basis].label : '待確認')} · <span class="chip band${c.band}">${c.band}</span>${pkg ? ` · <span class="chip acc">${esc(pkg.code)}</span>` : ''}</div>
          </div>
          <div style="text-align:right">
            <div class="num"><b>${p.suggestQty == null ? '—' : Q.fmt(p.suggestQty, 2)}</b> ${esc(it.unit)}</div>
            <div class="hint num">${p.cost == null ? '未報價' : 'NT$ ' + Q.fmt(p.cost, 0)}</div>
            <button class="btn sm" data-unpick="${esc(it.code)}">移除</button>
          </div>
        </div>`);
      }
    }
    host.innerHTML = out.join('');
  }
  const s = Q.summarize(pricedAll(list), state.settings);
  $('#totals').innerHTML = `
    <div class="totrow"><span>已選工項</span><b>${s.count}</b></div>
    <div class="totrow"><span>預估金額</span><b>NT$ ${Q.fmt(s.cost, 0)}${s.unpriced ? ` <span class="chip warn">${s.unpriced} 項未報價</span>` : ''}</b></div>
    <div class="totrow"><span>可信度分布</span><b>
      <span class="chip bandA">A ${s.bands.A}</span> <span class="chip bandB">B ${s.bands.B}</span>
      <span class="chip bandC">C ${s.bands.C}</span> <span class="chip bandD">D ${s.bands.D}</span></b></div>
    <div class="totrow"><span>需複核 / 鎖定</span><b>${s.review} / ${s.blocked}</b></div>
    ${marketTotRow(list, s)}`;
}

/** 摘要列的行情連動狀態。沒有基準日就明說，不假裝在跑即時行情。 */
function marketTotRow(list, s) {
  if (!state.market) return '<div class="totrow"><span>行情連動</span><b class="hint">未載入行情</b></div>';
  if (!list.length) return '';
  if (!state.priceBase) return '<div class="totrow"><span>行情連動</span><b><span class="chip warn">未設基準日</span></b></div>';
  const base = list.reduce((a, it) => {
    const p = state.settings.stochastic ? R.withServiceLevel(it, state.settings, it.serviceLevel) : it;
    const q = Q.suggestPurchase(p, state.settings);
    return a + (Q.isNum(it.unitPrice) ? q.suggestQty * it.unitPrice : 0);
  }, 0);
  const d = s.cost - base;
  const pct = base > 0 ? (d / base) * 100 : 0;
  return `<div class="totrow"><span>其中原料連動</span><b>
    <span class="chip ${d > 0.5 ? 'bad' : d < -0.5 ? 'ok' : ''}">${d >= 0 ? '+' : '−'}NT$ ${Q.fmt(Math.abs(d), 0)}　${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</span></b></div>`;
}

function renderPkgs() {
  const host = $('#pkgs');
  $('#pkgCount').textContent = String(state.packages.length);
  if (!state.packages.length) { host.innerHTML = '<div class="hint" style="padding:16px;text-align:center">尚無採購包。選好工項後按「轉採購 Package」。</div>'; return; }
  host.innerHTML = state.packages.map((p, i) => {
    const items = p.itemCodes.map((c) => state.itemByCode.get(c)).filter(Boolean);
    const s = Q.summarize(pricedAll(items), state.settings);
    const lead = items.reduce((a, it) => Math.max(a, it.leadTimeDays || 0), 0);
    return `<div class="pkg">
      <header><b>${esc(p.code)}</b><span class="chip">${items.length} 項</span><span class="chip acc">NT$ ${Q.fmt(s.cost, 0)}</span>
        <span class="spacer" style="flex:1"></span>
        <button class="btn sm" data-pkg-freeze="${i}">凍結為基準版</button>
        <button class="btn sm" data-pkg-csv="${i}">RFQ Excel</button>
        <button class="btn sm" data-pkg-del="${i}">刪除</button></header>
      <div class="body">
        <div class="row">
          <div><label class="f">包名稱</label><input type="text" data-pkg-name="${i}" value="${esc(p.name)}"></div>
          <div><label class="f">供應商／分包</label><input type="text" data-pkg-vendor="${i}" value="${esc(p.vendor || '')}"></div>
        </div>
        <div class="row">
          <div><label class="f">需求到貨日</label><input type="date" data-pkg-date="${i}" value="${esc(p.needDate || '')}"></div>
          <div><label class="f">最長前置期</label><input type="text" value="${lead} 天" disabled></div>
        </div>
        <div class="hint">${items.slice(0, 6).map((it) => esc(it.name)).join('、')}${items.length > 6 ? ` 等 ${items.length} 項` : ''}</div>
      </div></div>`;
  }).join('');
}

function renderAll() {
  renderTree(); renderTable(); renderCart(); renderPkgs(); renderBaselines(); renderPos(); renderDocs(); renderScope(); renderVerifyChip();
  const pc = $('#projContract'); if (pc) pc.value = state.settings.contractType || 'remeasure';
  const pn = $('#projName'); if (pn && pn.value !== state.projName) pn.value = state.projName;
  if (state.analysis) {                       // 資料變了就重算，不讓畫面停在舊結論
    const m = A.metrics(analysisCtx());
    state.analysis.metrics = m;
    renderStats(m); renderStages(m); renderRfi(m.rfis);
  }
  persist();
}

/* ══════════ 事件 ══════════ */

function wire() {
  // 左樹
  $('#tree').addEventListener('click', (e) => {
    const tw = e.target.closest('[data-tw]');
    if (tw) { const c = tw.dataset.tw; state.expanded.has(c) ? state.expanded.delete(c) : state.expanded.add(c); renderTree(); return; }
    const go = e.target.closest('[data-go]');
    if (go) { state.activeNode = state.activeNode === go.dataset.go ? null : go.dataset.go; renderTree(); renderTable(); return; }
  });
  $('#tree').addEventListener('change', (e) => {
    const cb = e.target.closest('[data-node]');
    if (!cb) return;
    const n = state.nodeByCode.get(cb.dataset.node);
    const items = descendantItems(n);
    if (cb.checked) items.forEach((i) => state.selected.add(i.code));
    else items.forEach((i) => state.selected.delete(i.code));
    renderAll();
  });
  $('#treeSearch').addEventListener('input', (e) => { state.search = e.target.value; renderTree(); renderTable(); });
  $('#btnExpandAll').onclick = () => { state.nodes.forEach((n) => state.expanded.add(n.code)); renderTree(); };
  $('#btnCollapseAll').onclick = () => { state.expanded.clear(); renderTree(); };

  // 中表
  $('#boqBody').addEventListener('click', (e) => {
    const ds = e.target.closest('[data-dist]'); if (ds) return openDistDialog(ds.dataset.dist);
    const s = e.target.closest('[data-src]'); if (s) return openSourceDialog(s.dataset.src);
    const b = e.target.closest('[data-basis]'); if (b) return openSourceDialog(b.dataset.basis);
    const c = e.target.closest('[data-conf]'); if (c) return openConfidenceDialog(c.dataset.conf);
  });
  $('#boqBody').addEventListener('pointerdown', (e) => { state.shiftDown = e.shiftKey; });
  $('#boqBody').addEventListener('change', (e) => {
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      const code = pick.dataset.pick;
      const idx = +pick.closest('tr').dataset.idx;
      if (e.target.checked) state.selected.add(code); else state.selected.delete(code);
      if (state.shiftDown && state.lastRowIndex != null) rangeSelect(state.lastRowIndex, idx, e.target.checked);
      state.lastRowIndex = idx;
      renderAll(); return;
    }
    const w = e.target.closest('[data-waste]');
    if (w) {
      const it = state.itemByCode.get(w.dataset.waste);
      const v = parseFloat(w.value);                    // 欄位以百分比輸入，內部一律存小數
      it.wasteRate = Number.isFinite(v) && v >= 0 ? Q.roundTo(v / 100, 6) : 0;
      renderAll(); return;
    }
  });
  $('#selAll').addEventListener('change', (e) => {
    visibleItems().forEach((i) => e.target.checked ? state.selected.add(i.code) : state.selected.delete(i.code));
    renderAll();
  });
  $('#btnAddSel').onclick = () => { visibleItems().forEach((i) => state.selected.add(i.code)); renderAll(); };
  $('#btnRmSel').onclick = () => { visibleItems().forEach((i) => state.selected.delete(i.code)); renderAll(); };
  $('#onlyIssues').addEventListener('change', (e) => { state.onlyIssues = e.target.checked; renderTable(); });

  // 右欄
  $('#cart').addEventListener('click', (e) => {
    const u = e.target.closest('[data-unpick]');
    if (u) { state.selected.delete(u.dataset.unpick); renderAll(); }
  });
  $('#btnClearCart').onclick = () => { if (confirm('清空已選清單？（採購包不受影響）')) { state.selected.clear(); renderAll(); } };
  $('#btnToPkg').onclick = toPackage;
  $('#btnAutoPkg').onclick = autoPackage;
  $('#btnSim').onclick = openPortfolioSim;
  $('#btnBid').onclick = openBid;
  $('#btnQuickPr').onclick = openQuickPr;
  $('#btnVendors').onclick = openVendors;
  $('#pos').addEventListener('click', (e) => {
    const v = e.target.closest('[data-poview]'); if (v) return openPo(v.dataset.poview);
  });
  $('#btnMarket').onclick = openMarket;
  $('#calcChip').onclick = openCalcSheet;
  $('#btnDrawReset').onclick = openDrawingReset;
  $('#dupChip').onclick = openDupe;
  $('#vfChip').onclick = openVerify;
  $('#btnVerify').onclick = openVerify;
  $('#pkgs').addEventListener('input', (e) => {
    const t = e.target;
    const set = (attr, key) => { const i = t.getAttribute(attr); if (i != null) { state.packages[+i][key] = t.value; persist(); } };
    set('data-pkg-name', 'name'); set('data-pkg-vendor', 'vendor'); set('data-pkg-date', 'needDate');
  });
  $('#pkgs').addEventListener('click', (e) => {
    const d = e.target.closest('[data-pkg-del]');
    if (d) { if (confirm('刪除此採購包？')) { state.packages.splice(+d.dataset.pkgDel, 1); renderAll(); } return; }
    const c = e.target.closest('[data-pkg-csv]');
    if (c) { exportPackageCsv(state.packages[+c.dataset.pkgCsv]); return; }
    const fz = e.target.closest('[data-pkg-freeze]');
    if (fz) openFreeze(+fz.dataset.pkgFreeze);
  });
  $('#baselines').addEventListener('click', (e) => {
    const v = e.target.closest('[data-blview]'); if (v) return openBaselineDetail(v.dataset.blview);
    const d = e.target.closest('[data-bldiff]'); if (d) return openBaselineDiff(d.dataset.bldiff);
    const p = e.target.closest('[data-blpr]'); if (p) return openCreatePr(p.dataset.blpr);
    const x = e.target.closest('[data-prexp]'); if (x) return openExportPr(x.dataset.prexp);
  });

  // 頂部
  $('#btnImportDrawing').onclick = () => $('#fileDrawing').click();
  $('#fileDrawing').onchange = (e) => { const f = e.target.files[0]; if (f) loadDrawing(f); e.target.value = ''; };
  $('#btnImportBoq').onclick = () => $('#fileBoq').click();
  $('#fileBoq').onchange = (e) => { const f = e.target.files[0]; if (f) importBoqCsv(f); e.target.value = ''; };
  $('#fileProject').onchange = (e) => { const f = e.target.files[0]; if (f) importProject(f); e.target.value = ''; };
  $('#fileVendors').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      const raw = Array.isArray(d) ? d : (d.vendors || []);
      if (!raw.length) throw new Error('檔案裡找不到 vendors 陣列');
      state.vendors = raw.map(VD.normalize);
      persist(); renderAll();
      setTimeout(() => dialog('已匯入廠商主檔', `<p>載入 <b>${state.vendors.length}</b> 家廠商。</p>
        <p class="hint">缺的欄位就是缺 —— 工具不會用平均值補。資料完整度會顯示在建議廠商的表格裡。</p>`), 60);
    } catch (err) { dialog('匯入失敗', `<p>${esc(err.message)}</p>`); }
  };
  $('#btnSettings').onclick = openSettings;
  $('#btnExport').onclick = openExport;
  $('#btnHelp').onclick = openHelp;

  // 分頁（中欄清單 / 圖面）
  $('#tabScan').onclick = () => setMidTab('scan');
  $('#tabList').onclick = () => setMidTab('list');
  $('#tabView').onclick = () => setMidTab('view');
  $('#tabSeq').onclick = () => setMidTab('seq');
  $('#seqView').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sv]'); if (!b) return;
    $$('#seqView [data-sv]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    state.seqView = b.dataset.sv; renderSeq();
  });
  $('#btnSeqLoad').onclick = loadSequenceTemplate;
  $('#btnSeqCsv').onclick = exportSeqCsv;
  $('#seqStart').onchange = (e) => { state.seqStart = e.target.value; runSchedule(); renderSeq(); persist(); };
  $('#seqBody').addEventListener('click', (e) => {
    const g = e.target.closest('[data-gate]');
    if (g) return cycleGate(g.dataset.gate);
    const f = e.target.closest('#btnFeasApply');
    if (f) {
      state.seqStart = f.dataset.start;
      $('#seqStart').value = f.dataset.start;
      runSchedule(); renderSeq(); persist();
      return;
    }
    const d = e.target.closest('[data-task]');
    if (d) return openTaskDialog(d.dataset.task);
  });

  // 解析中心
  $('#projName').oninput = (e) => { state.projName = e.target.value; persist(); };
  $('#projContract').onchange = (e) => { state.settings.contractType = e.target.value; renderAll(); };
  $('#upBar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-up]'); if (!b) return;
    state.pendingUpKind = b.dataset.up;
    const inp = $('#fileDoc');
    inp.accept = A.DOC_KINDS[state.pendingUpKind].accept;
    inp.click();
  });
  $('#fileDoc').onchange = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    for (const f of files) await ingestDoc(f, state.pendingUpKind);
  };
  $('#docList').addEventListener('click', (e) => {
    const d = e.target.closest('[data-docdel]');
    if (d) { state.docs = state.docs.filter((x) => x.id !== d.dataset.docdel); renderDocs(); persist(); }
    const o = e.target.closest('[data-docopen]');
    if (o) openDocInViewer(o.dataset.docopen);
  });
  $('#docList').addEventListener('change', (e) => {
    const sel = e.target.closest('[data-docsheet]');
    if (!sel) return;
    const doc = state.docs.find((x) => x.id === sel.dataset.docsheet);
    if (doc) { doc.sheetType = sel.value; persist(); }
  });
  $('#scopeBox').addEventListener('change', onScopeChange);
  $('#btnAnalyze').onclick = runAnalysis;
  $('#btnRfiCsv').onclick = exportRfiCsv;
  $('#stats').addEventListener('click', (e) => {
    const c = e.target.closest('[data-stat]'); if (c) onStatClick(c.dataset.stat);
  });
  $('#rfiList').addEventListener('click', (e) => {
    const g = e.target.closest('[data-rfigo]');
    if (g) { state.search = g.dataset.rfigo; $('#treeSearch').value = g.dataset.rfigo; state.activeNode = null; renderTree(); renderTable(); setMidTab('list'); return; }
    const a = e.target.closest('[data-rfi]');
    if (!a) return;
    ({ issue: openIssueRfi, answer: openAnswerRfi, close: openCloseRfi, dismiss: openDismissRfi, reopen: openReopenRfi }[a.dataset.rfi] || (() => {}))(a.dataset.id);
  });
  $('#rfiFilter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rf]'); if (!b) return;
    $$('#rfiFilter [data-rf]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    state.rfiFilter = b.dataset.rf;
    if (state.analysis) renderRfi(state.analysis.metrics.rfis);
  });

  // 窄螢幕欄位切換
  $$('.tabbar [data-tab]').forEach((b) => b.onclick = () => {
    $$('.tabbar [data-tab]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    const cols = [$('#colLeft'), $('#colMid'), $('#colRight')];
    cols.forEach((c, i) => c.classList.toggle('show', i === +b.dataset.tab));
    state.viewer && state.viewer.resize();
  });

  // 圖面工具列
  $('#tools').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tool]'); if (!b) return;
    $$('#tools [data-tool]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    state.viewer.setTool(b.dataset.tool);
  });
  $('#btnFit').onclick = () => state.viewer.fit();
  $('#btnSnap').onclick = (e) => { const v = state.viewer; v.snap = !v.snap; e.currentTarget.setAttribute('aria-pressed', String(v.snap)); };
  $('#btnOrtho').onclick = (e) => { const v = state.viewer; v.ortho = !v.ortho; e.currentTarget.setAttribute('aria-pressed', String(v.ortho)); };
  $('#btnLayers').onclick = openLayers;
  $('#scaleChip').onclick = openScaleDialog;
  $('#mlist').addEventListener('click', (e) => {
    const a = e.target.closest('[data-assign]'); if (a) return openAssign(a.dataset.assign);
    const d = e.target.closest('[data-mdel]'); if (d) { state.viewer.removeMeasurement(d.dataset.mdel); renderMeasureList(); }
  });

  // 拖放圖面
  document.addEventListener('dragover', (e) => { e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer.files || [])];
    for (const f of files) {
      if (/\.json$/i.test(f.name)) importProject(f);
      else if (/\.(dxf|dwg)$/i.test(f.name)) ingestDoc(f, 'drawing');
      else if (/\.pdf$/i.test(f.name)) ingestDoc(f, 'drawing');
      else if (/\.csv$/i.test(f.name)) ingestDoc(f, 'boq');
      else ingestDoc(f, 'spec');
    }
  });

  window.addEventListener('resize', () => state.viewer && state.viewer.resize());
}

function rangeSelect(a, b, on) {
  const list = visibleItems();
  const [lo, hi] = a < b ? [a, b] : [b, a];
  for (let i = lo; i <= hi; i++) if (list[i]) on ? state.selected.add(list[i].code) : state.selected.delete(list[i].code);
}

function setMidTab(t) {
  const tabs = { scan: '#tabScan', list: '#tabList', view: '#tabView', seq: '#tabSeq' };
  Object.entries(tabs).forEach(([k, sel]) => $(sel).setAttribute('aria-pressed', String(k === t)));
  $('#scanWrap').classList.toggle('on', t === 'scan');
  $('#tableWrap').classList.toggle('on', t === 'list');
  $('#viewWrap').classList.toggle('on', t === 'view');
  $('#seqWrap').classList.toggle('on', t === 'seq');
  if (t === 'view') requestAnimationFrame(() => { state.viewer.resize(); state.viewer.fit(); });
  if (t === 'seq') renderSeq();
}

/* ══════════ 圖面載入 ══════════ */

async function loadDrawing(file) {
  const name = file.name;
  const ext = (name.split('.').pop() || '').toLowerCase();
  setMidTab('view');
  $('#drawName').textContent = `載入中… ${name}`;
  try {
    // 檔案只讀一次。簽章在這裡算好往下傳，三條載入路徑共用同一個版本判斷。
    const prev = state.drawing ? { name: state.drawing.name, sig: state.drawing.sig } : null;
    const buf = await file.arrayBuffer();
    const sig = fileSig(buf);
    const rev = registerDrawing(name, sig);
    if (ext === 'pdf') await loadPdfFile(file, buf, sig);
    else if (ext === 'dxf') await loadDxfFile(file, buf, sig);
    else if (ext === 'dwg') await loadDwgFile(file, buf, sig);
    else throw new Error('僅支援 DWG / DXF / PDF');
    // 真的換了圖才清（同一個檔重新載入不算）
    const changed = !prev || prev.name !== name || prev.sig !== sig;
    const auto = changed ? autoClearOnDrawingChange(prev && prev.name) : null;
    persist();
    if (auto) announceAutoClear(auto, prev && prev.name);
    // 自動清除之後還留著的才需要提醒改版 —— 已經清掉的不必再講一次
    const leftover = rev.revised ? rev.affected.filter((it) => Q.isNum(it.qty.drawing)) : [];
    if (leftover.length) announceRevision(name, leftover);
  } catch (e) {
    console.error(e);
    $('#drawName').textContent = '載入失敗';
    dialog('圖面載入失敗', `<p>${esc(e.message)}</p>`);
  }
}

async function loadDxfFile(file, buf, sig) {
  if (DXF.isBinaryDxf(buf)) throw new Error('這是二進位 DXF。請在 CAD 另存為「ASCII DXF」後再匯入。');
  // 台灣的 DXF 幾乎都是 Big5。寫死 UTF-8 會把每個中文字變成 U+FFFD ——
  // 畫面上就是那一整排 ????，而且看起來跟「缺字型」一模一樣。
  const enc = ENC.decodeDxf(buf);
  state.encoding = enc;
  const doc = DXF.parseDxf(enc.text);
  if (!doc.entities.length) throw new Error('DXF 中找不到可用實體（模型空間為空或版本過舊）。');
  state.drawing = { name: file.name, kind: 'dxf', doc, sig };
  state.viewer.loadDxf(doc);
  switchMeasureContext(measureKeyOf(file.name, sig, 1));
  $('#drawName').textContent = `${file.name} · ${doc.entities.length} 實體 · 單位 ${doc.units.name} · ${enc.encoding}`;
  renderSheetChip();
  // 只在真的有風險時打斷使用者：解出無法辨識的字，或檔頭宣告被推翻。
  // 乾淨的推測不需要跳視窗嚇人 —— 用什麼編碼解的已經寫在狀態列了。
  if (enc.bad > 0 || enc.from === 'guess-after-bad-codepage') {
    setTimeout(() => dialog('文字編碼', `<p>${esc(ENC.describe(enc))}</p>
      ${enc.bad > 0 ? `<p class="chip bad" style="display:block;padding:8px 10px">仍有 ${enc.bad} 個字無法解出。</p>` : ''}
      <p class="hint">各候選編碼的評分：${enc.tried.map((t) => `${esc(t.encoding)} ${t.score}`).join('　')}</p>
      <p class="hint"><b>解碼錯誤與缺字型不一樣。</b>缺字型是 CAD 找不到 SHX 大字型檔、畫不出字形，換字型就好；
      解碼錯誤是位元組被錯誤詮釋，字根本不存在了，換字型無效。這裡處理的是後者。</p>`), 80);
  }
  $('#pageChip').hidden = true;
  updateScaleChip();
  renderMeasureList();
  detectCalcSheet(doc, file.name);
  checkSurvey(doc);
  runDupe();
  if (!doc.units.toM) {
    dialog('圖檔未定義單位', `<p>此 DXF 的 <code>$INSUNITS</code> 為「未定義」，無法自動換算成公尺。請指定圖檔單位：</p>
      <div class="fgrid">${[[0.001, '公厘 mm'], [0.01, '公分 cm'], [1, '公尺 m'], [0.0254, '英吋 in']].map(([v, l]) =>
      `<button class="btn" data-unit="${v}">${l}</button>`).join('')}</div>`, [], (body) => {
      body.addEventListener('click', (e) => {
        const b = e.target.closest('[data-unit]'); if (!b) return;
        state.viewer.setNativeUnit(parseFloat(b.dataset.unit));
        updateScaleChip(); $('#dlg').close();
      });
    });
  } else {
    openLayers();
  }
}

async function loadPdfFile(file, buf, sig) {
  const pdfjs = await import('../../vendor/pdfjs/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  // pdf.js 會接管這塊 buffer，先複製一份給它，原本那份留著算簽章與重載
  const pdf = await pdfjs.getDocument({ data: buf.slice(0) }).promise;
  state.drawing = { name: file.name, kind: 'pdf', pdf, pageNo: 1, pages: pdf.numPages, sig };
  // PDF 沒有 DXF 那一路的計算式表；不重設的話上一張 DXF 的晶片會留在工具列上
  state.calc = null; state.encoding = null; state.survey = null; state.dupe = null; state.dims = null;
  renderCalcChip(); renderDupeChip();
  await state.viewer.loadPdf(pdf, 1);
  switchMeasureContext(measureKeyOf(file.name, sig, 1));
  await readFramedScale(pdf, 1);
  $('#drawName').textContent = `${file.name} · ${pdf.numPages} 頁`
    + (state.pdfScale && state.pdfScale.paper ? ` · ${state.pdfScale.paper.name}` : '');
  renderSheetChip();
  const chip = $('#pageChip');
  chip.hidden = false;
  chip.innerHTML = `第 <b>1</b>/${pdf.numPages} 頁`;
  chip.style.cursor = 'pointer';
  chip.onclick = async () => {
    const n = parseInt(prompt(`跳至第幾頁？(1–${pdf.numPages})`, String(state.drawing.pageNo)), 10);
    if (!n || n < 1 || n > pdf.numPages) return;
    state.drawing.pageNo = n;
    await state.viewer.loadPdf(pdf, n);
    switchMeasureContext(measureKeyOf(file.name, sig, n));
    await readFramedScale(pdf, n);
    chip.innerHTML = `第 <b>${n}</b>/${pdf.numPages} 頁`;
    updateScaleChip(); renderMeasureList();
  };
  updateScaleChip();
  renderMeasureList();
  openScaleDialog(true);
}

/**
 * DWG 是封閉格式，瀏覽器無法原生解析。三條合法路徑，依序嘗試：
 *   1) 自建轉檔服務（/api/convert-dwg → ODA File Converter / LibreDWG，程序外呼叫，不污染本站授權）
 *   2) 使用者自行啟用的 GPL WASM 解析器（不隨本專案散布，由操作者自負授權責任）
 *   3) 人工轉出 DXF/PDF
 */
async function loadDwgFile(file, buf, sig) {
  const ver = DXF.dwgVersion(buf);
  const endpoint = window.TAKEOFF_DWG_ENDPOINT || '/api/convert-dwg';
  $('#drawName').textContent = `DWG (${ver.name || ver.sig}) 轉檔中…`;
  try {
    // 直接送原始位元組：轉檔服務的契約是「收 DWG bytes → 回 ASCII DXF 文字」，
    // 不用 multipart 可以少一層解析，也避免各家 serverless 對 body 的處理差異。
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) },
      body: buf,
    });
    if (r.ok) {
      const text = await r.text();
      const doc = DXF.parseDxf(text);
      if (doc.entities.length) {
        state.drawing = { name: file.name, kind: 'dwg', doc, via: 'server', sig };
        state.viewer.loadDxf(doc);
        switchMeasureContext(measureKeyOf(file.name, sig, 1));
        runDupe();
        $('#drawName').textContent = `${file.name} · 經轉檔服務 · ${doc.entities.length} 實體`;
        renderSheetChip();
        updateScaleChip(); renderMeasureList(); openLayers();
        return;
      }
    }
    const detail = await r.text().catch(() => '');
    throw new Error(`轉檔服務回應 ${r.status}${detail ? '：' + detail.slice(0, 200) : ''}`);
  } catch (err) {
    if (window.TAKEOFF_LIBREDWG_BASE) { await loadDwgViaWasm(buf, file.name, sig); return; }
    $('#drawName').textContent = '未載入圖面';
    dialog('DWG 需要轉檔', `
      <p>偵測到 <b>${esc(file.name)}</b>（${esc(ver.name || ver.sig || '未知版本')}）。DWG 是 Autodesk 的封閉二進位格式，
      瀏覽器無法在不引入第三方解析器的情況下直接讀取。目前轉檔服務不可用：<span class="hint">${esc(err.message)}</span></p>
      <h4>選項 A（建議，資料不出公司）</h4>
      <p>在內網跑一台轉檔服務，並設定 <code>DWG_CONVERT_URL</code> 讓 <code>/api/convert-dwg</code> 轉發：</p>
      <pre class="k" style="display:block;padding:9px;overflow:auto">ODAFileConverter /in /out ACAD2018 DXF 0 1 "*.dwg"
# 或： dwg2dxf -o out.dxf in.dwg   （LibreDWG，GPL-3）</pre>
      <h4>選項 B（單機，自負授權）</h4>
      <p>啟用瀏覽器端 GPL-3 的 libredwg-web WASM 解析器：在頁面載入前設定
      <code>window.TAKEOFF_LIBREDWG_BASE = 'https://…/libredwg-web/'</code>。
      GPL-3 具傳染性，商用前請先確認授權合規。</p>
      <h4>選項 C（最快）</h4>
      <p>在 AutoCAD／BricsCAD 另存為 <b>ASCII DXF</b>，或列印成 <b>向量 PDF</b> 後匯入，功能完全相同。</p>`);
  }
}

async function loadDwgViaWasm(buf, name, sig) {
  const base = window.TAKEOFF_LIBREDWG_BASE.replace(/\/?$/, '/');
  const mod = await import(/* @vite-ignore */ base + 'libredwg-web.js');
  const lib = await mod.LibreDwg.create(base);
  const dwg = lib.dwg_read_data(buf, mod.Dwg_File_Type.DWG);
  const db = lib.convert(dwg);
  const doc = DXF.fromDwgDatabase(db);
  try { lib.dwg_free(dwg); } catch { /* 記憶體釋放失敗不影響解析結果 */ }
  state.drawing = { name, kind: 'dwg', doc, via: 'wasm', sig };
  state.viewer.loadDxf(doc);
  switchMeasureContext(measureKeyOf(name, sig, 1));
  runDupe();
  $('#drawName').textContent = `${name} · WASM 解析 · ${doc.entities.length} 實體`;
  renderSheetChip();
  updateScaleChip(); renderMeasureList(); openLayers();
}

/**
 * 自動抓量的結果報告 —— 重點不是「寫進去幾個」，是**沒寫進去的有哪些、為什麼**。
 *
 * 使用者要的就是這個：「無法分辨」的擋住不讓套用，但列於最後的漏項。
 * 一份只講成功數的報告，會讓人以為剩下的都不重要；
 * 漏項清單讓「這一層沒算到」變成一件看得見、要處理的事。
 */
function openTakeoffReport(written, missed) {
  const order = { bad: 0, warn: 1, info: 2 };
  const rows = missed.slice().sort((a, b) => order[a.level] - order[b.level])
    .map((x) => `<tr><td><span class="chip ${x.level === 'bad' ? 'bad' : x.level === 'warn' ? 'warn' : ''}">${
      x.level === 'bad' ? '擋下' : x.level === 'warn' ? '注意' : '未對映'}</span></td>
      <td>${esc(x.layer)}</td><td class="hint">${esc(x.why)}</td></tr>`).join('');
  const blocked = missed.filter((x) => x.level === 'bad').length;
  dialog('自動抓量結果', `
    <p>已從 <b>${written}</b> 個圖層寫入圖面量${blocked ? `，<b class="bad">${blocked} 個被擋下</b>` : ''}。</p>
    ${missed.length ? `<h4 style="margin:12px 0 6px">漏項清單（${missed.length}）</h4>
      <table class="mat"><thead><tr><th style="width:74px">狀態</th><th>圖層</th><th>原因</th></tr></thead>
        <tbody>${rows}</tbody></table>
      <p class="hint" style="margin-top:8px"><b>「擋下」的必須處理，不能當成沒看見。</b>
      重複描繪回 CAD 清乾淨後重新匯出；無法分辨的請人工指定工項，或請設計單位把不同規格分層。
      「未對映」多半是註記層、圖框層，通常可以忽略 —— 但請確認清單上不該有的工項沒有因此漏掉。</p>`
      : '<p class="chip ok" style="display:block;padding:9px 11px">沒有漏項，每一個圖層都有處置。</p>'}
    <p class="hint">請切回清單檢查差異欄與可信度。自動抓量的結果標記為 <code>auto</code> 並在可信度上扣分，必須人工抽查。</p>`);
}

/* ══════════ 驗算中心 ══════════ */

/** 蒐集目前所有可得的檢查結果，組成一份報告。 */
function verifyContext() {
  const items = state.items.filter((it) => Q.isNum(it.qty && it.qty.drawing));
  return {
    dimensions: state.dims,
    dupe: state.dupe,
    survey: state.survey,
    pdfScale: state.pdfScale,
    calc: state.calc,
    items,
    closure: VF.checkClosure(items),
    magnitude: VF.checkMagnitude(items),
    cross: VF.crossSources(state.items, { warn: state.settings.varianceWarn }),
  };
}

function renderVerifyChip() {
  const el = $('#vfChip');
  if (!el) return;
  const r = VF.report(verifyContext());
  el.hidden = false;
  el.style.cursor = 'pointer';
  el.className = 'chip ' + (r.verdict === 'bad' ? 'bad' : r.verdict === 'warn' ? 'warn' : r.verdict === 'ok' ? 'ok' : '');
  el.textContent = r.verdict === 'none' ? '驗算：無可驗'
    : r.bad ? `驗算 ${r.bad} 項不過` : r.warn ? `驗算 ${r.warn} 項待確認` : `驗算 ${r.ok} 項通過`;
}

const VF_ICON = { ok: '✓', warn: '！', bad: '✗', none: '—' };

/**
 * 驗算報告。
 *
 * 最重要的一件事是把「已驗過」與「沒得驗」分開 ——
 * 這兩件事在畫面上長得很像，意義卻完全相反。
 * 「沒有發現錯誤」跟「沒有檢查」混在一起講，就是騙人。
 */
function openVerify() {
  const ctx = verifyContext();
  const r = VF.report(ctx);
  const d = ctx.dimensions;

  const rows = r.checks.map((c) => `<tr class="${c.status === 'bad' ? 'overdue' : c.status === 'warn' ? 'urgent' : ''}">
    <td style="width:26px;text-align:center"><b class="${c.status === 'bad' ? 'neg' : c.status === 'ok' ? 'pos' : ''}">${VF_ICON[c.status]}</b></td>
    <td>${esc(c.label)}</td>
    <td><span class="chip ${c.status === 'bad' ? 'bad' : c.status === 'warn' ? 'warn' : c.status === 'ok' ? 'ok' : ''}">${
      c.status === 'ok' ? '通過' : c.status === 'warn' ? '待確認' : c.status === 'bad' ? '不通過' : '沒得驗'}</span></td>
    <td class="hint">${esc(c.msg)}</td></tr>`).join('');

  // 標註比對的細節 —— 這是整份報告裡最有力的一段，值得攤開
  const dimRows = d && d.rows ? d.rows.filter((x) => x.verdict === 'scale' || x.verdict === 'override')
    .slice(0, 12).map((x) => `<tr class="${x.verdict === 'override' ? 'overdue' : 'urgent'}">
      <td class="n">${Q.fmt(x.measured, 4)}</td>
      <td class="n">${esc(x.text)}</td>
      <td class="n">${x.ratio}</td>
      <td>${x.verdict === 'scale' ? `<span class="chip warn">差 ${x.magnitude} 倍</span>`
        : '<span class="chip bad">標註被覆寫</span>'}</td>
      <td class="hint">${esc(x.layer || '')} @ ${Q.fmt(x.at ? x.at.x : 0, 0)}, ${Q.fmt(x.at ? x.at.y : 0, 0)}</td>
    </tr>`).join('') : '';

  dialog('驗算報告', `
    <p class="chip ${r.verdict === 'bad' ? 'bad' : r.verdict === 'warn' ? 'warn' : r.verdict === 'ok' ? 'ok' : ''}"
      style="display:block;padding:9px 11px;white-space:normal">${esc(r.note)}</p>

    <table class="mkt" style="margin:10px 0"><thead><tr><th></th><th>檢查項目</th><th>結果</th><th>說明</th></tr></thead>
      <tbody>${rows}</tbody></table>

    <p class="hint"><b>「沒得驗」不是「沒有錯」。</b>
      這兩件事在畫面上長得很像，意義卻完全相反 —— 一張沒有標註、沒有計算式、
      只有一條數量來源的圖，八項檢查可以一項都不亮紅燈，但它什麼都沒被驗過。</p>

    <h4 style="margin:16px 0 6px">圖面標註 vs 幾何（最直接的一條）</h4>
    ${!d || !d.total ? `<p class="hint">這張圖沒有 DIMENSION 標註實體，這條驗不了。</p>` : `
      <div class="totrow"><span>標註總數</span><b>${d.total}</b></div>
      <div class="totrow"><span>可比對（文字是明確數字）</span><b>${d.checked}</b></div>
      <div class="totrow"><span>與幾何一致</span><b class="pos">${d.match}</b></div>
      <div class="totrow"><span>差整數量級</span><b class="${d.scale ? 'neg' : ''}">${d.scale}</b></div>
      <div class="totrow"><span>標註被覆寫</span><b class="${d.override ? 'neg' : ''}">${d.override}</b></div>
      <div class="totrow"><span>未覆寫（用量到的值）／無法解析</span><b class="hint">${d.noOverride} / ${d.unparsed}</b></div>
      ${dimRows ? `<table class="mat" style="margin-top:8px"><thead><tr><th class="n">幾何量到</th><th class="n">圖上印的</th>
        <th class="n">比值</th><th>判定</th><th>位置</th></tr></thead><tbody>${dimRows}</tbody></table>` : ''}
      ${d.dominant ? `<p class="chip bad" style="display:block;padding:8px 10px;margin-top:8px;white-space:normal">
        <b>${d.dominant.count}/${d.checked} 個標註都差 ${d.dominant.magnitude} 倍</b> ——
        這不是個別失誤，是整張圖的單位或比例設定就不對。
        在改正之前，這張圖抓出來的<b>每一個數量都錯 ${d.dominant.magnitude} 倍</b>。</p>` : ''}
      ${d.override ? `<p class="chip bad" style="display:block;padding:8px 10px;margin-top:8px;white-space:normal">
        <b>${d.override} 個標註的文字被手動打成別的數字。</b>
        這是圖面最危險的一種錯：<b>人看圖相信文字，程式量測相信幾何</b>，
        兩邊永遠對不起來，而且誰都沒說謊。必須發 RFI 問設計單位以哪個為準。</p>` : ''}`}

    <p class="hint" style="margin-top:14px">DXF 的 DIMENSION 實體同時存了兩個數字：
      CAD <b>自己從幾何算出</b>的量測值（group 42），與圖上<b>印出來</b>的那行字（group 1）。
      正常情況兩者一致；不一致時，比值是不是整數量級就分得出來是「單位／比例錯」還是「標註被改過」。
      <b>圖面自己帶著答案</b>，這條檢查不需要任何外部資料。</p>`,
    [{ label: '關閉' }, { label: '匯出 Excel', fn: () => exportVerify(r, ctx) }]);
}

function exportVerify(r, ctx) {
  const sheets = [{ name: '驗算摘要', rows: [
    ['檢查項目', '結果', '說明'],
    ...r.checks.map((c) => [c.label,
      c.status === 'ok' ? '通過' : c.status === 'warn' ? '待確認' : c.status === 'bad' ? '不通過' : '沒得驗',
      c.msg]),
    [], ['總評', r.note],
  ] }];
  const d = ctx.dimensions;
  if (d && d.rows && d.rows.length) {
    sheets.push({ name: '標註比對', rows: [
      ['幾何量到', '圖上印的', '解出數字', '比值', '判定', '圖層', 'X', 'Y'],
      ...d.rows.map((x) => [x.measured, x.text, x.stated ?? '', x.ratio ?? '',
        { match: '一致', scale: `差 ${x.magnitude} 倍`, override: '標註被覆寫',
          'no-override': '未覆寫', unparsed: '無法解析' }[x.verdict] || x.verdict,
        x.layer || '', x.at ? x.at.x : '', x.at ? x.at.y : '']),
    ] });
  }
  if (ctx.cross && ctx.cross.length) {
    sheets.push({ name: '多來源比對', rows: [
      ['工項代碼', '名稱', '來源數', '最大差異', '判定', '明細'],
      ...ctx.cross.map((x) => [x.code, x.name, x.sources, x.spread ?? '',
        x.level === 'ok' ? '一致' : x.level === 'warn' ? '待確認' : '不通過', x.detail || x.why]),
    ] });
  }
  exportExcel('驗算報告', sheets);
}

/* ══════════ 廠商、請購單、發包單 ══════════ */

/**
 * 一鍵：BOM 明細 → 採購包 → 基準版 → 請購單。
 *
 * 原本要走三個視窗。合成一鍵之後最容易犯的錯是**順手把閘門也拿掉** ——
 * 可信度不足、RFI 未結案、重複描繪被擋下的項目，本來就不該進採購。
 * 所以這裡只省掉點擊，不省掉檢查：擋下的照樣擋，而且要在同一個畫面上
 * 講清楚是哪幾項、為什麼，讓人當場決定要不要先處理。
 */
function openQuickPr() {
  const list = selectedItems();
  if (!list.length) return dialog('沒有已選工項', '<p>先在清單勾選要請購的工項，再按一鍵轉請購單。</p>');

  const priced2 = pricedAll(list);
  const gate = state.settings.gateBand;
  const pass = [], blocked = [];
  for (const it of priced2) {
    const pp = Q.suggestPurchase(it, state.settings);
    const c = Q.confidence(it, { settings: state.settings, basis: pp.basis });
    const why = [];
    if (pp.blocked) why.push('數量來源被鎖定');
    if (!Q.bandAtLeast(c.band, gate)) why.push(`可信度 ${c.band} 低於門檻 ${gate}`);
    if (!Q.isNum(pp.orderQty)) why.push('算不出下單量');
    (why.length ? blocked : pass).push({ it, p: pp, c, why });
  }
  if (!pass.length) {
    return dialog('沒有任何工項可請購', `
      <p>已選的 ${list.length} 項全部沒通過採購閘門。</p>
      <table class="mat"><thead><tr><th>工項</th><th>原因</th></tr></thead><tbody>
        ${blocked.map((b) => `<tr><td>${esc(b.it.code)} ${esc(b.it.name)}</td><td class="hint">${esc(b.why.join('；'))}</td></tr>`).join('')}
      </tbody></table>`);
  }

  const items = pass.map((x) => x.it);
  const cost = pass.reduce((a, x) => a + (x.p.cost || 0), 0);
  const maxLead = Math.max(0, ...items.map((it) => it.leadTimeDays || 0));
  const cats = VD.categoriesOf(items);
  const needDate = S.addDays(new Date().toISOString().slice(0, 10), maxLead + 7);
  const sug = VD.suggest(state.vendors, { code: 'QUICK', categories: cats, amount: cost, needDate });

  dialog('一鍵轉請購單', `
    <p>已選 <b>${list.length}</b> 項，其中 <b>${pass.length}</b> 項可請購${blocked.length ? `、<b class="bad">${blocked.length} 項被閘門擋下</b>` : ''}。</p>
    <div class="totrow"><span>直接成本（未稅）</span><b>NT$ ${Q.fmt(cost, 0)}</b></div>
    <div class="totrow"><span>最長前置期</span><b>${maxLead} 天</b></div>
    <div class="totrow"><span>建議需求到貨日</span><b>${esc(needDate)}</b></div>
    ${blocked.length ? `<p class="chip bad" style="display:block;padding:8px 10px;margin-top:8px;white-space:normal">
      被擋下的 ${blocked.length} 項<b>不會</b>進入這張請購單：
      ${esc(blocked.slice(0, 6).map((b) => `${b.it.code}（${b.why[0]}）`).join('、'))}${blocked.length > 6 ? ' …' : ''}。</p>` : ''}

    <h4 style="margin:14px 0 6px">建議廠商</h4>
    ${vendorSuggestHtml(sug)}

    <div class="fgrid" style="margin-top:10px">
      <div><label class="f">請購人（必填）</label><input type="text" id="qReq" placeholder="姓名"></div>
      <div><label class="f">工程確認人（必填）</label><input type="text" id="qConf" placeholder="凍結基準版需要"></div>
      <div><label class="f">部門</label><input type="text" id="qDept" value="${esc(state.settings.dept || '')}"></div>
      <div><label class="f">需求到貨日</label><input type="date" id="qNeed" value="${esc(needDate)}"></div>
      <div><label class="f">建議廠商</label><input type="text" id="qVend" value="${esc(sug.best ? (sug.ranked.find((x) => x.code === sug.best) || {}).name || '' : '')}"></div>
      <div><label class="f">稅率</label><input type="number" id="qTax" step="0.01" value="${state.settings.taxRate}"></div>
    </div>
    <p class="hint" style="margin-top:8px"><b>一鍵是省掉點擊，不是省掉檢查。</b>
    可信度不足、數量來源被鎖定、算不出下單量的工項，照樣不會進這張單 ——
    這一段的檢查跟手動走三個視窗完全一樣。</p>
    <p class="hint">這一鍵會依序建立<b>採購包 → 基準版 → 請購單</b>三筆紀錄，
    而不是直接生一張單 —— 基準版是「這批量在這個時間點被誰確認過」的證據，
    少了它，日後數量有爭議時沒有東西可以對。</p>`,
    [{ label: '取消' }, {
      label: '建立', primary: true, fn: () => {
        const req = $('#qReq').value.trim(), conf = $('#qConf').value.trim();
        if (!req || !conf) return setTimeout(() => dialog('缺必填欄位', '<p>請購人與工程確認人都必須填 —— 沒有人負責的單不能發。</p>'), 60);
        const vend = $('#qVend').value.trim(), need = $('#qNeed').value, tax = parseFloat($('#qTax').value);
        const pkg = {
          code: `PKG-${String(state.packages.length + 1).padStart(3, '0')}`,
          name: `一鍵請購 ${new Date().toISOString().slice(0, 10)}`,
          vendor: vend, needDate: need, itemCodes: items.map((it) => it.code),
        };
        state.packages.push(pkg);
        const fz = B.freezeBaseline(pkg, items, state.settings, { confirmedBy: conf, by: conf, note: '一鍵轉請購單' });
        if (fz.error) return setTimeout(() => dialog('凍結基準版失敗', `<p>${esc(fz.error)}</p>`), 60);
        state.baselines.push(fz.baseline);
        const pr = B.createPr(fz.baseline, {
          requester: req, dept: $('#qDept').value.trim(), project: state.projName,
          vendor: vend, needDate: need, taxRate: Number.isFinite(tax) ? tax : state.settings.taxRate,
          template: state.settings.prTemplate,
        }, state.prs.map((x) => x.no));
        if (pr.error) return setTimeout(() => dialog('產生請購單失敗', `<p>${esc(pr.error)}</p>`), 60);
        state.prs.push(pr.pr);
        renderAll(); persist();
        setTimeout(() => openExportPr(pr.pr.no), 80);
      },
    }]);
}

/** 建議廠商的區塊 —— 分不出來就說分不出來，被否決的也要列出理由。 */
function vendorSuggestHtml(sug) {
  if (!state.vendors.length) {
    return `<p class="chip warn" style="display:block;padding:8px 10px;white-space:normal">
      廠商主檔是空的，無法建議。按右欄的「廠商主檔」匯入貴公司的廠商資料
      —— 沒有交期達成率、不良率、報價指數這些歷史數字，任何「建議廠商」都是憑空排名。</p>`;
  }
  const rows = sug.ranked.slice(0, 5).map((x, i) => `<tr class="${i === 0 && sug.best ? 'on' : ''}">
    <td>${esc(x.name)}</td><td class="n">${x.score}</td>
    <td class="n">${(x.coverage * 100).toFixed(0)}%</td>
    <td class="hint">${esc(x.reasons.slice(0, 3).join('；'))}</td></tr>`).join('');
  const rel = VD.relatedParties(state.vendors);
  return `
    <table class="mkt"><thead><tr><th>廠商</th><th class="n">分數</th><th class="n">資料完整度</th><th>依據</th></tr></thead>
      <tbody>${rows}</tbody></table>
    <p class="hint" style="margin-top:6px">${esc(sug.why)}</p>
    ${sug.ambiguous.length ? `<p class="chip bad" style="display:block;padding:8px 10px;white-space:normal">
      前幾名分數相近，<b>工具不指定第一名</b>。廠商評分的輸入是歷史統計，本來就有雜訊 ——
      差幾分就說某一家比較好是拿雜訊當訊號。請人工比較。</p>` : ''}
    ${sug.blocked.length ? `<p class="chip warn" style="display:block;padding:8px 10px;white-space:normal">
      ${sug.blocked.length} 家因資格不符被排除（不是扣分，是不能用）：
      ${sug.blocked.map((b) => `${esc(b.name)}（${esc(b.blockers[0])}）`).join('、')}</p>` : ''}
    ${rel.length ? `<p class="chip bad" style="display:block;padding:8px 10px;white-space:normal">
      <b>關係人疑慮：</b>${rel.map((x) => `${x.vendors.map((v) => esc(v.name)).join(' / ')} 共用同一組${esc(x.label)}`).join('；')}。
      這是事實比對不是指控 —— 但若這幾家一起比過價，比價結果需要重新檢視。</p>` : ''}`;
}

/* ── 廠商主檔 ── */

function openVendors() {
  const vs = state.vendors.map(VD.normalize);
  const rel = VD.relatedParties(state.vendors);
  const conc = VD.concentration(state.pos.filter((x) => x.status !== 'cancelled')
    .map((x) => ({ vendor: x.vendor, amount: x.subtotal })));
  const rows = vs.map((v) => {
    const bad = VD.eligibility(v);
    return `<tr class="${bad.length ? 'overdue' : ''}">
      <td>${esc(v.name)}${v.demo ? ' <span class="chip warn">示範</span>' : ''}<div class="hint">${esc(v.code)}${v.taxId ? ' · ' + esc(v.taxId) : ''}</div></td>
      <td class="hint">${esc(v.categories.join('、') || '—')}</td>
      <td class="n">${v.onTimeRate == null ? '—' : (v.onTimeRate * 100).toFixed(0) + '%'}</td>
      <td class="n">${v.defectRate == null ? '—' : (v.defectRate * 100).toFixed(1) + '%'}</td>
      <td class="n">${v.priceIndex == null ? '—' : v.priceIndex.toFixed(2)}</td>
      <td class="n">${v.leadDays == null ? '—' : v.leadDays + ' 天'}</td>
      <td>${bad.length ? `<span class="chip bad">${esc(bad[0])}</span>` : `<span class="chip ok">${esc(VD.STATUS[v.status].label)}</span>`}</td>
    </tr>`;
  }).join('');

  dialog('廠商主檔', `
    ${vs.length ? '' : `<p class="chip warn" style="display:block;padding:9px 11px;white-space:normal">
      主檔是空的。<b>沒有歷史數字的「建議廠商」只是憑空排名</b> ——
      交期達成率、不良率、報價指數這三欄才是分數的來源。</p>`}
    ${vs.some((v) => v.demo) ? `<p class="chip warn" style="display:block;padding:8px 10px;white-space:normal">
      目前載入的是<b>示範資料，全部虛構</b>，統編與聯絡方式都是填充值。
      請匯入貴公司的真實廠商資料後再據以發包。</p>` : ''}
    ${vs.length ? `<div style="max-height:40vh;overflow:auto">
      <table class="mkt"><thead><tr><th>廠商</th><th>承作品類</th><th class="n">交期達成</th>
        <th class="n">不良率</th><th class="n">報價指數</th><th class="n">前置期</th><th>狀態</th></tr></thead>
        <tbody>${rows}</tbody></table></div>` : ''}

    ${rel.length ? `<h4 style="margin:14px 0 6px">關係人疑慮</h4>
      <table class="mat"><thead><tr><th>共用項目</th><th>廠商</th></tr></thead><tbody>
        ${rel.map((x) => `<tr class="overdue"><td>${esc(x.label)}</td>
          <td>${x.vendors.map((v) => esc(v.name)).join(' / ')}</td></tr>`).join('')}</tbody></table>
      <p class="hint" style="margin-top:6px"><b>這是事實比對，不是指控。</b>
        共用地址可能是同一棟商辦、共用電話可能是總機。工具只負責把它攤開 ——
        但如果三家報價裡有兩家其實是同一個人，比價本身就沒有意義了。</p>` : ''}

    ${conc.rows.length ? `<h4 style="margin:14px 0 6px">發包集中度</h4>
      <table class="mat"><thead><tr><th>廠商</th><th class="n">金額</th><th class="n">佔比</th></tr></thead><tbody>
        ${conc.rows.map((x) => `<tr class="${x.share > conc.warn ? 'overdue' : ''}"><td>${esc(x.vendor)}</td>
          <td class="n">NT$ ${Q.fmt(x.amount, 0)}</td><td class="n">${(x.share * 100).toFixed(1)}%</td></tr>`).join('')}</tbody></table>
      <p class="hint" style="margin-top:6px">HHI ${conc.hhi}（1 = 全部給同一家）。${esc(conc.note)}</p>` : ''}

    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">
      <button class="btn" id="vLoadDemo">載入示範資料</button>
      <button class="btn" id="vImport">匯入 JSON</button>
      <button class="btn" id="vExport">匯出 JSON</button>
      <button class="btn" id="vClear">清空主檔</button>
    </div>
    <p class="hint" style="margin-top:8px">匯入格式見 <code>public/data/vendors-demo.json</code> 的 <code>_fields</code> 說明。
      缺的欄位就是缺 —— 工具<b>不會</b>用平均值補，因為「沒有交期紀錄」本身就是一種資訊，
      不該讓沒紀錄的廠商白拿一個平均分。</p>`,
    [{ label: '關閉' }], (body, gen) => {
      const re = () => { dlgClose(gen); setTimeout(openVendors, 60); };
      body.querySelector('#vLoadDemo').onclick = async () => {
        try {
          const r = await fetch('./data/vendors-demo.json', { cache: 'no-store' });
          const d = await r.json();
          state.vendors = (d.vendors || []).map(VD.normalize);
          persist(); renderAll(); re();
        } catch (e) { dialog('載入失敗', `<p>${esc(e.message)}</p>`); }
      };
      body.querySelector('#vExport').onclick = () =>
        download(`vendors-${new Date().toISOString().slice(0, 10)}.json`,
          JSON.stringify({ vendors: state.vendors }, null, 2));
      body.querySelector('#vImport').onclick = () => { dlgClose(gen); $('#fileVendors').click(); };
      body.querySelector('#vClear').onclick = () => {
        if (!confirm('清空廠商主檔？已開立的發包單不受影響。')) return;
        state.vendors = []; persist(); renderAll(); re();
      };
    });
}

/* ── 發包單 ── */

function renderPos() {
  const host = $('#pos');
  $('#poCount').textContent = state.pos.length;
  if (!state.pos.length) {
    host.innerHTML = '<div class="hint" style="padding:9px 11px">尚無發包單。請購單產生後，可在請購單視窗按「轉發包單」。</div>';
    return;
  }
  host.innerHTML = state.pos.map((po) => {
    const st = PO.PO_STATUS[po.status] || PO.PO_STATUS.draft;
    const v = po.variance;
    return `<div class="bl"><header>
        <b>${esc(po.no)}</b><span class="chip ${po.status === 'cancelled' ? 'bad' : po.status === 'draft' ? 'warn' : 'ok'}">${esc(st.label)}</span>
        <span class="hint">${esc(po.vendor)}</span>
        <button class="btn sm" data-poview="${esc(po.no)}" style="margin-left:auto">檢視</button>
      </header>
      <div class="body">
        <div class="totrow"><span>${po.lines.length} 項 · 來源 ${esc(po.prNos.join('、'))}</span>
          <b>NT$ ${Q.fmt(po.total, 0)}</b></div>
        <div class="hint">議價差額 <b class="${v < 0 ? 'pos' : v > 0 ? 'neg' : ''}">${v === 0 ? '±0' : (v < 0 ? '' : '+') + 'NT$ ' + Q.fmt(v, 0)}</b>
          ${po.variancePct == null ? '' : `（${(po.variancePct * 100).toFixed(1)}%）`}
          ${po.deliveryDate ? ` · 交貨 ${esc(po.deliveryDate)}` : ''}</div>
      </div></div>`;
  }).join('');
}

/**
 * 請購單 → 發包單。
 *
 * 只列**還沒開滿**的明細 —— 已開滿的列出來只會讓人不小心再開一次。
 * 議定單價與估價分開存：覆蓋估價等於把「我估得準不準」這個資訊永久刪掉。
 */
function openCreatePo(prNo) {
  const pr = state.prs.find((x) => x.no === prNo);
  if (!pr) return;
  const open = PO.openLines(pr, state.pos);
  if (!open.length) {
    const f = PO.prFulfilment(pr, state.pos);
    return dialog('已全部開單', `<p>${esc(pr.no)} 的明細已經全部開出發包單（${esc(f.poNos.join('、'))}）。</p>`);
  }
  const cats = VD.categoriesOf(open.map((l) => state.itemByCode.get(l.code)).filter(Boolean));
  const amount = open.reduce((a, l) => a + (Q.isNum(l.unitPrice) ? l.remaining * l.unitPrice : 0), 0);
  const sug = VD.suggest(state.vendors, { code: pr.packageCode, categories: cats, amount, needDate: pr.needDate });
  const vendorOpts = state.vendors.map(VD.normalize)
    .map((v) => `<option value="${esc(v.code)}" ${sug.best === v.code ? 'selected' : ''}>${esc(v.name)}${VD.eligibility(v).length ? '（不符資格）' : ''}</option>`).join('');

  dialog(`轉發包單 — ${esc(pr.no)}`, `
    <p>可開立 <b>${open.length}</b> 項，估價金額 NT$ ${Q.fmt(amount, 0)}（未稅）。</p>
    <h4 style="margin:12px 0 6px">建議廠商</h4>
    ${vendorSuggestHtml(sug)}
    <div class="fgrid" style="margin-top:10px">
      <div><label class="f">廠商（必填）</label><select id="oVend"><option value="">— 請選擇 —</option>${vendorOpts}</select></div>
      <div><label class="f">發包人（必填）</label><input type="text" id="oBy" placeholder="姓名"></div>
      <div><label class="f">交貨日期</label><input type="date" id="oDate" value="${esc(pr.needDate || '')}"></div>
      <div><label class="f">交貨地點</label><input type="text" id="oTo" placeholder="工地／倉庫"></div>
      <div><label class="f">付款條件</label><input type="text" id="oPay" placeholder="留空則帶廠商主檔帳期"></div>
      <div><label class="f">逾期條款</label><input type="text" id="oPen" value="每日千分之一（合約第 ○ 條）"></div>
    </div>
    <h4 style="margin:14px 0 6px">明細（可改數量與議定單價）</h4>
    <div style="max-height:32vh;overflow:auto">
      <table class="mkt"><thead><tr><th>工項</th><th class="n">可開量</th><th class="n">本次數量</th>
        <th class="n">估價單價</th><th class="n">議定單價</th></tr></thead>
        <tbody>${open.map((l, i) => `<tr>
          <td>${esc(l.name)}<div class="hint">${esc(l.code)}${l.already ? ` · 已開 ${Q.fmt(l.already, 2)}` : ''}</div></td>
          <td class="n">${Q.fmt(l.remaining, 2)} ${esc(l.unit)}</td>
          <td class="n"><input type="number" class="num" data-oq="${i}" step="0.01" value="${l.remaining}" style="width:100px"></td>
          <td class="n hint">${Q.isNum(l.unitPrice) ? Q.fmt(l.unitPrice, 2) : '—'}</td>
          <td class="n"><input type="number" class="num" data-op="${i}" step="0.01" value="${Q.isNum(l.unitPrice) ? l.unitPrice : ''}" style="width:100px"></td>
        </tr>`).join('')}</tbody></table>
    </div>
    <p class="hint" style="margin-top:8px">議定單價會與估價單價<b>分開存</b>，兩者都留著才算得出議價差額 ——
      那是回饋「我估得準不準」的唯一數字。直接覆蓋估價，等於把它永久刪掉。</p>`,
    [{ label: '取消' }, {
      label: '建立發包單', primary: true, fn: () => {
        const vcode = $('#oVend').value;
        const vendor = state.vendors.map(VD.normalize).find((v) => v.code === vcode);
        if (!vendor) return setTimeout(() => dialog('缺廠商', '<p>發包單是對外契約，必須指定廠商。</p>'), 60);
        const lines = open.map((l, i) => ({
          code: l.code,
          qty: parseFloat($(`[data-oq="${i}"]`).value),
          unitPrice: parseFloat($(`[data-op="${i}"]`).value),
        })).filter((x) => Number.isFinite(x.qty) && x.qty > 0);
        const r = PO.createPo(pr, vendor, {
          by: $('#oBy').value.trim(), dept: state.settings.dept,
          deliveryDate: $('#oDate').value, deliveryTo: $('#oTo').value.trim(),
          paymentTerms: $('#oPay').value.trim(), penaltyClause: $('#oPen').value.trim(),
          lines, taxRate: pr.taxRate,
        }, state.pos);
        if (r.error) {
          return setTimeout(() => dialog('無法建立發包單', `<p>${esc(r.error)}</p>
            ${(r.rejected || []).length ? `<table class="mat"><thead><tr><th>工項</th><th>原因</th></tr></thead><tbody>
              ${r.rejected.map((x) => `<tr><td>${esc(x.code)}</td><td class="hint">${esc(x.why)}</td></tr>`).join('')}</tbody></table>` : ''}`), 60);
        }
        state.pos.push(r.po);
        renderAll(); persist();
        setTimeout(() => openPo(r.po.no), 80);
      },
    }]);
}

/** 檢視發包單，並在這裡做狀態變更與匯出。 */
function openPo(no) {
  const po = state.pos.find((x) => x.no === no);
  if (!po) return;
  const rel = VD.relatedParties(state.vendors).filter((x) => x.vendors.some((v) => v.code === po.vendorCode));
  const conc = VD.concentration(state.pos.filter((x) => x.status !== 'cancelled')
    .map((x) => ({ vendor: x.vendor, amount: x.subtotal })));
  const share = (conc.rows.find((x) => x.vendor === po.vendor) || {}).share;
  const issues = PO.poReadiness(po, { relatedParties: rel, share });
  const st = PO.PO_STATUS[po.status];

  dialog(`發包單 ${esc(po.no)}`, `
    <div class="hint">${esc(po.vendor)} · 來源 ${esc(po.prNos.join('、'))} · 發包人 ${esc(po.by)}
      ${po.deliveryDate ? ` · 交貨 ${esc(po.deliveryDate)}` : ''}</div>
    <div style="display:flex;gap:8px;margin:8px 0;flex-wrap:wrap">
      <span class="chip ${po.status === 'cancelled' ? 'bad' : po.status === 'draft' ? 'warn' : 'ok'}">${esc(st.label)}</span>
      ${po.paymentTerms ? `<span class="chip">${esc(po.paymentTerms)}</span>` : ''}
      ${po.penaltyClause ? `<span class="chip">${esc(po.penaltyClause)}</span>` : ''}
    </div>
    ${issues.length ? `<div style="margin:8px 0">${issues.map((x) => `<p class="chip ${x.level === 'bad' ? 'bad' : x.level === 'warn' ? 'warn' : ''}"
      style="display:block;padding:7px 10px;white-space:normal;margin:4px 0">${esc(x.msg)}</p>`).join('')}</div>` : ''}
    <table class="mkt"><thead><tr><th>工項</th><th class="n">數量</th><th class="n">估價單價</th>
      <th class="n">議定單價</th><th class="n">金額</th></tr></thead>
      <tbody>${po.lines.map((l) => `<tr><td>${esc(l.name)}<div class="hint">${esc(l.code)}</div></td>
        <td class="n">${Q.fmt(l.qty, 2)} ${esc(l.unit)}</td>
        <td class="n hint">${Q.isNum(l.estUnitPrice) ? Q.fmt(l.estUnitPrice, 2) : '—'}</td>
        <td class="n">${Q.isNum(l.unitPrice) ? Q.fmt(l.unitPrice, 2) : '<span class="chip bad">未議價</span>'}</td>
        <td class="n">${l.amount == null ? '—' : Q.fmt(l.amount, 0)}</td></tr>`).join('')}</tbody></table>
    <div class="totrow" style="margin-top:8px"><span>未稅</span><b>NT$ ${Q.fmt(po.subtotal, 0)}</b></div>
    <div class="totrow"><span>稅額（${(po.taxRate * 100).toFixed(0)}%）</span><b>NT$ ${Q.fmt(po.tax, 0)}</b></div>
    <div class="totrow"><span>含稅合計</span><b>NT$ ${Q.fmt(po.total, 0)}</b></div>
    <div class="totrow"><span>估價金額</span><b class="hint">NT$ ${Q.fmt(po.estSubtotal, 0)}</b></div>
    <div class="totrow"><span>議價差額</span><b class="${po.variance < 0 ? 'pos' : po.variance > 0 ? 'neg' : ''}">
      ${po.variance === 0 ? '±0' : (po.variance < 0 ? '' : '+') + 'NT$ ' + Q.fmt(po.variance, 0)}
      ${po.variancePct == null ? '' : `（${(po.variancePct * 100).toFixed(1)}%）`}</b></div>
    ${po.history && po.history.length ? `<h4 style="margin:14px 0 6px">狀態歷程</h4>
      <ul class="hist">${po.history.map((h) => `<li>${esc(String(h.at).slice(0, 16).replace('T', ' '))}
        ${esc(PO.PO_STATUS[h.from] ? PO.PO_STATUS[h.from].label : h.from)} → ${esc(PO.PO_STATUS[h.to] ? PO.PO_STATUS[h.to].label : h.to)}
        ${h.by ? ' · ' + esc(h.by) : ''}</li>`).join('')}</ul>` : ''}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
      ${['issued', 'acked', 'closed'].filter((k) => k !== po.status).map((k) =>
        `<button class="btn sm" data-post="${k}">標記為${esc(PO.PO_STATUS[k].label)}</button>`).join('')}
      ${po.status === 'cancelled' ? '' : '<button class="btn sm" data-post="cancelled">取消</button>'}
    </div>
    <p class="hint" style="margin-top:8px">狀態只能往前走，不能倒退 ——
      已發出的契約文件不能偷偷改內容，要改請取消後重開。</p>`,
    [{ label: '關閉' }, { label: '匯出 Excel', fn: () => exportPo(po) }],
    (body, gen) => {
      body.querySelectorAll('[data-post]').forEach((b) => {
        b.onclick = () => {
          const r = PO.setStatus(po, b.dataset.post, prompt('操作人姓名？', '') || '');
          if (r.error) return setTimeout(() => dialog('狀態不可變更', `<p>${esc(r.error)}</p>`), 60);
          state.pos = state.pos.map((x) => (x.no === po.no ? r.po : x));
          renderAll(); persist();
          dlgClose(gen); setTimeout(() => openPo(po.no), 60);
        };
      });
    });
}

function exportPo(po) {
  const head = [['發包單號', po.no], ['狀態', (PO.PO_STATUS[po.status] || {}).label || po.status],
    ['廠商', po.vendor], ['統一編號', po.vendorTaxId], ['來源請購單', po.prNos.join('、')],
    ['採購包', `${po.packageCode} ${po.packageName}`], ['發包人', po.by], ['部門', po.dept],
    ['交貨日期', po.deliveryDate], ['交貨地點', po.deliveryTo],
    ['付款條件', po.paymentTerms], ['逾期條款', po.penaltyClause], [],
    ['未稅金額', po.subtotal], ['稅率', po.taxRate], ['稅額', po.tax], ['含稅合計', po.total],
    ['估價金額', po.estSubtotal], ['議價差額', po.variance],
    ['議價差額比例', po.variancePct == null ? '' : po.variancePct]];
  const lines = [['工項代碼', 'ERP 料號', '名稱', '規格', '單位', '數量', '估價單價', '議定單價', '金額', '圖號', '來源 PR'],
    ...po.lines.map((l) => [l.code, l.erpCode, l.name, l.spec, l.unit, l.qty,
      l.estUnitPrice ?? '', l.unitPrice ?? '', l.amount ?? '', l.sheetNo || '', l.prNo])];
  exportExcel(`發包單-${po.no}`, [{ name: '表頭', rows: head }, { name: '明細', rows: lines }]);
}

/* ══════════ 投標價組成 ══════════ */

/**
 * 價格風險的預設三點估計，刻意不對稱。
 * 使用者說真正吃虧的是「發包時報價比估價高」—— 向上的尾巴本來就比向下長。
 */
const PRICE_DIST = { min: -0.02, mode: 0, max: 0.08 };

/**
 * 直接成本 → 投標總價。
 *
 * 這個視窗存在的理由：清單右下角那個「預估金額」是**採購成本**，
 * 旁邊原本沒有一個字說明它是什麼。拿它去投標，等於用 0% 間接費、
 * 0% 利潤、0% 風險準備的價格投 —— 數字完全合理，只是少了三層。
 */
function openBid() {
  const list = selectedItems().length ? selectedItems() : state.items;
  const sum = Q.summarize(pricedAll(list), state.settings);
  const st = state.settings;

  // 風險準備金：從模擬推導，不是拍一個百分比
  let sim = null, reserve = { amount: 0 };
  try {
    sim = R.simulatePortfolio(pricedAll(list), st);   // 開關就在 st.priceDist 本身
    if (sim) reserve = BD.riskReserve(sim, st.reserveLevel);
  } catch (e) { console.warn('模擬失敗', e); }

  // 漏項保留：已知幾何量 × 同類工項均價
  const sf = BD.shortfallReserve(state.missed, state.items);

  const r = BD.buildUp(sum.cost, {
    markups: st.markups, taxRate: st.taxRate,
    reserve: reserve.amount, shortfall: sf.amount,
  });
  if (r.error) return dialog('無法組價', `<p>${esc(r.error)}</p>`);

  const profit = (r.lines.find((x) => x.key === 'profit') || {}).amount || 0;
  const be = BD.breakEvenDelayDays(r.total, profit, st.delayDailyRate);
  const scen = BD.delayScenarios(r.total, profit, st.delayDailyRate, [7, 14, 30, 60]);

  const money = (v) => `NT$ ${Q.fmt(v, 0)}`;
  const rows = r.lines.map((x) => {
    const basis = x.basis === 'price' ? `<span class="chip warn">佔標價 ${(x.rate * 100).toFixed(1)}%</span>`
      : x.basis === 'cost' ? `<span class="chip">成本 ×${(x.rate * 100).toFixed(1)}%</span>` : '';
    return `<tr><td>${esc(x.label)} ${basis}</td>
      <td class="n hint">${x.base != null ? money(x.base) : ''}</td>
      <td class="n"><b>${money(x.amount)}</b></td>
      <td class="hint">${esc(x.note || '')}</td></tr>`;
  }).join('');

  dialog('投標價組成', `
    <p class="chip warn" style="display:block;padding:9px 11px;white-space:normal">
      清單上的「預估金額」是<b>採購成本</b>，不是承包價 ——
      未稅、無管理費、無利潤、無風險準備。這個視窗補上中間那三層。</p>

    <table class="mkt" style="margin:10px 0">
      <thead><tr><th>項目</th><th class="n">計算基數</th><th class="n">金額</th><th>說明</th></tr></thead>
      <tbody>${rows}
        <tr style="border-top:2px solid var(--line)"><td><b>未稅標價</b></td><td></td>
          <td class="n"><b>${money(r.preTax)}</b></td>
          <td class="hint">為直接成本的 ${((r.markupOnDirect || 0) * 100).toFixed(1)}% 加成</td></tr>
        <tr><td>營業稅 ${(r.taxRate * 100).toFixed(0)}%</td><td></td><td class="n">${money(r.tax)}</td><td></td></tr>
        <tr class="on"><td><b>投標總價</b></td><td></td><td class="n"><b>${money(r.total)}</b></td><td></td></tr>
      </tbody></table>

    <p class="hint"><b>「佔標價」與「成本加成」是兩種不同的數學。</b>
      規費是「佔合約價 1%」，必須用除的：P = 基數 ÷ (1 − 1%)。
      用乘的（基數 × 1%）在 10 億的案子上會少算約 100 萬，而且帳面上看不出來。</p>

    <h4 style="margin:14px 0 6px">風險準備金</h4>
    ${reserve.error ? `<p class="chip warn" style="display:block;padding:8px 10px">${esc(reserve.error)}</p>`
      : `<p>取 <b>${esc(reserve.atLabel || '')}</b>（${money(reserve.at)}）減 P50（${money(reserve.base)}）
        ＝ <b>${money(reserve.amount)}</b>。</p>
      <p class="hint">${esc(reserve.note || '')}</p>`}
    <div class="fgrid" style="margin-top:8px">
      <div><label class="f">準備金服務水準</label><select id="bLevel">
        ${[['0.5', 'P50（不編列）'], ['0.8', 'P80'], ['0.9', 'P90'], ['0.95', 'P95']].map(([v, l]) =>
          `<option value="${v}" ${String(st.reserveLevel) === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select></div>
      <div><label class="f">價格風險（發包時報價比估價高）</label><select id="bPrisk">
        <option value="0" ${st.priceDist ? '' : 'selected'}>關閉（單價視為定值）</option>
        <option value="1" ${st.priceDist ? 'selected' : ''}>開啟（−2% / 0 / +8%）</option>
      </select></div>
    </div>
    ${st.priceDist ? '' : `<p class="chip warn" style="display:block;padding:8px 10px;margin-top:8px;white-space:normal">
      價格風險目前<b>關閉</b>，所以這個準備金只涵蓋<b>數量</b>會用超的風險。
      你說真正吃虧的是「發包時報價比估價高」—— 那一段現在沒有被算進去。</p>`}

    <h4 style="margin:14px 0 6px">漏項保留</h4>
    ${sf.rows.length ? `<table class="mat"><thead><tr><th>圖層</th><th class="n">數量</th><th class="n">金額</th><th>依據</th></tr></thead>
        <tbody>${sf.rows.map((x) => `<tr><td>${esc(x.layer)}</td>
          <td class="n">${x.qty != null ? Q.fmt(x.qty, 2) + ' ' + esc(x.unit || '') : '—'}</td>
          <td class="n">${x.amount ? money(x.amount) : '—'}</td>
          <td class="hint">${esc(x.why)}</td></tr>`).join('')}</tbody></table>
      <p class="hint" style="margin-top:6px">${esc(sf.note)}</p>`
      : '<p class="hint">目前沒有被擋下的漏項。跑過「圖層自動抓量」之後，被擋下的圖層會在這裡估列金額。</p>'}

    <h4 style="margin:14px 0 6px">逾期罰款（每日 ${(st.delayDailyRate * 1000).toFixed(1)}‰）</h4>
    <table class="mat"><thead><tr><th class="n">延誤</th><th class="n">罰款</th><th>吃掉利潤</th></tr></thead>
      <tbody>${scen.map((x) => `<tr class="${x.wipesOutProfit ? 'overdue' : ''}">
        <td class="n">${x.days} 天</td><td class="n">${money(x.penalty)}</td>
        <td>${x.profitEaten == null ? '—' : (x.profitEaten * 100).toFixed(1) + '%'}
          ${x.wipesOutProfit ? '<span class="chip bad">已轉為虧損</span>' : ''}</td></tr>`).join('')}</tbody></table>
    ${be ? `<p class="hint" style="margin-top:6px"><b>延誤 ${be} 天，罰款就吃光全部利潤。</b>
      這是情境不是預測 —— 工具算得出要徑與浮時，但算不出你會不會延誤。</p>` : ''}

    <h4 style="margin:14px 0 6px">加成費率</h4>
    <div class="fgrid">
      ${st.markups.map((m, i) => `<div><label class="f">${esc(m.label)}（${m.basis === 'price' ? '佔標價' : '成本加成'}）</label>
        <input type="number" step="0.1" min="0" data-mk="${i}" value="${(m.rate * 100).toFixed(2)}"></div>`).join('')}
    </div>
    <p class="hint" style="margin-top:8px">這些費率是<b>你們的商業決定</b>，工具不會替你決定。
      它能做的是把直接成本算準，並把每一層攤開來看得見。</p>`,
    [{ label: '關閉' }, { label: '匯出 Excel', fn: () => exportBid(r, reserve, sf, scen, be) }],
    (body, gen) => {
      const reopen = () => { dlgClose(gen); setTimeout(openBid, 60); };
      body.querySelector('#bLevel').onchange = (e) => {
        st.reserveLevel = parseFloat(e.target.value); persist(); reopen();
      };
      body.querySelector('#bPrisk').onchange = (e) => {
        st.priceDist = e.target.value === '1' ? { ...PRICE_DIST } : null;
        persist(); reopen();
      };
      body.querySelectorAll('[data-mk]').forEach((el) => {
        el.onchange = () => {
          const v = parseFloat(el.value);
          if (Number.isFinite(v) && v >= 0) { st.markups[+el.dataset.mk].rate = v / 100; persist(); reopen(); }
        };
      });
    });
}

/** 投標價組成匯出 —— 三張工作表：組成、漏項、延誤情境。 */
function exportBid(r, reserve, sf, scen, be) {
  const comp = [['項目', '基礎', '費率', '計算基數', '金額']];
  for (const x of r.lines) {
    comp.push([x.label, x.basis === 'price' ? '佔標價' : x.basis === 'cost' ? '成本加成' : '—',
      x.rate != null ? x.rate : '', x.base != null ? x.base : '', x.amount]);
  }
  comp.push([], ['未稅標價', '', '', '', r.preTax], [`營業稅 ${(r.taxRate * 100).toFixed(0)}%`, '', '', '', r.tax],
    ['投標總價', '', '', '', r.total], [],
    ['風險準備金依據', reserve.error || `${reserve.atLabel} ${reserve.at} − P50 ${reserve.base}`],
    ['損益兩平延誤天數', be == null ? '無法計算' : be]);
  const sheets = [{ name: '投標價組成', rows: comp }];
  if (sf.rows.length) {
    sheets.push({ name: '漏項保留', rows: [['圖層', '數量', '單位', '同類均價', '金額', '依據'],
      ...sf.rows.map((x) => [x.layer, x.qty ?? '', x.unit || '', x.avgPrice ?? '', x.amount, x.why])] });
  }
  sheets.push({ name: '延誤情境', rows: [['延誤天數', '罰款', '吃掉利潤比例', '是否轉虧'],
    ...scen.map((x) => [x.days, x.penalty, x.profitEaten ?? '', x.wipesOutProfit ? '是' : '否'])] });
  exportExcel('投標價組成', sheets);
}

/* ══════════ 重複描繪 ══════════ */

/**
 * 重複描繪偵測的容差，換算成圖檔單位的 1mm。
 * 圖檔沒有單位時退回用圖幅對角線的百萬分之一 —— 不能用絕對值，
 * 因為圖檔單位可能是公尺也可能是公厘，差了一千倍。
 */
function dupeTol(v) {
  if (v.metersPerUnit) return 0.001 / v.metersPerUnit;
  const b = v.bounds;
  const diag = Math.hypot((b.maxX - b.minX) || 1, (b.maxY - b.minY) || 1);
  return diag * 1e-6;
}

/**
 * 跑一次重複描繪分析並更新工具列的晶片。
 *
 * 這件事排在所有自動化之前，理由使用者講得比我清楚：
 * 對應猜錯了數字會不合理而被發現，重複描繪不會 ——
 * 它給你一個完全合理、但是錯一倍的數字。
 */
function runDupe() {
  const v = state.viewer;
  state.dupe = (v.mode === 'dxf' && v.doc) ? DD.analyze(v.flat, { tol: dupeTol(v) }) : null;
  // 標註比對跟重複描繪一樣，是載入當下就該算的 —— 兩者都是「這張圖能不能信」的前提
  state.dims = (v.mode === 'dxf' && v.doc) ? VF.checkDimensions(v.flat) : null;
  renderDupeChip();
  renderVerifyChip();
}

function renderDupeChip() {
  const el = $('#dupChip');
  if (!el) return;
  const d = state.dupe;
  if (!d) { el.hidden = true; return; }
  el.hidden = false;
  el.style.cursor = 'pointer';
  if (d.clean) { el.className = 'chip ok'; el.textContent = '無重複描繪'; return; }
  const bad = d.layers.filter((g) => DD.severity(g) === 'bad').length;
  el.className = 'chip ' + (bad ? 'bad' : 'warn');
  const toM = state.viewer.metersPerUnit;
  el.textContent = `重複 ${toM ? Q.fmt(d.totals.duplicated * toM, 1) + ' M' : Q.fmt(d.totals.duplicated, 1)}`
    + (d.totals.dupInserts ? ` · ${d.totals.dupInserts} 圖塊` : '');
}

/** 逐圖層攤開重複描繪的細節。 */
function openDupe() {
  const d = state.dupe;
  if (!d) return dialog('尚未載入向量圖', '<p>重複描繪偵測需要 DXF／DWG 幾何。</p>');
  const toM = state.viewer.metersPerUnit;
  const L = (x) => (toM ? `${Q.fmt(x * toM, 2)} M` : Q.fmt(x, 1));
  const dirty = d.layers.filter((g) => DD.severity(g) !== 'ok');
  const rows = dirty.map((g) => {
    const sv = DD.severity(g);
    return `<tr class="${sv === 'bad' ? 'overdue' : 'urgent'}">
      <td>${esc(g.layer)}</td>
      <td class="n">${L(g.total)}</td>
      <td class="n">${L(g.duplicated)}</td>
      <td class="n">${(g.ratio * 100).toFixed(1)}%</td>
      <td class="n">${g.dupInserts || '—'}</td>
      <td><span class="chip ${sv === 'bad' ? 'bad' : 'warn'}">${sv === 'bad' ? '擋下' : '注意'}</span></td>
    </tr>`;
  }).join('');
  dialog('重複描繪偵測', `
    <p>容差 <b>${Q.fmt(d.tol, 4)}</b> 圖檔單位${toM ? `（≈ ${Q.fmt(d.tol * toM * 1000, 2)} mm）` : ''}。
    「重複長度」＝ 總長 − 聯集長度：同一條直線上的線段投影成一維區間後取聯集，
    差額就是被算了兩次以上的長度。這個定義不需要判斷「兩條線是不是同一條」，只需要幾何。</p>
    ${d.clean ? '<p class="chip ok" style="display:block;padding:9px 11px">這張圖沒有偵測到重複描繪。</p>' : `
    <table class="mat"><thead><tr><th>圖層</th><th class="n">總長</th><th class="n">重複長度</th>
      <th class="n">佔比</th><th class="n">重疊圖塊</th><th>處置</th></tr></thead>
      <tbody>${rows}</tbody></table>
    <p class="hint" style="margin-top:8px">全圖合計重複 <b>${L(d.totals.duplicated)}</b>
      （總長 ${L(d.totals.total)} 的 ${(d.totals.ratio * 100).toFixed(1)}%）
      ${d.totals.dupInserts ? `、<b>${d.totals.dupInserts}</b> 個圖塊重疊插入` : ''}
      ${d.totals.degenerate ? `、${d.totals.degenerate} 條零長度線` : ''}。</p>`}
    <p class="hint"><b>「擋下」的圖層不會被自動抓量寫入。</b>
    長度灌水 2% 以上、或有任何圖塊重疊插入，都算擋下 ——
    圖塊重疊一個都不能放過，因為那是計數工項，多一個就是採購單上多一個。
    請回 CAD 用 OVERKILL／清除重複物件處理後重新匯出，或改用量測工具逐段量。</p>`);
}

/* ══════════ 圖面版本與量測歸屬 ══════════ */

/**
 * 檔案內容簽章 —— 用來回答一個問題：「這張圖跟上次載的那張，是不是同一版？」
 *
 * 不是為了防竄改，所以不需要密碼學雜湊。取頭尾各 64KB 加檔案大小做 FNV-1a，
 * 對「同一個檔名的新舊版」這件事已經足夠，而且再大的 DWG 也只花幾毫秒。
 * 全檔雜湊對 50MB 的圖檔會卡住畫面，那個代價換不到對應的準確度。
 */
function fileSig(buf) {
  const all = new Uint8Array(buf);
  const n = all.length;
  const head = all.subarray(0, Math.min(65536, n));
  const tail = all.subarray(Math.max(0, n - 65536));
  let h = 0x811c9dc5;
  const mix = (arr) => {
    for (let i = 0; i < arr.length; i++) { h ^= arr[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  };
  mix(head); mix(tail);
  h ^= n; h = Math.imul(h, 0x01000193) >>> 0;
  return `${n.toString(36)}-${h.toString(36)}`;
}

/** 量測歸屬的鍵：同一張圖的同一頁、同一版，才是同一組量測。 */
function measureKeyOf(name, sig, page) { return `${name}@${sig}#${page || 1}`; }

/**
 * 切換量測情境。
 *
 * 量測的座標只在「畫它的那張圖」上有意義 —— 換了圖還留著，畫面上會出現一條
 * 位置完全不對的線，而且會用新圖的比例去換算舊圖的長度，算出一個看起來正常的假數字。
 * 所以不是共用一份清單，而是依圖分開存：換圖時把現有的收起來、把該圖的拿出來。
 * 收起來而不是刪掉 —— 切回同一張圖時量測要還在，不然這個保護就變成懲罰。
 */
function switchMeasureContext(key) {
  const v = state.viewer;
  if (state.measureKey === key) return;
  if (state.measureKey) state.measureStore[state.measureKey] = v.measurements;
  v.measurements = state.measureStore[key] || [];
  state.measureKey = key;
  v.render();
  renderMeasureList();
}

/**
 * 一張圖現在該用的圖號。
 *
 * 人工指定的存在 `state.sheetNos`（以檔名為鍵，會存檔），永遠優先；
 * 沒指定時才由檔名推。推不出來就回 null —— 這裡刻意不退回檔名充數。
 */
function sheetNoFor(name) {
  if (!name) return null;
  return SH.sheetNoOf({ name, sheetNo: state.sheetNos[name] });
}

/** 目前載入這張圖的圖號。 */
function curSheetNo() {
  return state.drawing ? sheetNoFor(state.drawing.name) : null;
}

/**
 * 一筆出處該顯示的圖號。
 *
 * 先查**現在**的對照表，再退回出處當時記下的值 ——
 * 順序是刻意的：使用者常常是先抓完量、看到圖號欄空白才回頭去填。
 * 若只認寫入當下記的值，那次補填就只會影響之後抓的量，
 * 已經在清單上的幾十列永遠是空的，等於這個欄位沒用。
 */
function provSheet(prov) {
  if (!prov) return '';
  const live = prov.drawing ? (state.sheetNos[prov.drawing] || '').trim() : '';
  return live || SH.sheetCell(prov);
}

/**
 * 把目前的圖號對照表寫回每一筆出處紀錄。
 *
 * 下游（基準版快照、請購單、發包單）讀的是 `provenance.sheetNo`，不是這張對照表 ——
 * 那些是凍結過的文件，必須自己帶著當時的值，不能事後被改。
 * 所以編輯圖號的當下就把值推下去，之後凍結的東西才帶得到正確的圖號；
 * 已經凍結的則維持原樣，這是對的。
 */
function syncProvSheets() {
  for (const it of state.items) {
    if (!it.provenance || !it.provenance.drawing) continue;
    const no = provSheet(it.provenance);
    if (no) it.provenance.sheetNo = no;
  }
}

/**
 * 登記這次載入的圖，並回報它是不是同一張圖的新版本。
 *
 * 同名不同內容 = 圖改版了。這是判斷「清單裡那些圖面量是不是過期」的唯一可靠訊號 ——
 * 用「目前載的圖 ≠ 數量的出處圖」去判斷是錯的：一個案子本來就有電氣圖、給排水圖、
 * 空調圖好幾張，載了給排水圖不代表電氣的量過期。那樣判會整片誤報，
 * 而誤報的警告比沒有警告更糟：人會學會忽略它。
 */
function registerDrawing(name, sig) {
  const prev = state.drawingSigs[name];
  state.drawingSigs[name] = sig;
  if (!prev || prev === sig) return { revised: false, affected: [] };
  const affected = state.items.filter((it) => it.provenance && it.provenance.drawing === name
    && Q.isNum(it.qty.drawing));
  affected.forEach((it) => { it.drawingStale = true; });
  renderAll();
  return { revised: true, affected };
}

/**
 * 已經被「承諾出去」的工項代碼 —— 進過基準版、或已經開了請購單的。
 *
 * 這些數字不是草稿了：基準版是凍結過的版本，請購單可能已經寄給廠商。
 * 自動清除可以清工作中的數字，但不能清這些 —— 那等於在使用者不知情時
 * 讓已發出的文件與清單對不起來。所以自動清除一律跳過它們，並且明講跳過了幾筆。
 */
function committedCodes() {
  const set = new Set();
  for (const bl of state.baselines) for (const it of bl.items || []) if (it.code) set.add(it.code);
  for (const pr of state.prs) for (const ln of pr.lines || []) if (ln.code) set.add(ln.code);
  return set;
}

/**
 * 換圖時自動清除圖面量。預設關閉。
 *
 * 開這個功能的前提是「一張圖量完就走，下一張重來」的作業方式。
 * 若一個案子是多張圖各自貢獻不同工項的量（電氣圖、給排水圖、空調圖），
 * 開「全部」會把上一張圖辛苦量的結果一起清掉 —— 所以預設是不清，
 * 而且「只清上一張圖產生的」永遠比「全部」安全。
 */
function autoClearOnDrawingChange(prevName) {
  const mode = state.settings.clearOnDrawingChange || 'prev';
  if (mode === 'keep') return null;
  const all = state.items.filter((it) => Q.isNum(it.qty.drawing));
  const targets = mode === 'all' ? all
    : all.filter((it) => it.provenance && it.provenance.drawing === prevName);
  if (!targets.length) return null;
  const locked = committedCodes();
  const clear = targets.filter((it) => !locked.has(it.code));
  const kept = targets.filter((it) => locked.has(it.code));
  for (const it of clear) {
    it.qty.drawing = null;
    it.provenance = null;
    it.drawingSource = null;
    it.layerMapped = false;
    it.calibration = null;
    it.calibrationRms = null;
    it.drawingStale = false;
  }
  renderAll();
  return { mode, cleared: clear.length, kept };
}

/** 自動清除跑完之後講一次 —— 自動歸自動，但不可以無聲無息。 */
function announceAutoClear(r, prevName) {
  const modeLabel = r.mode === 'all' ? '全部圖面量' : `上一張圖（${prevName || '—'}）產生的圖面量`;
  setTimeout(() => dialog('已自動清除圖面量', `
    <p>依「參數 → 換圖時的圖面量」設定（<b>${esc(modeLabel)}</b>），
    已清除 <b>${r.cleared}</b> 筆工項的圖面量。</p>
    ${r.kept.length ? `<p class="chip warn" style="display:block;padding:8px 10px;white-space:normal">
      另有 <b>${r.kept.length}</b> 筆<b>沒有</b>清除，因為它們已經凍結進基準版或已開立請購單：
      ${esc(r.kept.slice(0, 8).map((it) => it.code).join('、'))}${r.kept.length > 8 ? ' …' : ''}。
      已經發出去的文件不可以在你不知情的時候跟清單對不起來 —— 要改請走基準版的修訂流程。</p>` : ''}
    <p class="hint">BOQ 量、人工確認量、計算式量都沒有動，清掉的只有從圖面算出來的那一條來源。
    不想每次都清，到「參數 → 換圖時的圖面量」改回「保留」。</p>`), 140);
}

/** 圖面量重新寫入時，過期標記就該消失 —— 這筆已經是新版圖來的了。 */
function freshDrawingQty(it) { it.drawingStale = false; }

/** 改版後跳一次，把受影響的工項攤開講清楚，並讓使用者決定清或留。 */
function announceRevision(name, affected) {
  const rows = affected.map((it) => `<tr><td>${esc(it.code)}</td><td>${esc(it.name)}</td>
    <td class="n">${Q.fmt(it.qty.drawing, 2)} ${esc(it.unit)}</td>
    <td class="hint">${esc(sourceNote(it, 'drawing'))}</td></tr>`).join('');
  setTimeout(() => dialog('這張圖改版了', `
    <p><b>${esc(name)}</b> 的內容與上次載入時不同 —— 同一個檔名，不同的圖。</p>
    <p>下面 <b>${affected.length}</b> 筆工項的圖面量是<b>上一版</b>算出來的，現在已標成「舊版」：</p>
    <table class="mkt"><thead><tr><th>代碼</th><th>名稱</th><th class="n">圖面量</th><th>出處</th></tr></thead>
      <tbody>${rows}</tbody></table>
    <p class="hint"><b>這些數字不會自動清掉。</b>它們可能已經進了基準版、已經發包，
    自動刪除等於在你不知情的時候丟掉工作成果 —— 那比留著更危險。
    這裡只負責讓它變得看得見，清或留由你決定。</p>`,
    [{ label: '保留，我自己核對' },
      { label: `清除這 ${affected.length} 筆圖面量`, primary: true, fn: () => clearDrawingQty(affected, '圖面改版') }]), 120);
}

/** 清掉一批工項的圖面量與其出處。只動圖面量，不碰 BOQ 量與人工確認量。 */
function clearDrawingQty(items, why) {
  let n = 0;
  for (const it of items) {
    if (!Q.isNum(it.qty.drawing)) continue;
    it.qty.drawing = null;
    it.provenance = null;
    it.drawingSource = null;
    it.layerMapped = false;
    it.calibration = null;
    it.calibrationRms = null;
    it.drawingStale = false;
    n++;
  }
  renderAll(); persist();
  setTimeout(() => dialog('已清除圖面量', `<p>已清除 <b>${n}</b> 筆工項的圖面量（原因：${esc(why)}）。</p>
    <p class="hint">BOQ 量、人工確認量、計算式量都沒有動 —— 清除的只有從圖面算出來的那一條來源。
    正式採購基準會自動退回下一個可用的來源，請回清單確認每一列的「正式採購基準」欄。</p>`), 80);
}

/** 目前這張圖有幾筆量測、有幾筆圖面量標成舊版 —— 任何清除動作都要先講清楚會清掉什麼。 */
function drawingScopeCounts() {
  const name = state.drawing ? state.drawing.name : '';
  const fromThis = state.items.filter((it) => it.provenance && it.provenance.drawing === name
    && Q.isNum(it.qty.drawing));
  const stale = state.items.filter((it) => it.drawingStale && Q.isNum(it.qty.drawing));
  const stored = Object.entries(state.measureStore)
    .reduce((a, [k, v]) => a + (k === state.measureKey ? 0 : v.length), 0);
  return { name, fromThis, stale, here: state.viewer.measurements.length, stored };
}

/**
 * 清除／卸載。刻意分層，不做成一顆「全部清掉」——
 * 使用者要的是「換一張圖繼續用」，不是「回到出廠設定」。
 * 每一項都標出會影響幾筆，沒有一個動作是閉著眼睛按的。
 */
function openDrawingReset() {
  const c = drawingScopeCounts();
  const row = (id, label, note, n, danger) => `
    <div style="display:flex;gap:10px;align-items:flex-start;padding:9px 0;border-top:1px solid var(--line2)">
      <div style="flex:1;min-width:0"><b>${label}</b><div class="hint">${note}</div></div>
      <button class="btn ${danger ? '' : 'sm'}" id="${id}" ${n === 0 ? 'disabled' : ''}
        style="flex:none">${n === 0 ? '無可清除' : `清除 ${n} 筆`}</button>
    </div>`;
  dialog('清除 / 更新圖面', `
    <p>目前載入：<b>${c.name ? esc(c.name) : '未載入圖面'}</b>${state.drawing && state.drawing.pageNo ? `　第 ${state.drawing.pageNo} 頁` : ''}</p>
    <p class="hint">要換一張圖，直接按工具列的「載入圖面」即可 —— 量測會自動依圖分開，
    不會把上一張的量測留在新圖上。下面這些是要「主動丟掉」東西時才用的。</p>
    ${row('drClearMeas', '本圖量測', `這一張圖（這一頁）上畫的量測。其他圖的 ${c.stored} 筆不受影響。`, c.here)}
    ${row('drClearStale', '標成「舊版」的圖面量', '圖改版後留下來的舊數字。清掉之後正式採購基準會退回下一個可用來源。', c.stale.length)}
    ${row('drClearThis', '本圖產生的所有圖面量', `出處是《${esc(c.name || '—')}》的圖面量，不分新舊。`, c.fromThis.length)}
    <div style="display:flex;gap:10px;align-items:flex-start;padding:9px 0;border-top:1px solid var(--line2)">
      <div style="flex:1;min-width:0"><b>卸載圖面</b><div class="hint">把畫面清空回到未載入狀態。量測依圖保存著，重新載入同一張圖就會回來。</div></div>
      <button class="btn sm" id="drUnload" ${state.drawing ? '' : 'disabled'} style="flex:none">卸載</button>
    </div>
    <p class="hint" style="margin-top:12px"><b>這裡不會動到</b> BOQ 量、人工確認量、計算式量、採購包、基準版與請購單。
    要把整個專案清回範本狀態，在「參數」最下面有另一顆鍵 —— 那一顆會連已發出的請購單一起清掉。</p>`,
    [{ label: '關閉' }], (body, gen) => {
      const act = (id, fn) => { const b = body.querySelector(id); if (b && !b.disabled) b.onclick = () => { dlgClose(gen); setTimeout(fn, 60); }; };
      act('#drClearMeas', () => {
        const n = state.viewer.measurements.length;
        state.viewer.clearMeasurements();
        state.measureStore[state.measureKey] = [];
        renderMeasureList(); persist();
        dialog('已清除量測', `<p>已清除本圖的 <b>${n}</b> 筆量測。</p>
          <p class="hint">已經寫進工項的圖面量<b>不會</b>跟著消失 —— 那是兩件事。
          要一起清掉，回到這個視窗選「本圖產生的所有圖面量」。</p>`);
      });
      act('#drClearStale', () => clearDrawingQty(c.stale, '使用者清除舊版圖面量'));
      act('#drClearThis', () => clearDrawingQty(c.fromThis, `清除《${c.name}》的圖面量`));
      act('#drUnload', unloadDrawing);
    });
}

/** 卸載圖面：畫面回到未載入狀態，但量測依圖收好，重新載入就回來。 */
function unloadDrawing() {
  const v = state.viewer;
  if (state.measureKey) state.measureStore[state.measureKey] = v.measurements;
  state.measureKey = '';
  v.measurements = [];
  v.mode = null; v.doc = null; v.flat = []; v.pdf = null; v.page = null; v.raster = null;
  v.bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  v.contentBounds = null;
  v.metersPerUnit = null; v.scaleMethod = 'none';
  v.calibrations = []; v.scaleZones = [];
  v.notToScale = false; v.notToScaleWhy = '';
  v.layerVisible = {};
  v.render();
  state.drawing = null;
  state.calc = null; state.encoding = null; state.survey = null; state.pdfScale = null; state.dupe = null; state.dims = null;
  renderDupeChip(); renderVerifyChip();
  $('#drawName').textContent = '未載入圖面';
  $('#pageChip').hidden = true;
  renderCalcChip(); updateScaleChip(); renderSheetChip(); renderMeasureList(); persist();
}

/* ══════════ 比例與量測 ══════════ */

function bindViewer(v) {
  v.on('hover', ({ world, snap }) => {
    $('#coord').textContent = `x ${world.x.toFixed(1)}  y ${world.y.toFixed(1)}${snap ? '  · ' + snap : ''}`;
  });
  v.on('measure', () => renderMeasureList());
  v.on('measure-change', () => renderMeasureList());
  v.on('scale', () => updateScaleChip());
  v.on('calib-request', ({ dUnits, measurement }) => {
    const isPdf = v.mode === 'pdf';
    // 整頁還沒有比例時，第一次校正應該先把整頁定下來 ——
    // 只建分區會讓分區以外的圖全部量不出數字，那比套錯比例更沒用。
    const hasPageScale = !!v.metersPerUnit;
    dialog('比例校正', `
      <p>已在圖上量到 <b class="num">${dUnits.toFixed(2)}</b> 個圖面單位。請輸入這段的實際長度：</p>
      <div class="fgrid">
        <div><label class="f">實際長度</label><input type="number" id="calLen" step="0.001" min="0" value="1"></div>
        <div><label class="f">單位</label><select id="calUnit"><option value="1">公尺 m</option><option value="0.001">公厘 mm</option><option value="0.01">公分 cm</option><option value="0.3048">英呎 ft</option></select></div>
      </div>
      ${isPdf ? `<div class="fgrid" style="margin-top:4px">
        <div style="grid-column:1/-1"><label class="f">這次校正的適用範圍</label>
        <select id="calScope">
          ${hasPageScale
            ? '<option value="zone">只套用在這一區（建議）</option><option value="page">套用到整頁</option>'
            : '<option value="page">套用到整頁（這頁還沒有比例）</option><option value="zone">只套用在這一區</option>'}
        </select></div>
        <div style="grid-column:1/-1"><label class="f">分區名稱</label>
        <input type="text" id="calName" placeholder="例如 SECTION A-A" value="分區 ${v.scaleZones.length + 1}"></div>
      </div>
      <p class="chip warn" style="display:block;padding:8px 10px;margin-top:8px;white-space:normal">
        <b>一張施工圖通常不只一個比例。</b>圖框 1:100、大樣 1:10 是常態。
        ${hasPageScale
          ? '「只套用在這一區」會以這次校正的兩點為中心建立一個比例分區，之後在該區內的量測自動用這個比例；區外仍用整頁比例。選「整頁」會把大樣的比例套到平面上去，那會整批錯。'
          : '這一頁目前完全沒有比例，所以先用這次校正把整頁定下來。之後要量大樣時，再對那一區單獨校正並選「只套用在這一區」。'}</p>` : ''}
      <p class="hint">可重複校正多段已知尺寸：兩段以上會改用最小平方求比例，並回報 RMS 殘差 —— 殘差就是這份圖「量得準不準」的客觀證據。</p>`,
      [{ label: '取消' }, {
        label: '套用', primary: true, fn: () => {
          const len = parseFloat($('#calLen').value) * parseFloat($('#calUnit').value);
          if (!(len > 0)) return;
          const scope = $('#calScope') ? $('#calScope').value : 'page';
          if (scope === 'zone' && measurement && measurement.pts && measurement.pts.length >= 2) {
            const z = v.addScaleZone(zoneRectFor(measurement, v), len / dUnits, {
              name: ($('#calName') && $('#calName').value.trim()) || undefined,
              method: 'two-point',
              ratio: v.mode === 'pdf' ? Math.round((len / dUnits) / (25.4 / 72 / 1000)) : null,
            });
            renderMeasureList(); updateScaleChip();
            if (z) setTimeout(() => dialog('已建立比例分區', `
              <p>「${esc(z.name)}」比例 <b>1:${z.ratio ?? '—'}</b>，只作用在這一區。</p>
              <p class="hint">在這個範圍內的量測會自動採用這個比例，範圍外仍用整頁比例。
              這正是大樣與平面同在一張圖時該有的做法 —— 整張套一個比例會讓其中一邊整批錯掉。</p>`), 60);
            return;
          }
          const info = v.addCalibration(dUnits, len);
          if (info) applyCalibrationToItems(info);
        },
      }]);
  });

/**
 * 由校正的兩點推出分區範圍。
 *
 * 以兩點為中心向外擴張 —— 一個視圖的範圍一定比它內部任何一條標註尺寸大。
 * 擴張倍率保守取 3 倍，寧可小一點讓使用者再校正一次，也不要大到蓋掉隔壁的視圖。
 */
function zoneRectFor(m, v) {
  const pts = m.pts;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const half = Math.max(Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)), 1) * 1.5;
  return { x0: cx - half, y0: cy - half, x1: cx + half, y1: cy + half };
}
}

function applyCalibrationToItems(info) {
  for (const it of state.items) {
    if (it.provenance && it.provenance.kind === 'measure') {
      it.calibration = info.method; it.calibrationRms = info.rms ?? 0;
    }
  }
  renderAll();
}

/**
 * 工具列上的圖號膠囊。
 *
 * 為什麼要有這顆：使用者要的是「這一列的量出自 A0-1」，
 * 而圖號**不在檔案裡** —— DXF 沒有標準欄位放它，PDF 也沒有。
 * 唯一可靠的來源是人。所以這裡把「推得到／推不到」明白分開顯示：
 * 推得到的標「（由檔名推）」，推不到的直接寫「未設圖號」並且是警示色，
 * 讓人一眼知道匯出去的那一欄現在是空的。
 */
function renderSheetChip() {
  const el = $('#sheetChip');
  if (!el) return;
  if (!state.drawing) { el.hidden = true; return; }
  el.hidden = false;
  const manual = (state.sheetNos[state.drawing.name] || '').trim();
  const guess = SH.parseSheetNo(state.drawing.name);
  const no = manual || guess.no;
  el.className = 'chip ' + (manual ? 'ok' : no ? '' : 'warn');
  el.textContent = no ? `圖號 ${no}${manual ? '' : '（由檔名推）'}` : '未設圖號';
  el.title = no
    ? `${manual ? '人工指定' : guess.how}。按一下可修改；會標註在每一列的數量出處，也會匯出成獨立的「圖號」欄。`
    : `${guess.why}。按一下可手動填入 —— 不填的話匯出的「圖號」欄會是空白。`;
  el.onclick = openSheetNo;
}

/**
 * 設定這張圖的圖號。
 *
 * 填下去之後，**已經抓好的量也會一起標上** —— 使用者通常是先抓完量、
 * 看到圖號欄空白才回頭補。若只影響之後抓的量，這個欄位等於沒用。
 */
function openSheetNo() {
  if (!state.drawing) return;
  const name = state.drawing.name;
  const manual = (state.sheetNos[name] || '').trim();
  const guess = SH.parseSheetNo(name);
  const n = state.items.filter((it) => it.provenance && it.provenance.drawing === name).length;
  dialog('這張圖的圖號', `
    <p class="hint">檔案：${esc(name)}</p>
    <label class="f">圖號（例：A0-1、E-01、結05）</label>
    <input type="text" id="snVal" value="${esc(manual || guess.no || '')}" placeholder="留白代表不標註">
    <p class="hint" style="margin-top:6px">${guess.no
      ? `程式從檔名推得 <b>${esc(guess.no)}</b>（${esc(guess.how)}）。不對就直接改掉 —— 你填的不會再被自動解析蓋回去。`
      : `程式<b>推不出來</b>：${esc(guess.why)}。<br>圖號不在檔案裡 —— DXF／PDF 都沒有標準欄位放它，只能由人填。
         推不到時工具刻意留白，不會拿檔名充數：空白看得出來要補，錯的圖號看起來是對的，會一路跟著請購單、發包單、驗收單跑。`}</p>
    <p class="hint">目前有 <b>${n}</b> 筆工項的圖面量出自這張圖，改了之後這 ${n} 筆會一起更新。</p>`,
    [{ label: '取消' }, { label: '儲存', primary: true, fn: () => {
      const v = $('#snVal').value.trim();
      if (v) state.sheetNos[name] = v; else delete state.sheetNos[name];
      syncProvSheets();
      renderSheetChip(); renderAll(); persist();
    } }]);
}

function updateScaleChip() {
  const v = state.viewer;
  const i = v.scaleInfo();
  const chip = $('#scaleChip');
  chip.style.cursor = 'pointer';
  if (i.notToScale) { chip.className = 'chip bad'; chip.textContent = '不按比例（量測無意義）'; return; }
  if (!i.metersPerUnit) { chip.className = 'chip bad'; chip.textContent = '比例：未設定（量測無效）'; return; }
  const label = { native: '圖檔原生單位', 'two-point': '兩點校正', 'vector-rms': `${i.points} 段最小平方`, 'declared-scale': '圖框標註比例' }[i.method] || i.method;
  chip.className = 'chip ' + (i.method === 'declared-scale' ? 'warn' : i.rms != null && i.rms > 0.02 ? 'warn' : 'ok');
  chip.textContent = `比例：${label}${i.ratio ? ` 1:${i.ratio}` : ''}${i.rms ? ` · RMS ${(i.rms * 100).toFixed(2)}%` : ''}`;
}

function openScaleDialog(firstTime = false) {
  const v = state.viewer;
  if (!v.mode) return dialog('尚未載入圖面', '<p>請先載入 DWG／DXF／PDF。</p>');
  const fr = state.pdfScale;
  dialog('設定圖面比例', `
    ${notToScaleBlock(v, fr)}
    ${firstTime && !v.notToScale ? '<p class="chip bad" style="display:block;padding:7px 10px">PDF 沒有真實尺寸資訊。未設定比例前，所有量測值都不會換算成工程單位。</p>' : ''}
    ${multiScaleWarning()}
    ${fr ? framedScaleBlock(fr) : ''}
    <h4 style="margin-top:14px">方法一：實測校正（建議，且是唯一對大樣有效的方法）</h4>
    <p>選「比例校正」工具，在圖上點兩點已知尺寸（例如標註的 600），輸入實際長度。重複 2 段以上可取得 RMS 殘差。</p>
    <h4 style="margin-top:12px">方法二：手動輸入比例</h4>
    <div class="fgrid">
      <div><label class="f">比例 1 : N</label><input type="number" id="ratioN" min="1" step="1" value="${v.scaleInfo().ratio || 100}"></div>
      <div style="align-self:end"><button class="btn" id="btnRatio">套用到整頁</button></div>
    </div>
    <p class="hint">此法假設 PDF 由 CAD 以 1:1 圖紙尺寸輸出且未經縮放列印。實務上常見「A1 圖縮印成 A3」而失真，
    所以本工具在可信度評分中對這個方法扣分。</p>`, [{ label: '關閉' }], (body) => {
    body.querySelector('#btnRatio').onclick = () => {
      const n = parseInt(body.querySelector('#ratioN').value, 10);
      v.setDeclaredScale(n); updateScaleChip(); renderMeasureList(); $('#dlg').close();
    };
    const b = body.querySelector('#btnFramed');
    if (b) b.onclick = () => {
      v.setDeclaredScale(fr.ratio); updateScaleChip(); renderMeasureList(); $('#dlg').close();
    };
    const nts = body.querySelector('#chkNts');
    if (nts) nts.onchange = () => {
      v.setNotToScale(nts.checked, '人工確認：圖框標示不按比例');
      updateScaleChip(); renderMeasureList();
    };
  });
}

/**
 * 一張施工圖同時有好幾個比例，這件事必須放在最前面講。
 *
 * 實測案例：一張 A1 圖，圖框寫「A1圖:1:100」，但 SECTION A-A 的 600mm 尺寸線
 * 在紙上是 59.97mm —— 那一區實際是 1:10。整張套圖框比例，大樣的量測會錯 10 倍，
 * 而且畫面上完全正常，沒有任何跡象。
 */
/**
 * 讀圖框的比例宣告。
 *
 * 真實施工圖常把尺寸標註轉成曲線，pdf.js 只抽得到圖框那幾行字 ——
 * 但比例欄剛好在那幾行裡，所以這一步還是值得做。
 * 讀到的只是候選，永遠不自動套用。
 */
async function readFramedScale(pdf, pageNo) {
  state.pdfScale = null;
  try {
    const page = await pdf.getPage(pageNo);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const strings = tc.items.map((i) => i.str).filter((x) => x && x.trim());
    // 同時看這一頁是向量還是掃描 —— 純掃描圖讀不到任何文字，
    // 「讀不到比例」與「沒有比例」是兩件完全不同的事。
    const pdfjs = await import('../../vendor/pdfjs/pdf.min.mjs');
    const ol = await page.getOperatorList();
    const names = {};
    for (const [k, v] of Object.entries(pdfjs.OPS)) names[v] = k;
    const ops = {};
    for (const f of ol.fnArray) { const n = names[f] || String(f); ops[n] = (ops[n] || 0) + 1; }
    let imageWidth = null;
    for (let j = 0; j < ol.fnArray.length; j++) {
      if (names[ol.fnArray[j]] !== 'paintImageXObject') continue;
      try { const o = page.objs.get(ol.argsArray[j][0]); if (o && o.width) imageWidth = o.width; } catch { /* 尚未解碼 */ }
    }
    state.pdfScale = PS.analyze(vp.width, vp.height, strings, { textCount: strings.length, ops, imageWidth });
    // 圖框明文寫著不按比例 → 直接鎖住，量出來的數字沒有意義
    if (state.pdfScale.nts) state.viewer.setNotToScale(true, '圖框標示不按比例');
    else state.viewer.setNotToScale(false);
  } catch (e) { console.warn('讀不到圖框比例', e); }
}

/**
 * 「不按比例」是比「未校正」嚴重得多的狀態，所以放在最上面。
 *
 * 未校正 = 缺一個數字，校了就能算。
 * 不按比例 = 圖本身的幾何不代表實際尺寸，校正再準也沒有意義。
 *
 * 純掃描圖讀不到文字，圖框就算寫著 NO SCALE 也抓不到 ——
 * 那一格只能請人眼看一次，然後自己勾。這是工具問不到、只能問人的事。
 */
function notToScaleBlock(v, fr) {
  const detected = !!(fr && fr.nts);
  const scan = !!(fr && fr.scan);
  const on = !!v.notToScale;
  return `<div class="feas ${on ? 'bad' : ''}" style="margin-bottom:10px">
    ${on ? `<b>這張圖標示為「不按比例」，量測不會換算成工程單位。</b>
      <div class="hint" style="margin-top:4px">${esc(v.notToScaleWhy || '')}</div>
      <p style="margin:7px 0 0">圖上寫的尺寸數字仍然有效 —— 那些要<b>用讀的</b>，
      讀完填進工項的「人工確認」欄，並註明出自哪一張圖。這樣數量的出處才是對的：
      它來自圖上的標註，不是來自我對一張示意圖的量測。</p>`
      : `<b>這張圖是按比例畫的嗎？</b>
      <p style="margin:6px 0 0">標單圖、示意圖經常標示「NO SCALE」——
      那種圖的幾何不代表實際尺寸，量測再怎麼校正都沒有意義，圖上寫的數字才算數。</p>`}
    ${scan && !detected ? `<p class="chip warn" style="display:block;padding:7px 10px;margin-top:8px;white-space:normal">
      這是純掃描圖，讀不到任何文字，所以<b>工具無法自己判斷</b>圖框寫的是什麼比例。
      請看一下標題欄的「比例尺」欄位再勾下面那一格。</p>` : ''}
    <label style="display:flex;gap:7px;align-items:center;margin-top:9px;cursor:pointer">
      <input type="checkbox" id="chkNts" style="width:auto" ${on ? 'checked' : ''}>
      <span>這張圖標示不按比例（NO SCALE／NTS）${detected ? '　<span class="chip bad">已從圖框文字偵測到</span>' : ''}</span>
    </label>
  </div>`;
}

function multiScaleWarning() {
  return `<p class="chip bad" style="display:block;padding:9px 11px;white-space:normal;line-height:1.6">
    <b>一張施工圖通常不只一個比例。</b>圖框標的比例只適用主要視圖；
    SECTION、大樣、詳圖幾乎都有自己的比例（常見 1:10、1:20、1:50）。
    <b>整張套同一個比例，大樣的量測會整批錯掉，而且畫面上看不出來。</b>
    量大樣之前請用「比例校正」對那一區單獨校正 —— 校正會建立一個只作用在該區域的比例分區。</p>`;
}

/** 從圖框讀到的比例。只當候選，不自動套。 */
function framedScaleBlock(fr) {
  return `<h4 style="margin-top:12px">從圖框讀到的比例</h4>
    ${fr.evidence.map((e) => `<p class="chip ${e.level === 'bad' ? 'bad' : e.level === 'ok' ? 'ok' : 'warn'}"
      style="display:block;padding:7px 10px;white-space:normal">${esc(e.msg)}</p>`).join('')}
    ${fr.ratio ? `<div style="display:flex;gap:8px;align-items:center;margin-top:8px">
      <button class="btn ${fr.usable ? 'primary' : ''}" id="btnFramed">套用 1:${fr.ratio} 到整頁</button>
      <span class="hint">1 pt = ${Q.fmt(fr.metersPerPoint, 6)} M${fr.usable ? '' : '　（證據不足，套用前請先以實測校正驗證）'}</span>
    </div>` : ''}`;
}

function renderMeasureList() {
  const v = state.viewer;
  const host = $('#mlist');
  if (!v.measurements.length) {
    host.innerHTML = '<div class="hint" style="padding:9px 11px">尚無量測。選擇工具後在圖上點選；完成的量測會列在這裡，可指派到工項成為「圖面量」。</div>';
    return;
  }
  host.innerHTML = v.measurements.map((m) => {
    const e = v.engValue(m);
    const it = m.itemCode ? state.itemByCode.get(m.itemCode) : null;
    return `<div class="mrow">
      <span class="chip">${esc(TOOLS[m.type] ? TOOLS[m.type].label : m.type)}</span>
      <span class="v">${e.value == null ? `${v.rawValue(m).toFixed(1)} <span class="chip bad">未校正</span>` : `${Q.fmt(e.value, 2)} ${esc(e.unit)}`}</span>
      <span class="hint" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${it ? esc(it.name) : '未指派'}</span>
      <button class="btn sm" data-assign="${esc(m.id)}">指派</button>
      <button class="btn sm" data-mdel="${esc(m.id)}">刪除</button>
    </div>`;
  }).join('');
}

function openAssign(mid) {
  const v = state.viewer;
  const m = v.measurements.find((x) => x.id === mid);
  if (!m) return;
  const e = v.engValue(m);
  if (e.value == null) return dialog('尚未設定比例', '<p>請先完成比例校正，量測值才有工程意義。</p>');
  const pool = (state.activeNode ? descendantItems(state.nodeByCode.get(state.activeNode)) : state.items);
  dialog('指派量測到工項', `
    <p>量測值：<b class="num">${Q.fmt(e.value, 3)} ${esc(e.unit)}</b>（${esc(TOOLS[m.type].label)}）</p>
    <div class="fgrid">
      <div style="grid-column:1/-1"><label class="f">工項</label>
        <select id="asItem">${pool.map((i) => `<option value="${esc(i.code)}">${esc(i.code)} · ${esc(i.name)}（${esc(i.unit)}）</option>`).join('')}</select></div>
      <div><label class="f">換算係數</label><input type="number" id="asFactor" step="0.0001" value="1"></div>
      <div><label class="f">寫入方式</label><select id="asMode"><option value="add">累加到圖面量</option><option value="set">取代圖面量</option></select></div>
    </div>
    <p class="hint">換算係數用於維度不一致的情況：面積 × 厚度 = 體積、長度 × 單位重 = 重量、
    風管中心線長 × 周長 = 表面積。係數不是 1 時請在備註寫清楚，否則稽核時無法還原。</p>`,
    [{ label: '取消' }, {
      label: '寫入', primary: true, fn: () => {
        const it = state.itemByCode.get($('#asItem').value);
        const f = parseFloat($('#asFactor').value) || 1;
        const val = e.value * f;
        const mode = $('#asMode').value;
        it.qty.drawing = mode === 'add' ? Q.roundTo((it.qty.drawing || 0) + val, 4) : Q.roundTo(val, 4);
        it.drawingSource = 'measure';
        freshDrawingQty(it);
        it.closed = m.type === 'area' || m.type === 'rect' ? true : it.closed;
        const info = v.scaleInfo();
        it.calibration = info.method; it.calibrationRms = info.rms ?? 0;
        it.provenance = {
          kind: 'measure', drawing: state.drawing ? state.drawing.name : '', sheetNo: curSheetNo(),
          page: state.drawing && state.drawing.pageNo,
          measurements: [...((it.provenance && it.provenance.measurements) || []), { id: m.id, type: m.type, value: e.value, factor: f }],
          at: new Date().toISOString(),
        };
        m.itemCode = it.code;
        renderAll(); renderMeasureList();
      },
    }]);
}

/* ══════════ 座標與單位合理性 ══════════ */

/**
 * 真實圖檔逼出來的兩道檢查：宣告單位與座標實際大小對不對得起來，
 * 以及圖面是不是散成好幾群座標（地籍內容在測量座標、圖例在原點旁）。
 *
 * 兩者都不會讓畫面出錯 —— 只會讓數量安靜地錯掉。所以一定要主動講。
 */
function checkSurvey(doc) {
  const chk = SV.checkUnits(doc, DXF.flatten(doc));
  state.survey = chk;
  if (!chk || (chk.ok && !chk.reasons.length)) return;
  const bad = chk.reasons.filter((r) => r.level === 'bad');
  if (!bad.length && !chk.split) return;

  const cands = chk.suggest ? [chk.suggest] : (chk.candidates || []);
  setTimeout(() => dialog(bad.length ? '圖檔宣告的單位對不上座標大小' : '座標分布異常', `
    ${chk.crs ? `<p class="chip" style="display:block;padding:8px 10px">辨識為 <b>${esc(chk.crs)}</b>　內容跨距
      <b>${Q.fmt(chk.bounds.width, 1)} × ${Q.fmt(chk.bounds.height, 1)} 公尺</b></p>` : ''}
    ${chk.reasons.map((r) => `<p class="chip ${r.level === 'bad' ? 'bad' : 'warn'}" style="display:block;padding:8px 10px;white-space:normal">${esc(r.msg)}</p>`).join('')}
    ${cands.length ? `<div class="fgrid" style="margin-top:10px">
      <div style="grid-column:1/-1"><label class="f">改用哪個單位</label>
      <div style="display:flex;gap:7px;flex-wrap:wrap">${cands.map((u) =>
        `<button class="btn ${chk.suggest && u.toM === chk.suggest.toM ? 'primary' : ''}" data-setunit="${u.toM}">${esc(u.name)}（1 單位 = ${u.toM} M）</button>`).join('')}</div></div>
    </div>` : ''}
    <p class="hint" style="margin-top:9px">工具<b>不會自動改單位</b> —— 改單位會改變每一筆抓出來的數量。
    這是工程判斷，請確認後再按。不改也可以繼續，但圖面量會照宣告的單位算。</p>`,
    [{ label: '維持原宣告' }], (body) => {
      body.addEventListener('click', (e) => {
        const b = e.target.closest('[data-setunit]');
        if (!b) return;
        const toM = parseFloat(b.dataset.setunit);
        state.viewer.setNativeUnit(toM);
        state.surveyFixed = { from: chk.declared && chk.declared.name, toM, at: new Date().toISOString() };
        updateScaleChip(); renderAll(); persist();
        $('#dlg').close();
      });
    }), 120);
}

/* ══════════ 圖面計算式 ══════════ */

/**
 * DXF 載入後自動找計算式表。
 * 台灣 QS 習慣把算式直接寫在圖上 —— 那是設計者親手寫下的數量意圖，
 * 而且是唯一一條會自我驗算的來源：算式可重算、交叉參照可追、合計可驗。
 */
function detectCalcSheet(doc, name) {
  const texts = DXF.flatten(doc).filter((e) => e.type === 'TEXT')
    .map((e) => ({ text: e.text, x: e.pt.x, y: e.pt.y, height: e.h }));
  if (texts.length < 3) { state.calc = null; renderCalcChip(); return; }
  const sheet = CS.parseSheet(texts);
  if (!sheet.rows.length) { state.calc = null; renderCalcChip(); return; }
  const v = CS.verify(sheet);
  state.calc = { source: name, sheet, verify: v, at: new Date().toISOString() };
  renderCalcChip();
  const bad = v.counts.bad;
  setTimeout(() => dialog('圖上找到計算式表', `
    <p>在《${esc(name)}》找到 <b>${v.counts.rows}</b> 道計算式，
    重算後 <b>${v.counts.passed}</b> 道相符${bad ? `、<b class="bad">${bad} 處有問題</b>` : '、<b>零錯誤</b>'}。</p>
    ${calcMojibakeNote(sheet)}
    ${bad ? `<p class="chip bad" style="display:block;padding:8px 10px">${v.issues.filter((i) => i.level === 'bad').slice(0, 3).map((i) => esc(`${i.label}（${i.row}）：${i.msg}`)).join('<br>')}</p>` : ''}
    <p class="hint">計算式是設計者寫下的數量意圖，與我從線段算出來的幾何量是<b>兩條獨立來源</b>。
    兩者相符代表圖上畫的跟標的一致；不符就是必有一錯 —— 那正是最該發 RFI 的情形。</p>`,
    [{ label: '查看與套用', primary: true, fn: () => setTimeout(openCalcSheet, 60) }, { label: '稍後' }]), 60);
}

function calcMojibakeNote(sheet) {
  const m = sheet.mojibake;
  if (!m || m.ratio < 0.25) return '';
  return `<p class="chip warn" style="display:block;padding:8px 10px">
    這份圖有 <b>${m.count}/${m.total}</b> 個文字是亂碼（缺 SHX 大字型對應，中文全部變成問號）。
    <b>數字與運算子不受字型影響，算式照樣可以驗算</b>，但工項名稱必須人工對照 ——
    我讀得出 <code>8.58*7.265=62.33</code>，讀不出它叫什麼。</p>`;
}

function renderCalcChip() {
  const el = $('#calcChip');
  if (!el) return;
  if (!state.calc) { el.hidden = true; return; }
  const c = state.calc.verify.counts;
  el.hidden = false;
  el.className = 'chip ' + (c.bad ? 'bad' : c.warn ? 'warn' : 'ok');
  el.style.cursor = 'pointer';
  el.textContent = `計算式 ${c.passed}/${c.rows}${c.bad ? ` · ${c.bad} 錯` : ''}`;
}

function openCalcSheet() {
  if (!state.calc) return dialog('尚未找到計算式', '<p>載入含計算式表的 DXF 後，這裡會列出每一道算式的驗算結果。</p>');
  const { sheet, verify: v } = state.calc;
  const gt = CS.grandTotal(sheet);
  const badge = (r) => r.error ? '<span class="chip warn">看不懂</span>'
    : r.ok ? '<span class="chip ok">✓</span>' : '<span class="chip bad">✗</span>';
  dialog(`圖面計算式 · ${state.calc.source}`, `
    <div class="feas" style="${v.counts.bad ? '' : 'border-color:var(--ok);background:var(--ok-bg)'}">
      <b>${v.counts.rows} 道算式，${v.counts.passed} 道重算相符${v.counts.bad ? `，${v.counts.bad} 處有問題` : '，零錯誤'}。</b>
      ${gt ? `　總計 <b>${Q.fmt(gt.stated, 2)} ${esc(gt.unit || '')}</b>` : ''}
      ${v.declared.length ? `<div class="hint" style="margin-top:4px">圖上另外宣告 ${v.declared.map((d) => `${Q.fmt(d.stated, 2)}${esc(d.unit || '')}（另有 ${d.confirmedBy} 處相符）`).join('、')}</div>` : ''}
    </div>
    ${calcMojibakeNote(sheet)}
    ${v.issues.length ? `<h4 style="margin:13px 0 6px">問題（${v.issues.length}）</h4>
      <table class="mkt" style="table-layout:fixed;width:100%"><tbody>${v.issues.map((i) => `<tr>
        <td style="width:96px"><span class="chip ${i.level === 'bad' ? 'bad' : 'warn'}">${esc(i.label)}</span></td>
        <td style="width:46px">${esc(i.row)}</td>
        <td style="white-space:normal">${esc(i.msg)}<div class="hint">${esc(i.note)}</div></td></tr>`).join('')}</tbody></table>`
      : '<p class="chip ok" style="display:block;padding:8px 10px;margin-top:12px">全部通過：每道算式重算相符、交叉參照一致、合計有出處。</p>'}

    <h4 style="margin:14px 0 6px">逐式驗算</h4>
    <div style="overflow-x:auto"><table class="mkt" style="min-width:640px">
      <thead><tr><th style="width:30px"></th><th style="width:34px">列</th><th>算式</th>
      <th class="n" style="width:78px">重算</th><th class="n" style="width:78px">圖上</th>
      <th style="width:44px">單位</th><th style="width:64px">參照</th></tr></thead>
      <tbody>${v.rows.map((r) => `<tr class="${r.ok === false ? 'bad' : ''}">
        <td>${badge(r)}</td>
        <td>${esc(r.mark || (r.isTotal ? '計' : '—'))}</td>
        <td style="white-space:normal;font-family:var(--mono);font-size:11.5px;word-break:break-all">${esc(r.expr)}
          ${r.mark ? `<div class="hint" style="font-family:var(--font)">${esc(r.label)}</div>` : ''}</td>
        <td class="n">${r.error ? '—' : Q.fmt(r.rounded, r.decimals)}</td>
        <td class="n"><b>${Q.fmt(r.stated, r.decimals)}</b></td>
        <td>${esc(r.unit || '')}</td>
        <td class="hint">${r.refs.length ? esc(r.refs.join('、')) : ''}</td></tr>`).join('')}</tbody></table></div>

    ${calcMatchBlock(v.rows)}
    <h4 style="margin:14px 0 6px">套用到工項</h4>
    <p class="hint">計算式會寫進工項的「圖面計算式」欄，成為第五條獨立來源，與幾何量、BOQ 量三方比對。
    <b>只套用數字，不覆蓋任何既有來源。</b>同維度單位（M²↔坪、CM↔M）會自動換算並記在出處裡。</p>
    <div class="fgrid">
      <div><label class="f">套用哪一個數值</label><select id="calcPick">
        ${gt ? `<option value="__total__">總計 ${Q.fmt(gt.stated, 2)} ${esc(gt.unit || '')}</option>` : ''}
        ${v.rows.filter((r) => !r.isTotal && r.ok).map((r) => `<option value="${r.y}">${esc(r.mark || '—')} ${esc(r.label || '')} · ${Q.fmt(r.stated, 2)} ${esc(r.unit || '')}</option>`).join('')}
      </select></div>
      <div><label class="f">套用到工項</label><select id="calcItem">
        <option value="">— 選一個工項 —</option>
        ${state.items.map((it) => `<option value="${esc(it.code)}">${esc(it.code)} · ${esc(it.name)}（${esc(it.unit)}）</option>`).join('')}
      </select></div>
    </div>`,
    [{ label: '關閉' }, { label: '套用', primary: true, fn: applyCalcToItem }]);
}

/**
 * 名稱自動比對。編碼修好之前這件事做不到 —— 名稱全是 ???? 的時候無從比對。
 * 出來的一律是**建議**，附分數與換算結果，由人確認後才寫入。
 */
function calcMatchBlock(rows) {
  const cand = rows.filter((r) => r.name && !r.isTotal);
  if (!cand.length) return '';
  const ms = CS.matchItems(cand, state.items).filter((m) => m.match);
  if (!ms.length) {
    return `<h4 style="margin:14px 0 6px">名稱比對</h4>
      <p class="chip warn" style="display:block;padding:8px 10px">
      這張表的 ${cand.length} 個名稱都對不到 BOM 工項。<b>這通常不是錯誤</b> ——
      計算式表列的常是「空間」（玄關、會議室），BOM 列的是「材料」（電纜、鋼筋），兩者本來就不是一對一。
      樓地板面積要先乘上單位用量才會變成材料數量，那一步是工程判斷，工具不替你做。</p>`;
  }
  return `<h4 style="margin:14px 0 6px">名稱比對（${ms.length} 筆建議）</h4>
    <table class="mkt"><thead><tr><th>計算式列</th><th class="n">數值</th><th>建議工項</th><th class="n">換算後</th><th>把握度</th></tr></thead>
    <tbody>${ms.map((m) => `<tr>
      <td>${esc(m.row.name)}<div class="hint">${esc(m.row.mark || '')}</div></td>
      <td class="n">${Q.fmt(m.row.stated, 2)} ${esc(U.labelOf(m.row.unit))}</td>
      <td>${esc(m.match.code)} ${esc(m.match.name)}<div class="hint">${esc(m.match.unit)}</div></td>
      <td class="n">${m.convert && m.convert.ok
        ? `${Q.fmt(m.convert.value, 2)}${m.convert.factor !== 1 ? `<div class="hint">${esc(m.convert.how)}</div>` : ''}`
        : `<span class="chip bad">不可換算</span>`}</td>
      <td><span class="chip ${m.score >= 0.9 ? 'ok' : 'warn'}">${(m.score * 100).toFixed(0)}%</span>
        ${m.ambiguous ? '<span class="chip warn">分不出來</span>' : ''}
        ${m.dimOk === false ? '<span class="chip bad">維度不符</span>' : ''}</td></tr>`).join('')}</tbody></table>
    <p class="hint" style="margin-top:5px">這些是<b>建議</b>，不是結論。名稱相似不等於同一個工項 ——
    請在下方逐一確認後套用。編碼修好之前這一步做不到，因為名稱全是問號時無從比對。</p>`;
}

/** 從對話框讀出選擇，交給 applyCalcRow。選擇必須在這裡抓下來 —— */
function applyCalcToItem() {
  const code = $('#calcItem') && $('#calcItem').value;
  const pick = $('#calcPick') && $('#calcPick').value;
  if (!code || !pick) return;
  const it = state.itemByCode.get(code);
  if (!it) return;
  const { sheet, verify: v } = state.calc;
  const row = pick === '__total__' ? CS.grandTotal(sheet) : v.rows.find((r) => String(r.y) === pick);
  if (!row) return;
  applyCalcRow(row, it);
}

/**
 * 實際套用。row 與 item 由呼叫端帶進來，不在這裡重讀 DOM ——
 * 補寬度的對話框會換掉整個 body，那時候下拉選單早就不存在了。
 */
function applyCalcRow(row, it, bridgeValue) {
  const v = state.calc.verify;
  // 同維度自動換算（M²↔坪、CM↔M、KG↔公噸…）；跨維度要補寬度／厚度，工具會問不會猜。
  const conv = U.convert(row.stated, row.unit || it.unit, it.unit, { bridge: bridgeValue });
  if (!conv.ok) {
    if (conv.reason === 'need-bridge') return askBridge(row, it, conv);
    return setTimeout(() => dialog('無法換算，未套用', `<p>${esc(conv.msg)}</p>
      <p class="hint">計算式的單位是 <b>${esc(U.labelOf(row.unit))}</b>，工項「${esc(it.name)}」的單位是
      <b>${esc(U.labelOf(it.unit))}</b>。請確認要套用的是哪一列。</p>`), 60);
  }

  it.qty.calc = conv.value;
  it.calcSource = `${state.calc.source} · ${row.mark ? `列 ${row.mark}` : '總計'}：${row.expr}=${row.stated}${U.labelOf(row.unit)}`
    + (conv.factor === 1 ? '' : `（${conv.how}）`);
  it.calcIssues = v.issues.filter((i) => i.row === (row.mark || '—'));
  const cross = CS.crossCheck(conv.value, it.qty.drawing);
  renderAll(); persist();
  setTimeout(() => dialog('已套用', `
    <p>「${esc(it.name)}」的圖面計算式量 = <b>${Q.fmt(conv.value, 2)} ${esc(it.unit)}</b></p>
    ${conv.factor !== 1 || conv.bridge ? `<p class="chip" style="display:block;padding:7px 10px">已換算：${esc(conv.how)}</p>` : ''}
    <p class="hint">出處：${esc(it.calcSource)}</p>
    ${cross ? `<p class="chip ${cross.agree ? 'ok' : 'bad'}" style="display:block;padding:8px 10px">
      幾何量 ${Q.fmt(cross.drawing, 2)}，差異 ${Q.pct(cross.rate)}。${esc(cross.verdict)}</p>` : ''}`), 60);
}

/** 跨維度換算缺的那一個量，由工程指定 —— 工具問，不猜。 */
function askBridge(row, it, conv) {
  const b = conv.bridge;
  setTimeout(() => dialog(`需要${b.need}才能換算`, `
    <p>計算式是 <b>${Q.fmt(row.stated, 2)} ${esc(U.labelOf(row.unit))}</b>，
    工項「${esc(it.name)}」的單位是 <b>${esc(U.labelOf(it.unit))}</b>。</p>
    <p class="chip warn" style="display:block;padding:8px 10px">${esc(b.why)}</p>
    <div class="fgrid"><div><label class="f">${esc(b.need)}（${esc(b.unit)}）</label>
      <input type="number" id="bridgeVal" step="0.001" min="0" placeholder="例如 0.6"></div></div>
    <p class="hint">這個數字不在圖上的算式裡，所以工具不會替你假設。填入後會記在數量出處裡，日後可稽核。</p>`,
    [{ label: '取消' }, { label: '換算並套用', primary: true, fn: () => {
      const val = parseFloat($('#bridgeVal').value);
      if (Number.isFinite(val) && val > 0) applyCalcRow(row, it, val);
    } }]), 60);
}

/* ══════════ 圖層 → 工項自動抓量 ══════════ */

function openLayers() {
  const v = state.viewer;
  if (v.mode !== 'dxf' || !v.doc) return dialog('僅適用向量圖檔', '<p>圖層自動抓量需要 DXF／DWG 幾何。PDF 請用量測工具逐段量。</p>');
  const agg = DXF.aggregateByLayer(v.doc);
  const toM = v.metersPerUnit;
  const nameOf = (c) => { const it = state.itemByCode.get(c); return it ? `${it.code} ${it.name}` : c; };
  const matches = agg.map((g) => matchLayer(g.layer, g));
  const auto = matches.filter((m) => m.best).length;
  const tied = matches.filter((m) => m.ambiguous.length).length;
  // 重複描繪嚴重的圖層一律擋下，不讓它寫進數量。理由見 dedupe.js：
  // 重複描繪給的是一個「完全合理但錯一倍」的數字，事後查不出來。
  const dupOf = (layer) => (state.dupe ? state.dupe.byLayer.get(layer) : null);
  const dupBad = (layer) => { const g = dupOf(layer); return !!g && DD.severity(g) === 'bad'; };
  const blockedCount = agg.filter((g) => dupBad(g.layer)).length;
  const rows = agg.map((g, i) => {
    const m = matches[i];
    const dg = dupOf(g.layer);
    const barred = dupBad(g.layer);
    const blocks = Object.entries(g.blocks).map(([n, c]) => `${n}×${c}`).join('、');
    // 無法分辨也要擋住不讓套用 —— 選了也寫不進去，並且會列進最後的漏項
    const locked = barred || m.ambiguous.length > 0;
    const chip = barred ? '<span class="chip bad">重複描繪</span>'
      : m.best ? `<span class="chip ${m.band === 'high' ? 'ok' : 'acc'}">自動 ${m.score}</span>`
        : m.ambiguous.length ? '<span class="chip bad">無法分辨</span>'
          : m.band === 'blocked' ? '<span class="chip warn">型態不符</span>'
            : '<span class="chip">需人工</span>';
    const why = barred ? `重複描繪：${DD.describe(dg, toM)}` : LM.explain(m, nameOf);
    return `<div class="layerrow" ${locked ? 'style="opacity:.72"' : ''}>
      <input type="checkbox" data-lv="${esc(g.layer)}" ${v.layerVisible[g.layer] === false ? '' : 'checked'} style="width:auto" title="顯示／隱藏">
      <span class="lname" title="${esc(g.layer)}">${esc(g.layer)}</span>
      <span class="num" style="width:96px">${toM ? Q.fmt(g.length * toM, 1) + ' M' : Q.fmt(g.length, 1)}</span>
      <span class="num" style="width:96px">${toM ? Q.fmt(g.area * toM * toM, 1) + ' M²' : Q.fmt(g.area, 1)}</span>
      <span class="num" style="width:54px">${g.count}</span>
      <select data-map="${i}" style="width:230px" ${locked ? 'disabled' : ''}>
        <option value="">— 不對映 —</option>
        ${state.items.map((it) => `<option value="${esc(it.code)}" ${m.best === it.code ? 'selected' : ''}>${esc(it.code)} · ${esc(it.name)}（${esc(it.unit)}）</option>`).join('')}
      </select>
      ${chip}
      <span class="hint" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
        title="${esc(why)}${blocks ? ' ｜圖塊 ' + esc(blocks) : ''}">${esc(why)}</span>
    </div>`;
  }).join('');
  dialog('圖層彙總 → 工項自動抓量', `
    <div class="hint" style="display:flex;gap:8px;padding:0 10px 6px">
      <span style="flex:1">圖層（${agg.length}）</span><span style="width:96px;text-align:right">長度</span>
      <span style="width:96px;text-align:right">面積</span><span style="width:54px;text-align:right">數量</span>
      <span style="width:230px">對映工項</span><span style="flex:1">判定依據</span></div>
    <div style="max-height:44vh;overflow:auto">${rows}</div>
    <p class="hint"><b>${agg.length}</b> 個圖層：自動對應 <b>${auto}</b> 個${tied ? `、<b class="bad">${tied} 個無法分辨</b>` : ''}${blockedCount ? `、<b class="bad">${blockedCount} 個因重複描繪被擋下</b>` : ''}，其餘留白待人工指定。</p>
    ${blockedCount ? `<p class="chip bad" style="display:block;padding:8px 10px;white-space:normal">
      有 <b>${blockedCount}</b> 個圖層偵測到重複描繪，已擋下不讓寫入。
      重複描繪會讓長度<b>直接翻倍</b>，而且給出的數字完全合理 —— 事後查不出來，
      比對應猜錯危險得多。請按工具列的「重複」晶片看細節，回 CAD 用 OVERKILL
      清除重複物件後重新匯出，或改用量測工具逐段量。</p>` : ''}
    ${tied ? `<p class="chip bad" style="display:block;padding:8px 10px;white-space:normal">
      「無法分辨」是指有兩個以上的工項對到同一個圖層，而<b>幾何上看不出差別</b> ——
      例如 38mm² 與 22mm² 的電纜畫在同一層，線就是線，圖面本身沒有這個資訊。
      這不是演算法不夠聰明，硬選一個只會把整層的長度算到其中一個工項頭上。請人工指定。</p>` : ''}
    <p class="hint">自動抓量取的是「該圖層所有實體的總長／總面積／實體數」。它的前提是<b>圖層紀律</b>：
    同一圖層只放同一種構件、不重複描繪、不用圖層當註記。這個前提在多數實際專案不成立，
    所以自動抓量的結果會標記為 <code>auto</code> 並在可信度上扣分，必須人工抽查。
    <b>數量本身完全來自幾何，對應只決定「算到哪個工項」</b> —— 對應錯了數字會不合理而被發現，
    這是它可以自動、而「看圖估數量」不可以自動的差別。</p>`,
    [{ label: '關閉' }, {
      label: '套用對映', primary: true, fn: () => {
        let n = 0;
        const missed = [];   // 沒寫進去的，連同原因 —— 這就是最後的漏項清單
        agg.forEach((g, i) => {
          const m = matches[i];
          const sel = $(`#dlgBody [data-map="${i}"]`);
          const code = sel && !sel.disabled ? sel.value : '';
          // 幾何量本身是算得出來的 —— 算不出來的只是「該算到哪個工項」。
          // 所以漏項保留不是憑空估，是「已知數量 × 同類均價」。
          const cand = m.ambiguous.length ? m.ambiguous : (m.top ? [m.top] : []);
          const refItem = cand.length ? state.itemByCode.get(cand[0]) : null;
          const qtyOf = (dedup) => {
            const src = { ...g };
            // 重複描繪的圖層改用聯集長度：總長本來就灌了水，
            // 拿灌水的數字去估保留會二次高估
            if (dedup) { const dg = dupOf(g.layer); if (dg && dg.union > 0) src.length = dg.union; }
            // 判斷不出是哪個工項，就判斷不出該取長度、面積還是個數 ——
            // 硬給一個「長度」會讓圖塊層冒出 0.2 M 這種對計數工項毫無意義的數字
            return refItem ? layerValueFor(refItem, src, toM) : null;
          };
          if (dupBad(g.layer)) {
            return missed.push({ layer: g.layer, why: `重複描繪：${DD.describe(dupOf(g.layer), toM)}`, level: 'bad',
              qty: qtyOf(true), unit: refItem ? refItem.unit : '', candidates: cand, wbs: refItem ? refItem.wbs : null });
          }
          if (m.ambiguous.length) {
            return missed.push({ layer: g.layer,
              why: `無法分辨：${m.ambiguous.map(nameOf).join(' / ')} 幾何上看不出差別`, level: 'bad',
              qty: qtyOf(false), unit: refItem ? refItem.unit : '', candidates: cand, wbs: refItem ? refItem.wbs : null });
          }
          if (!code) {
            if (m.band === 'blocked') return missed.push({ layer: g.layer, why: m.reasons.join('；'), level: 'warn' });
            return missed.push({ layer: g.layer, why: '未對映到任何工項', level: 'info' });
          }
          const it = state.itemByCode.get(code);
          const val = layerValueFor(it, g, toM);
          if (val == null) {
            return missed.push({ layer: g.layer, why: `算不出 ${it.measureType} 的量（可能是圖檔未定義單位）`, level: 'warn' });
          }
          it.qty.drawing = Q.roundTo(val, 4);
          it.drawingSource = 'auto';
          freshDrawingQty(it);
          it.layerMapped = true;
          it.calibration = 'native';
          it.calibrationRms = 0;
          it.closed = it.measureType === 'area' ? g.closedCount > 0 : it.closed;
          it.provenance = { kind: 'dxf-layer', drawing: state.drawing ? state.drawing.name : '', sheetNo: curSheetNo(),
            layer: g.layer, at: new Date().toISOString() };
          n++;
        });
        // 漏項要接成金額保留 —— 在總價裡歸零是系統性低估，比估得不準危險
        state.missed = missed.map((x) => ({ ...x }));
        renderAll(); persist();
        setTimeout(() => openTakeoffReport(n, missed), 60);
      },
    }], (body) => {
      body.addEventListener('change', (e) => {
        const cb = e.target.closest('[data-lv]'); if (!cb) return;
        v.layerVisible[cb.dataset.lv] = cb.checked; v.render();
      });
    });
}

/**
 * 圖層對哪個工項。細節在 layermatch.js，這裡只是把 state.items 餵進去。
 *
 * 原本的作法是「圖層名稱含有 layerHints 的子字串就選它」，有一個安靜的錯：
 * 範本裡 321.01（38mm² 電纜）與 321.02（22mm² 電纜）的 layerHints 都是 E-CABLE-PWR，
 * 它會挑先出現的那一個，把整個圖層的長度算到它頭上，另一個變成 0 ——
 * 而畫面上不會有任何異狀。現在同分會標成「無法分辨」，不自動選。
 */
function matchLayer(layer, g) { return LM.match(layer, state.items, g); }

function layerValueFor(item, g, toM) {
  switch (item.measureType) {
    case 'area': return toM ? g.area * toM * toM : null;
    case 'count': {
      const b = Object.values(g.blocks); return b.length ? b.reduce((a, c) => a + c, 0) : g.count;
    }
    case 'length': return toM ? g.length * toM : null;
    default: return toM ? g.length * toM : null;   // 重量/體積需再乘係數，先給長度供人工換算
  }
}




/* ══════════ 施工工序 ══════════ */

function seqOpts() {
  return {
    projectStart: state.seqStart || new Date(),
    calendar: (state.settings.calendar) || S.DEFAULT_SCHEDULE.calendar,
    siteBufferDays: state.settings.siteBufferDays ?? 3,
    submittalDays: state.settings.submittalDays ?? 14,
    prToPoDays: state.settings.prToPoDays ?? 7,
  };
}

function runSchedule() {
  if (!state.tasks.length) { state.sched = null; return null; }
  // 每次排程都重新對照文件標註可信度 —— 新載入的規範可能讓某些工序從「建議」升級為「圖說可證」
  const annotated = S.annotateConfidence(state.tasks.map((t) => ({ ...t, kind: t.kind || S.kindOf(t.name) })), state.docs);
  state.sched = S.schedule(annotated, seqOpts());
  return state.sched;
}

async function loadSequenceTemplate() {
  if (state.tasks.length && !confirm(`目前已有 ${state.tasks.length} 道工序，載入範本會覆蓋。繼續？`)) return;
  try {
    const r = await fetch('./data/sequence-template.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('載入失敗 ' + r.status);
    const tpl = await r.json();
    state.tasks = tpl.tasks.map((t) => ({ ...t, kind: S.kindOf(t.name), confidence: 'suggested' }));
    if (!state.seqStart) {
      state.seqStart = S.nextWorkday(new Date());
      $('#seqStart').value = state.seqStart;
    }
    state.settings = { ...state.settings, ...(tpl.settings || {}) };
    runSchedule(); renderSeq(); persist();
    dialog('工序範本已載入', `<p>載入 <b>${state.tasks.length}</b> 道工序。</p>
      <p class="chip warn" style="display:block;padding:8px 10px">${esc(tpl.note)}</p>
      <p class="hint">已載入的圖說／規範會被逐條比對：找得到證據的工序標為「圖說可證」並附出處，
      找不到的一律維持「建議工序／需工程確認」。目前有
      <b>${state.sched.tasks.filter((t) => t.confidence === 'drawing').length}</b> 道找到證據。</p>`);
  } catch (e) { dialog('載入失敗', `<p>${esc(e.message)}</p>`); }
}

function cycleGate(code) {
  const t = state.tasks.find((x) => x.code === code);
  if (!t || !t.isGate) return;
  const order = ['unchecked', 'pass', 'fail'];
  t.gateStatus = order[(order.indexOf(t.gateStatus || 'unchecked') + 1) % 3];
  runSchedule(); renderSeq(); persist();
}

function taskById(code) { return (state.sched ? state.sched.tasks : state.tasks).find((t) => t.code === code); }

function confChip(t) {
  const c = S.CONFIDENCE[t.confidence] || S.CONFIDENCE.suggested;
  return `<span class="chip ${c.level === 'ok' ? 'ok' : 'warn'}" title="${esc(t.evidence ? `${t.evidence.doc} L${t.evidence.line}：${t.evidence.text}` : '找不到圖說證據，屬工程慣例推導')}">${esc(c.label)}</span>`;
}

function gateChip(t) {
  if (!t.isGate) return '';
  const g = S.GATE_STATUS[t.gateStatus || 'unchecked'];
  return `<button class="chip ${g.level === 'ok' ? 'ok' : g.level === 'bad' ? 'bad' : ''}" data-gate="${esc(t.code)}" title="點擊切換 未檢查 → Pass → Fail">◆ Gate ${esc(g.label)}</button>`;
}

function renderSeq() {
  const host = $('#seqBody');
  const stat = $('#seqStat');
  if ($('#seqStart') && !$('#seqStart').value && state.seqStart) $('#seqStart').value = state.seqStart;
  if (!state.tasks.length) {
    stat.textContent = '尚未載入工序';
    host.innerHTML = `<div class="hint" style="padding:24px;text-align:center">
      尚未建立施工工序。按上方「載入工序範本」開始，或匯入專案 JSON。<br><br>
      工序回答的不是「什麼時候做」，而是<b>誰卡誰</b>：前置工序、FS/SS 關聯、以及哪些節點沒核准不得往下走（Gate）。<br>
      有了工序，材料的「最晚 PR 日」才能從施工需求反推出來，而不是憑前置期猜。</div>`;
    return;
  }
  const r = state.sched || runSchedule();
  const blocked = S.gateBlocks(r.tasks);
  const g = S.gateSummary(r.tasks);
  const sug = r.tasks.filter((t) => t.confidence !== 'drawing').length;
  stat.innerHTML = `${r.tasks.length} 道 · ${esc(r.projectStart)} → ${esc(r.projectFinish)} · 要徑 ${r.criticalPath.length} · Gate ${g.pass}/${g.total} 通過 · 建議工序 ${sug}`;
  stat.className = 'chip ' + (sug ? 'warn' : 'ok');

  const warn = [];
  if (r.cyclic.length) warn.push(`<p class="chip bad" style="display:block;padding:7px 10px">偵測到迴圈相依：${r.cyclic.map(esc).join('、')} —— 這些工序的日期不可信，請修正前置關係。</p>`);
  if (r.missingPreds.length) warn.push(`<p class="chip warn" style="display:block;padding:7px 10px">${r.missingPreds.length} 筆前置工序不存在：${r.missingPreds.slice(0, 5).map((m) => esc(`${m.task}←${m.pred}`)).join('、')}</p>`);
  if (sug) warn.push(`<p class="chip warn" style="display:block;padding:7px 10px">${sug} 道工序在已載入文件中找不到證據，標示為「建議工序／需工程確認」。<b>這些是工程慣例，不是圖說要求</b>，發包前請工程確認。</p>`);

  host.innerHTML = warn.join('') + ({
    tree: () => renderSeqTree(r, blocked),
    table: () => renderSeqTable(r),
    lane: () => renderSeqLanes(r, blocked),
    mat: () => renderSeqMaterials(r),
  }[state.seqView] || (() => ''))();
}

function renderSeqTree(r, blocked) {
  const nodeByCode = state.nodeByCode;
  return S.buildTree(r.tasks, nodeByCode).map((grp) => `<div class="tgrp">
    <header>${esc(grp.wbs)} · ${esc(grp.name)}<span class="chip">${grp.tasks.length} 道</span></header>
    ${grp.tasks.map((t) => `<div class="trow ${t.critical ? 'crit' : ''} ${blocked.has(t.code) ? 'blocked' : ''}">
      <span class="sq">${esc(t.seq)}</span>
      <span class="nm"><button class="srcbtn" data-task="${esc(t.code)}">${esc(t.name)}</button>
        <span class="chip">${esc((S.TASK_KINDS[t.kind] || S.TASK_KINDS.other).label)}</span>
        ${t.hidden ? '<span class="chip warn">隱蔽</span>' : ''}
        ${gateChip(t)} ${confChip(t)}
        ${blocked.has(t.code) ? `<span class="chip bad">被 ${blocked.get(t.code).map((x) => esc(x.name)).join('、')} 擋住</span>` : ''}</span>
      <span class="dt">${esc(t.es)} → ${esc(t.ef)} · ${t.duration}d${t.critical ? ' · 要徑' : ` · 浮時 ${t.float}d`}</span>
    </div>`).join('')}</div>`).join('');
}

function renderSeqTable(r) {
  const cols = S.TASK_COLUMNS;
  return `<div style="overflow:auto"><table class="seq">
    <thead><tr>${cols.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead>
    <tbody>${r.tasks.map((t) => {
      const row = S.toRow(t, r.tasks, state.items);
      return `<tr class="${t.critical ? 'crit' : ''}">${cols.map((c) => {
        const v = row[c.key];
        const mono = ['seq', 'wbs'].includes(c.key);
        if (c.key === 'name') return `<td><button class="srcbtn" data-task="${esc(t.code)}">${esc(v)}</button></td>`;
        if (c.key === 'confidenceText') return `<td>${confChip(t)}</td>`;
        if (c.key === 'gateText') return `<td>${t.isGate ? gateChip(t) : '否'}</td>`;
        return `<td class="${mono ? 'mono' : ''}">${esc(v)}</td>`;
      }).join('')}</tr>`;
    }).join('')}</tbody></table></div>
    <p class="hint" style="margin-top:8px">這張表是底層資料：能畫出進度、也能反推採購。十六欄對應規格要求，可直接匯出。</p>`;
}

function renderSeqLanes(r, blocked) {
  const sw = S.buildSwimlanes(r.tasks);
  const W = Math.max(760, sw.spanDays * 9);
  const pos = (o, l) => `left:${(o / sw.spanDays) * 100}%;width:${Math.max((l / sw.spanDays) * 100, 1.2)}%`;
  const weeks = [];
  for (let d = 0; d <= sw.spanDays; d += 7) {
    weeks.push(`<span class="tick" style="left:${(d / sw.spanDays) * 100}%">${esc(S.addDays(sw.start, d).slice(5))}</span>`);
  }
  return `<div class="lanewrap">
    <div class="axis"><div class="lname"></div><div class="track" style="min-width:${W}px">${weeks.join('')}</div></div>
    ${sw.lanes.map((ln) => `<div class="lane">
      <div class="lname">${esc(ln.name)}</div>
      <div class="track" style="min-width:${W}px">
        ${ln.tasks.map((t, i) => `<div class="bar ${t.critical ? 'crit' : ''} ${t.isGate ? 'gate' : ''} ${t.confidence !== 'drawing' ? 'sug' : ''}"
          data-task="${esc(t.code)}" style="${pos(t.offset, t.length)};top:${5 + (i % 2) * 22}px"
          title="${esc(`${t.code} ${t.name}｜${t.es} → ${t.ef}｜${t.critical ? '要徑' : `浮時 ${t.float}d`}${blocked.has(t.code) ? '｜被 Gate 擋住' : ''}`)}">
          ${t.isGate ? '◆ ' : ''}${esc(t.name)}</div>`).join('')}
      </div></div>`).join('')}
  </div>
  <p class="hint" style="margin-top:8px">橫向是時間、縱向是工種，一眼看得到<b>誰卡誰</b>。
  紅色為要徑、橘色菱形為 Gate、半透明為「建議工序／需工程確認」。這比普通甘特更適合機電工程 ——
  機電的問題從來不是某一條工序多長，而是介面工種互相等。</p>`;
}

/**
 * 材料需求日整片紅字時，真正要回答的不是「哪幾項遲了」，而是「那我最早能哪天開工」。
 * 用真排程迭代求解，不做線性外插（週末與假日會讓外插偏早，偏早比沒有答案更危險）。
 */
function feasibilityBanner(chains) {
  const late = chains.filter((c) => c.status === 'overdue');
  if (!late.length) return '';
  const f = S.earliestFeasibleStart(state.tasks, state.items, { ...seqOpts(), today: new Date() });
  if (!f) return '';
  const d = f.driver;
  return `<div class="feas ${f.feasible ? '' : 'bad'}">
    <b>${late.length} 項材料的建議 PR 日已經過去了。</b>
    以 ${esc(f.projectStart)} 開工，這張表不是提醒，是「已經來不及」。<br>
    ${f.feasible
      ? `要讓每一項都來得及送審發包，最早可行開工日是 <b>${esc(f.earliestStart)}</b>（往後 ${f.shiftDays} 天）${d ? `，卡在<b>${esc(d.itemName)}</b>（Lead ${d.leadTimeDays} 天）` : ''}。
         <button class="btn sm" id="btnFeasApply" data-start="${esc(f.earliestStart)}">套用為開工日</button>
         <div class="hint" style="margin-top:5px">此日期是用真正的排程迭代 ${f.iterations} 次求得，已把週末與行事曆假日算進去，不是把工作日當日曆日外插。</div>`
      : `即使往後推 ${f.shiftDays} 天仍收斂不了，代表長前置期項目的 Lead 與工期本身相矛盾 —— 要改的是採購策略（分批、預先議價、改替代品），不是開工日。`}
    <div class="hint" style="margin-top:5px">這只是把「不可能」講清楚。實務上壓縮 Lead、先發包長料、或改工序都能省回來，但那是決策，不是這張表能替你做的。</div>
  </div>`;
}

function renderSeqMaterials(r) {
  const chains = S.materialChains(r.tasks, state.items, { ...seqOpts(), today: new Date() });
  if (!chains.length) return '<div class="hint">工序尚未連結任何 BOM 工項。在關聯表的「使用BOM」欄可看到連結狀況。</div>';
  const badge = { overdue: '<span class="chip bad">已逾期</span>', urgent: '<span class="chip warn">急迫</span>', ok: '' };
  const orphans = chains.orphans || [];
  return `${feasibilityBanner(chains)}
    ${orphans.length ? `<p class="chip warn" style="display:block;padding:7px 10px;margin-bottom:10px">
      ${orphans.length} 項材料只被送審工序引用、沒有任何安裝工序會用到它，因此<b>推不出需求日</b>：
      ${orphans.map((o) => esc(o.itemName)).join('、')}。請補上使用它的施工工序，而不是隨便給一個日期。</p>` : ''}
    <table class="mat">
    <thead><tr><th>工項</th><th>使用工序</th><th>工序開始</th><th>需求進場日</th><th>最晚核准日</th><th>最晚送審日</th><th>建議發包日</th><th>建議PR日</th><th>Lead</th><th>狀態</th></tr></thead>
    <tbody>${chains.map((c) => `<tr class="${c.status}">
      <td>${esc(c.itemName)}<div class="hint">${esc(c.itemCode)}</div></td>
      <td>${esc(c.taskName)}<div class="hint">${esc(c.taskCode)}${c.usedBy.length > 1 ? ` 等 ${c.usedBy.length} 道` : ''}</div></td>
      <td class="n">${esc(c.taskStart)}</td><td class="n">${esc(c.needOnSite)}</td>
      <td class="n">${esc(c.approveBy)}</td><td class="n">${esc(c.submitBy)}</td>
      <td class="n">${esc(c.poBy)}</td><td class="n"><b>${esc(c.prBy)}</b></td>
      <td class="n">${c.leadTimeDays}d</td><td>${badge[c.status]}</td></tr>`).join('')}</tbody></table>
    <p class="hint" style="margin-top:10px">反推鏈（日曆日）：
    <code>工序開始 −${seqOpts().siteBufferDays}d = 需求進場 −Lead = 最晚核准 −送審 = 最晚送審／建議發包 −${seqOpts().prToPoDays}d = 建議PR</code><br>
    <b>採購 Lead 從「送審核准後」起算</b>，不是從下單起算 —— 台灣營建實務是先發包、廠商送審、核准後才開始製造。
    把 Lead 從下單起算會讓所有日期早算掉一整個送審週期。</p>
    <p class="hint">同一材料被多道工序使用時，由<b>最早</b>需要它的那道決定 PR 日；晚的那道沒有話語權。</p>`;
}

function openTaskDialog(code) {
  const t = taskById(code);
  if (!t) return;
  const r = state.sched;
  const row = S.toRow(t, r.tasks, state.items);
  const blocked = S.gateBlocks(r.tasks).get(code) || [];
  const chains = (t.bomCodes || []).map((c) => {
    const item = state.items.find((i) => i.code === c);
    return item ? { item, chain: S.procurementChain(t, item, { ...seqOpts(), today: new Date() }) } : null;
  }).filter(Boolean);
  dialog(`${t.code} ${t.name}`, `
    <div style="display:flex;gap:7px;flex-wrap:wrap;margin-bottom:9px">
      <span class="chip">${esc((S.TASK_KINDS[t.kind] || S.TASK_KINDS.other).label)}</span>
      ${t.hidden ? '<span class="chip warn">隱蔽工程</span>' : ''}
      ${t.isGate ? `<span class="chip ${S.GATE_STATUS[t.gateStatus || 'unchecked'].level === 'ok' ? 'ok' : ''}">◆ Gate ${esc(S.GATE_STATUS[t.gateStatus || 'unchecked'].label)}</span>` : ''}
      ${confChip(t)}
      ${t.critical ? '<span class="chip bad">要徑</span>' : `<span class="chip">浮時 ${t.float} 天</span>`}
    </div>
    ${t.evidence ? `<div class="ans">圖說證據：${esc(t.evidence.text)}<div class="hint">${esc(t.evidence.doc)} 第 ${t.evidence.line} 行（命中「${esc(t.evidence.matched)}」）</div></div>`
      : '<p class="chip warn" style="display:block;padding:7px 10px">在已載入文件中找不到這道工序的依據。它來自工程慣例，<b>不是圖說要求</b> —— 發包前請工程確認。</p>'}
    <table class="fac" style="margin-top:10px"><tbody>
      ${S.TASK_COLUMNS.filter((c) => !['name', 'confidenceText', 'gateText'].includes(c.key))
        .map((c) => `<tr><td>${esc(c.label)}</td><td style="text-align:left">${esc(row[c.key] || '—')}</td></tr>`).join('')}
      <tr><td>排程</td><td style="text-align:left">最早 ${esc(t.es)} → ${esc(t.ef)}　最晚 ${esc(t.ls)} → ${esc(t.lf)}</td></tr>
    </tbody></table>
    ${blocked.length ? `<p class="chip bad" style="display:block;padding:7px 10px;margin-top:10px">本工序被未通過的 Gate 擋住：${blocked.map((x) => esc(`${x.code} ${x.name}`)).join('、')}</p>` : ''}
    ${chains.length ? `<h4 style="margin:14px 0 6px">材料採購反推</h4>
      <table class="mat"><thead><tr><th>材料</th><th>需求進場</th><th>最晚核准</th><th>最晚送審</th><th>建議發包</th><th>建議PR</th></tr></thead>
      <tbody>${chains.map(({ item, chain }) => `<tr class="${chain.status}">
        <td>${esc(item.name)}<div class="hint">${esc(item.code)}${Q.isNum(item.qty.manual) || Q.isNum(item.qty.drawing) || Q.isNum(item.qty.boq) ? ` · ${Q.fmt(Q.suggestPurchase(priced(item), state.settings).suggestQty, 2)} ${esc(item.unit)}` : ''}</div></td>
        <td class="n">${esc(chain.needOnSite)}</td><td class="n">${esc(chain.approveBy)}</td>
        <td class="n">${esc(chain.submitBy)}</td><td class="n">${esc(chain.poBy)}</td>
        <td class="n"><b>${esc(chain.prBy)}</b></td></tr>`).join('')}</tbody></table>` : ''}`,
    t.isGate
      ? [{ label: '關閉' }, { label: `切換 Gate 狀態`, primary: true, fn: () => cycleGate(code) }]
      : [{ label: '關閉' }]);
}

function exportSeqCsv() {
  const r = state.sched || runSchedule();
  if (!r) return dialog('沒有工序', '<p>請先載入工序範本。</p>');
  const head = [...S.TASK_COLUMNS.map((c) => c.label), '最早開始', '最早完成', '最晚開始', '最晚完成', '浮時', '要徑', '工期'];
  const rows = r.tasks.map((t) => {
    const row = S.toRow(t, r.tasks, state.items);
    return [...S.TASK_COLUMNS.map((c) => row[c.key]), t.es, t.ef, t.ls, t.lf, t.float, t.critical ? '是' : '', t.duration];
  });
  exportExcel('施工工序', [{ name: '施工工序', rows: [head, ...rows] }]);

  const chains = S.materialChains(r.tasks, state.items, { ...seqOpts(), today: new Date() });
  if (chains.length) {
    const h2 = ['工項代碼', '工項名稱', '單位', '使用工序', '工序開始', '需求進場日', '最晚核准日', '最晚送審日', '建議發包日', '建議PR日', '採購Lead(天)', '送審(天)', '狀態'];
    const r2 = chains.map((c) => [c.itemCode, c.itemName, c.unit, `${c.taskCode} ${c.taskName}`, c.taskStart,
      c.needOnSite, c.approveBy, c.submitBy, c.poBy, c.prBy, c.leadTimeDays, c.submittalDays,
      { overdue: '已逾期', urgent: '急迫', ok: '' }[c.status]]);
    exportExcel('材料需求日', [{ name: '材料需求日', rows: [h2, ...r2] }]);
  }
}

/* ══════════ 風險模擬 ══════════ */

const PCT_ROWS = [0.05, 0.5, 0.8, 0.9, 0.95];

function openDistDialog(code) {
  const it = state.itemByCode.get(code);
  if (!it) return;
  const sim = R.simulateItem(it, state.settings);
  if (!sim) return dialog('無法模擬', '<p>此工項沒有有效的基準量。</p>');
  if (sim.deterministic) {
    return dialog(`${it.name} — 不適用機率模型`, `
      <p>本項為<b>${it.measureType === 'count' ? '計數類' : '統包項'}</b>，沒有損耗分布可言 ——
      6 台配電盤不會「損耗 0.3 台」。這類工項一律按確定量採購。</p>`);
  }
  const d = sim.dist;
  const kind = state.settings.dist || 'pert';
  const cur = levelOf(it);
  const convP = R.percentileOfWaste(it.wasteRate, d, kind);
  const sug = R.suggestServiceLevel(it, state.settings);
  const rows = PCT_ROWS.map((p) => {
    const w = R.DISTS[kind].inv(p, d);
    const q = Q.suggestPurchase({ ...it, wasteRate: w }, state.settings);
    return `<tr class="${Math.abs(p - cur) < 1e-9 ? 'on' : ''}">
      <td>P${Math.round(p * 100)}</td><td class="n">${(w * 100).toFixed(2)}%</td>
      <td class="n">${Q.fmt(q.suggestQty, 2)} ${esc(it.unit)}</td>
      <td class="n">${Q.fmt(q.orderQty, 2)} ${esc(q.orderUnit)}</td>
      <td class="n">${q.cost == null ? '—' : Q.fmt(q.cost, 0)}</td>
      <td><button class="btn sm" data-setsl="${p}">採用</button></td></tr>`;
  }).join('');
  // 直方圖用分位數重建，避免把上萬筆樣本搬進畫面
  const bars = Array.from({ length: 40 }, (_, i) => {
    const a = R.DISTS[kind].inv(i / 40, d), b = R.DISTS[kind].inv((i + 1) / 40, d);
    const h = b > a ? 1 / (b - a) : 0;
    return { h, mid: (a + b) / 2 };
  });
  const hmax = Math.max(...bars.map((x) => x.h)) || 1;
  const curW = R.DISTS[kind].inv(cur, d);

  dialog(`${it.name} — 損耗率分布`, `
    <p class="hint">${esc(it.code)} · 基準量 ${Q.fmt(sim.base, 2)} ${esc(it.unit)} ·
    ${esc(R.DISTS[kind].label)}（${(d.min * 100).toFixed(1)}% / ${(d.mode * 100).toFixed(1)}% / ${(d.max * 100).toFixed(1)}%）
    ${d.source === 'fallback' ? '<span class="chip warn">未設區間，由單點值推得</span>' : ''}</p>
    <div class="hist2">${bars.map((x) => `<i class="${x.mid <= curW ? 'hl' : ''}" style="height:${Math.max(2, (x.h / hmax) * 100)}%"></i>`).join('')}</div>
    <div class="hint" style="display:flex;justify-content:space-between"><span>${(d.min * 100).toFixed(1)}%</span><span>損耗率</span><span>${(d.max * 100).toFixed(1)}%</span></div>
    ${convP != null ? `<p class="chip ${convP < 0.5 ? 'bad' : 'warn'}" style="display:block;padding:8px 10px;margin-top:10px">
      你慣用的單點 ${(it.wasteRate * 100).toFixed(1)}% 相當於 <b>P${Math.round(convP * 100)}</b> ——
      約有 <b>${Math.round((1 - convP) * 100)}%</b> 的機率會不夠。</p>` : ''}
    <table class="pct" style="margin-top:10px">
      <thead><tr><th>服務水準</th><th style="text-align:right">損耗率</th><th style="text-align:right">建議採購量</th><th style="text-align:right">下單量</th><th style="text-align:right">預估金額</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>
    <p class="hint" style="margin-top:10px">系統建議 <b>P${Math.round(sug.p * 100)}</b>：${esc(sug.why)}。
    服務水準是<b>決策</b>不是計算 —— 缺料停工的代價越高就該備越多。這裡不替你決定，只把代價攤開。</p>
    <p class="hint">區間為業界慣例值，不是貴司實證資料。累積 5 筆以上「理論量 vs 實際領用量」即可用實績校準取代。</p>`,
    [{ label: '關閉' }], (body) => {
      body.addEventListener('click', (e) => {
        const b = e.target.closest('[data-setsl]'); if (!b) return;
        it.serviceLevel = parseFloat(b.dataset.setsl);
        $('#dlg').close(); renderAll();
      });
    });
}

/* ══════════ 行情連動 ══════════ */

const IDX_CLASS = { copper: 'cu', aluminium: 'al', steel: 'st', pp: 'ppc' };

function openMarket() {
  const snap = marketSnap();
  if (!snap) {
    return dialog('行情連動', `<p class="chip bad" style="display:block;padding:9px 11px">讀不到行情資料。${esc(state.marketErr || '')}</p>
      <p class="hint">行情是加值資訊，不是必要條件 —— 算量與採購流程不受影響，只是單價不會隨原料浮動。</p>`,
      [{ label: '重試', primary: true, fn: () => loadMarket().then(() => { renderAll(); openMarket(); }) }, { label: '關閉' }]);
  }
  const list = selectedItems();
  // 被閘門鎖住的工項還沒有採購量，因此算不出曝險金額 —— 但它們的曝險是「還沒量到」，不是「沒有」。
  // 讓它們從這張表悄悄消失，就會低估整體曝險，那正是這個模組最不該犯的錯。
  const pending = [];
  const rows = [];
  for (const it of list) {
    const p = priced(it);
    const sp = Q.suggestPurchase(p, state.settings);
    if (!Q.isNum(sp.suggestQty) || sp.suggestQty <= 0) {
      pending.push({ code: it.code, name: it.name, status: sp.status || Q.resolveBasis(it, state.settings).status, unitPrice: it.unitPrice });
      continue;
    }
    rows.push(PR.exposure(withBase(it), sp.suggestQty, snap));
  }
  const port = PR.portfolioExposure(rows);
  const sens = PR.sensitivity(rows, [-0.1, -0.05, 0.05, 0.1]);
  const live = state.market._live;
  const fxRow = (state.market.items || []).find((x) => x.id === 'fx');
  const fxLive = state.market.fxSource && !String(state.market.fxSource).startsWith('manual-fallback');

  dialog('行情連動', `
    ${marketHonesty(live, fxLive)}
    ${marketIndexTable(snap)}
    ${marketBaseBlock(snap)}
    ${list.length ? marketItemTable(rows, snap) + marketPending(pending) + marketExposure(port) + marketSensitivity(sens, port) + marketLockWindows(list)
      : '<p class="hint" style="margin-top:12px">尚未選取工項。選好之後這裡會列出每一項的連動後單價、原料曝險分布與鎖價窗口。</p>'}
  `, [
    { label: state.priceBase ? '重設價格基準日' : '凍結為價格基準日', primary: true, fn: freezePriceBase },
    { label: '關閉' },
  ]);
}

/** 這張表有多少是真的即時，必須先講清楚。 */
function marketHonesty(live, fxLive) {
  const m = state.market;
  return `<div class="feas" style="border-color:var(--line);background:var(--card2)">
    <b>這張行情表有多少是即時的：</b>
    <table class="mkt" style="margin:7px 0">
      <tbody>
        <tr><td>匯率 USD/TWD</td><td>${fxLive ? '<span class="chip ok">每月自 API 抓取</span>' : '<span class="chip warn">備援固定值</span>'}</td>
            <td class="hint">${esc(m.fxSource || '—')}</td></tr>
        <tr><td>銅／鋁／鋼／塑膠粒</td><td><span class="chip warn">人工維護的月更資料</span></td>
            <td class="hint">來源 ${esc(m._url)}${live ? '' : '（離線種子檔）'}</td></tr>
      </tbody>
    </table>
    只有匯率是真正自動抓的。銅鋁鋼 PP 來自每月人工維護的 <code>market-source.json</code> ——
    <b>它們會影響金額，所以過期的代價是實質的</b>。要真正即時，需接 LME／中鋼／台塑的授權資料源。
    <div class="hint" style="margin-top:5px">最近更新：${esc(m.updatedAt || '—')}${m.sourceUpdatedAt ? `　來源時點：${esc(m.sourceUpdatedAt)}` : ''}</div>
  </div>`;
}

function marketIndexTable(snap) {
  const rows = PR.LINKABLE.map((id) => {
    const meta = PR.INDEX_META[id];
    const v = snap.idx[id];
    if (!v) return `<tr class="none"><td>${esc(meta.label)}</td><td colspan="4" class="hint">取不到值</td></tr>`;
    const raw = (state.market.items || []).find((x) => x.id === id) || {};
    const ch = Q.isNum(raw.changePct) ? raw.changePct : null;
    return `<tr><td><span class="gkey"><i class="${IDX_CLASS[id]}"></i>${esc(meta.label)}</span>
        <div class="hint">${esc(meta.src)}</div></td>
      <td class="n">${v.ccy === 'USD' ? 'US$' : 'NT$'} ${Q.fmt(v.quoted, 0)}<div class="hint">/ 公噸</div></td>
      <td class="n">${v.ccy === 'USD' ? `× ${Q.fmt(v.fx, 2)}` : '<span class="hint">台幣報價</span>'}</td>
      <td class="n"><b>NT$ ${Q.fmt(v.twdPerKg, 2)}</b><div class="hint">/ 公斤</div></td>
      <td class="n">${ch == null ? '—' : `<span class="chip ${ch > 0 ? 'bad' : ch < 0 ? 'ok' : ''}">${ch > 0 ? '+' : ''}${ch}%</span>`}</td></tr>`;
  }).join('');
  return `<h4 style="margin:13px 0 6px">指數（一律換算為台幣／公斤）</h4>
    <table class="mkt"><thead><tr><th>指數</th><th class="n">原始報價</th><th class="n">匯率</th><th class="n">台幣單價</th><th class="n">月變動</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <p class="hint" style="margin-top:5px">銅、鋁、塑膠粒報美元，鋼報台幣。<b>漏掉匯率換算，台幣貶值造成的成本上升就會憑空消失</b> ——
    銅漲 10% 而台幣貶 5%，台幣成本是漲 15.5%，不是 10%。</p>`;
}

function marketBaseBlock(snap) {
  if (!state.priceBase) {
    return `<div class="feas" style="margin-top:12px"><b>尚未設定價格基準日，所有連動額為 0。</b><br>
      ${PR.LINK_REASON['no-base']}<br>
      <div class="hint" style="margin-top:5px">很多工具在這裡靜默地拿今天的行情同時當基準與現值，調整額必然是 0，
      然後宣稱自己在跑即時行情。那不是「沒有波動」，是「沒有基準」。按下方「凍結為價格基準日」才會開始計算。</div></div>`;
  }
  const b = state.priceBase;
  const cmp = PR.LINKABLE.filter((id) => b.idx[id] && snap.idx[id]).map((id) => {
    const r = snap.idx[id].twdPerKg / b.idx[id].twdPerKg - 1;
    return `<tr><td>${esc(PR.INDEX_META[id].label)}</td>
      <td class="n">${Q.fmt(b.idx[id].twdPerKg, 2)}</td><td class="n">${Q.fmt(snap.idx[id].twdPerKg, 2)}</td>
      <td class="n"><span class="chip ${r > 0.001 ? 'bad' : r < -0.001 ? 'ok' : ''}">${r >= 0 ? '+' : ''}${(r * 100).toFixed(1)}%</span></td></tr>`;
  }).join('');
  return `<h4 style="margin:13px 0 6px">價格基準日　<span class="chip ok">${esc(String(b.at).slice(0, 10))}</span></h4>
    <table class="mkt"><thead><tr><th>指數</th><th class="n">基準</th><th class="n">現值</th><th class="n">變動</th></tr></thead><tbody>${cmp}</tbody></table>`;
}

function marketItemTable(rows, snap) {
  const body = rows.map((r) => {
    const it = state.itemByCode.get(r.itemCode);
    const lp = PR.linkedPrice(withBase(it), snap);
    const v = PR.validateLink(withBase(it), snap);
    const links = (it.priceLink || []);
    const grades = links.map((l) => {
      const g = PR.LINK_GRADE[l.grade || 'proxy'];
      return `<span class="chip ${g.level === 'ok' ? 'ok' : g.level === 'bad' ? 'bad' : 'warn'}" title="${esc(g.note)}">${esc(PR.INDEX_META[l.index] ? PR.INDEX_META[l.index].label : l.index)} ${esc(g.label)}</span>`;
    }).join(' ');
    const parts = lp.parts.map((p) => `${esc(p.label)} ${(p.share * 100).toFixed(0)}%${p.kg != null ? `（${p.kg} kg/${esc(it.unit)}）` : ''}`).join('、');
    return `<tr class="${r.uncovered ? 'none' : ''}">
      <td>${esc(it.name)}<div class="hint">${esc(it.code)}　${grades || '<span class="chip">未設定連動</span>'}</div></td>
      <td class="n">${Q.fmt(r.qty, 1)} ${esc(it.unit)}</td>
      <td class="n">${Q.fmt(r.basePrice, 2)}</td>
      <td class="n">${lp.linked ? `<b>${Q.fmt(lp.price, 2)}</b>` : '<span class="hint">同左</span>'}</td>
      <td class="n">${lp.linked ? `<span class="chip ${lp.deltaPct > 0.05 ? 'bad' : lp.deltaPct < -0.05 ? 'ok' : ''}">${lp.deltaPct >= 0 ? '+' : ''}${lp.deltaPct.toFixed(2)}%</span>` : '—'}</td>
      <td class="n">${Q.fmt(r.amount, 0)}</td>
      <td>${parts ? `<span class="hint">${esc(parts)}</span>` : (r.uncovered ? '<span class="chip bad">無指數</span>' : '<span class="hint">—</span>')}</td>
    </tr>${v.errs.filter((e) => e.level !== 'info').map((e) => `<tr><td colspan="7"><span class="chip ${e.level === 'bad' ? 'bad' : 'warn'}">${esc(e.msg)}</span></td></tr>`).join('')}`;
  }).join('');
  return `<h4 style="margin:14px 0 6px">已選工項的連動</h4>
    <table class="mkt"><thead><tr><th>工項</th><th class="n">建議採購量</th><th class="n">基準單價</th><th class="n">連動後</th><th class="n">變動</th><th class="n">金額</th><th>原料組成</th></tr></thead>
    <tbody>${body}</tbody></table>`;
}

/** 還沒定量的工項。曝險是「還沒量到」，不是「沒有」—— 必須被看見。 */
function marketPending(pending) {
  if (!pending.length) return '';
  return `<p class="chip warn" style="display:block;padding:8px 10px;margin-top:10px">
    <b>${pending.length} 項因為數量尚未定案，曝險未計入下方統計。</b>
    ${pending.map((p) => `${esc(p.name)}（${esc(p.code)}${p.status === 'blocked' ? '，差異超標鎖定中' : ''}）`).join('、')}
    —— 這些項目的原料曝險是「還沒量到」，不是「沒有」。數量確認後這張表的金額會往上走。</p>`;
}

function marketExposure(port) {
  if (port.amount <= 0) return '';
  const seg = port.by.map((b) => `<i class="${IDX_CLASS[b.id] || 'fix'}" style="width:${(b.amount / port.amount * 100).toFixed(2)}%"></i>`).join('')
    + (port.uncovered > 0 ? `<i class="unc" style="width:${(port.uncovered / port.amount * 100).toFixed(2)}%"></i>` : '')
    + `<i class="fix" style="width:${(Math.max(0, port.fixed) / port.amount * 100).toFixed(2)}%"></i>`;
  const keys = port.by.map((b) => `<span><i class="${IDX_CLASS[b.id] || 'fix'}"></i>${esc(b.label)} NT$ ${Q.fmt(b.amount, 0)}（${b.pct.toFixed(1)}%）</span>`).join('')
    + (port.uncovered > 0 ? `<span><i class="unc"></i>量不出來 NT$ ${Q.fmt(port.uncovered, 0)}（${port.uncoveredPct.toFixed(1)}%）</span>` : '')
    + `<span><i class="fix"></i>加工／運費／毛利 NT$ ${Q.fmt(Math.max(0, port.fixed), 0)}</span>`;
  return `<h4 style="margin:14px 0 6px">原料曝險分布　<span class="hint" style="font-weight:400">總額 NT$ ${Q.fmt(port.amount, 0)}</span></h4>
    <div class="gbar">${seg}</div><div class="gkey">${keys}</div>
    ${port.uncovered > 0 ? `<p class="chip bad" style="display:block;padding:8px 10px;margin-top:9px">
      <b>NT$ ${Q.fmt(port.uncovered, 0)}（${port.uncoveredPct.toFixed(1)}%）的原料曝險這張表量不出來。</b>
      ${port.uncoveredRows.slice(0, 4).map((r) => esc(r.name)).join('、')}${port.uncoveredRows.length > 4 ? ` 等 ${port.uncoveredRows.length} 項` : ''}
      —— 不鏽鋼的價格由鎳與鉻主導，行情表沒有鎳指數。把這些金額算進「固定」會讓總曝險被低估，而低估比高估危險，所以單獨列出。</p>` : ''}`;
}

function marketSensitivity(sens, port) {
  if (!sens.length) return '';
  const head = [-10, -5, 5, 10].map((p) => `<th class="n">${p > 0 ? '+' : ''}${p}%</th>`).join('');
  const body = sens.map((r) => `<tr><td>${esc(r.label)}</td><td class="n">${Q.fmt(r.exposure, 0)}</td>
    ${r.cells.map((c) => `<td class="n"><span class="chip ${c.delta > 0 ? 'bad' : 'ok'}">${c.delta >= 0 ? '+' : '−'}${Q.fmt(Math.abs(c.delta), 0)}</span></td>`).join('')}</tr>`).join('');
  const worst = sens.reduce((a, r) => a + r.exposure * 0.1, 0);
  return `<h4 style="margin:14px 0 6px">敏感度（情境，不是預測）</h4>
    <table class="mkt"><thead><tr><th>指數</th><th class="n">曝險金額</th>${head}</tr></thead><tbody>${body}</tbody></table>
    <p class="hint" style="margin-top:6px">沒有人知道銅價下個月往哪走 —— 這張表也沒有在猜。它回答的是
    <b>「往上走 10% 我要多付多少」</b>：全部指數同時 +10%，這批採購多付 <b>NT$ ${Q.fmt(worst, 0)}</b>
    （佔總額 ${port.amount > 0 ? (worst / port.amount * 100).toFixed(1) : '0'}%）。這個數字可以拿去談鎖價、談調整條款上限。</p>`;
}

function marketLockWindows(list) {
  if (!state.sched) return `<p class="hint" style="margin-top:12px">尚未排施工工序，因此算不出鎖價窗口。
    載入工序後這裡會列出每一項「還剩幾天可以談價」—— 發包當天價格就定了，在那之後行情怎麼走都與這批無關。</p>`;
  const chains = S.materialChains(state.sched.tasks, state.items, { ...seqOpts(), today: new Date() });
  const codes = new Set(list.map((i) => i.code));
  const wins = chains.filter((c) => codes.has(c.itemCode)).map((c) => PR.lockWindow(c)).filter(Boolean)
    .sort((a, b) => a.days - b.days);
  if (!wins.length) return '';
  const badge = { passed: '<span class="chip bad">已過</span>', closing: '<span class="chip warn">即將關閉</span>', open: '<span class="chip ok">開著</span>' };
  return `<h4 style="margin:14px 0 6px">鎖價窗口</h4>
    <table class="mkt"><thead><tr><th>工項</th><th class="n">建議發包日</th><th class="n">還剩</th><th>狀態</th></tr></thead>
    <tbody>${wins.slice(0, 12).map((w) => {
      const it = state.itemByCode.get(w.itemCode);
      return `<tr><td>${esc(it ? it.name : w.itemCode)}</td><td class="n">${esc(w.poBy)}</td>
        <td class="n">${w.days} 天</td><td>${badge[w.state]}</td></tr>`;
    }).join('')}</tbody></table>
    <p class="hint" style="margin-top:6px">窗口關閉＝發包＝價格定案。「要不要現在鎖價」這個問題，只有在窗口還開著時才存在。</p>`;
}

function freezePriceBase() {
  const snap = marketSnap();
  if (!snap) return;
  state.priceBase = snap;
  persist();
  renderAll();
  dialog('價格基準日已設定', `<p>基準時點：<b>${esc(String(snap.at).slice(0, 10))}</b></p>
    <p class="hint">從現在起，單價會依各工項的原料佔比隨行情浮動；不隨行情的部分（加工、運費、毛利）維持不變。
    凍結基準版（Baseline）時會連同這份行情快照一起存 —— 否則行情每天在動，對照基準版就會天天冒出沒有人改過的幽靈差異。</p>`);
}

function openPortfolioSim() {
  const list = selectedItems();
  if (!list.length) return dialog('沒有已選工項', '<p>請先勾選要模擬的工項。</p>');
  if (!state.settings.stochastic) return dialog('機率模式已關閉', '<p>請先到「參數」開啟機率模式。</p>');
  const s = state.settings;
  const run = (rho) => R.simulatePortfolio(list, s, { correlation: rho });
  const r = run(s.correlation);
  if (!r) return dialog('無法模擬', '<p>已選工項都沒有有效的基準量。</p>');
  const indep = run(0);
  const full = run(1);
  const stochN = r.items.filter((x) => x.stochastic).length;

  dialog('整包風險模擬', `
    <p class="hint">${list.length} 項（其中 ${stochN} 項有損耗分布）· ${Q.fmt(r.iterations)} 次模擬 ·
    ${esc(R.DISTS[r.dist].label)} · 相關係數 ρ=${r.correlation} · 種子 ${r.seed}</p>

    <table class="pct" style="margin-top:10px">
      <thead><tr><th>金額分位</th><th style="text-align:right">預估金額</th><th style="text-align:right">較 P50</th></tr></thead>
      <tbody>${PCT_ROWS.map((p) => {
        const k = `p${Math.round(p * 100)}`;
        return `<tr class="${Math.abs(p - (s.serviceLevel ?? 0.8)) < 1e-9 ? 'on' : ''}">
          <td>P${Math.round(p * 100)}</td><td class="n">NT$ ${Q.fmt(r.cost[k], 0)}</td>
          <td class="n">${p === 0.5 ? '—' : (r.cost[k] >= r.cost.p50 ? '+' : '') + Q.fmt(r.cost[k] - r.cost.p50, 0)}</td></tr>`;
      }).join('')}</tbody></table>

    <h4 style="margin:14px 0 6px">兩個容易算錯的地方</h4>
    <table class="pct">
      <tbody>
        <tr><td>各項 P80 直接相加</td><td class="n">NT$ ${Q.fmt(r.sumOfP80, 0)}</td><td class="hint">常見做法</td></tr>
        <tr class="on"><td>整包 P80（正確）</td><td class="n">NT$ ${Q.fmt(r.portfolioP80, 0)}</td><td class="hint">同時全部用到悲觀值的機率極低</td></tr>
        <tr><td><b>分散效益</b></td><td class="n"><b>NT$ ${Q.fmt(r.diversification, 0)}</b></td><td class="hint">相加會多抓這麼多</td></tr>
      </tbody></table>
    <table class="pct" style="margin-top:10px">
      <tbody>
        <tr><td>ρ=0（各項獨立）</td><td class="n">NT$ ${Q.fmt(indep.cost.p80, 0)}</td><td class="hint">會低估風險</td></tr>
        <tr class="on"><td>ρ=${r.correlation}（本案設定）</td><td class="n">NT$ ${Q.fmt(r.cost.p80, 0)}</td><td class="hint">同工班／同工法的正相關</td></tr>
        <tr><td>ρ=1（完全同步）</td><td class="n">NT$ ${Q.fmt(full.cost.p80, 0)}</td><td class="hint">等同各項 P80 相加</td></tr>
      </tbody></table>
    <p class="hint" style="margin-top:10px">
      <b>各項 P80 相加不等於整包 P80。</b> 每一項都同時走到悲觀值的機率極低，所以整包的 P80 比較低 ——
      這筆差額就是分散效益。但若把各項當成完全獨立（ρ=0），又會反過來低估風險，因為同一個工班在同一個工地，
      損耗是會一起變差的。ρ 預設 0.3 是保守的折衷，可在參數調整。</p>
    <p class="hint">收斂指標 ${(r.convergence * 100).toFixed(2)}%（前後半樣本的 P80 差異）。
      ${r.convergence > 0.02 ? '<b style="color:var(--warn)">超過 2%，建議提高迭代次數。</b>' : '低於 2%，迭代次數足夠。'}</p>`,
    [{ label: '關閉' }, { label: '匯出模擬 Excel', fn: () => exportSimCsv(r) }]);
}

function exportSimCsv(r) {
  const head = ['工項代碼', '名稱', '單位', '基準量', '是否機率', 'P5', 'P50', 'P80', 'P90', 'P95', '平均', '標準差'];
  const lines = [
    [`模擬參數,迭代 ${r.iterations},分布 ${r.dist},相關係數 ${r.correlation},種子 ${r.seed}`],
    [`整包金額,P50 ${r.cost.p50},P80 ${r.cost.p80},P90 ${r.cost.p90},各項P80相加 ${r.sumOfP80},分散效益 ${r.diversification}`],
    [],
    head,
    ...r.items.map((x) => [x.code, x.name, x.unit, x.base, x.stochastic ? '是' : '否',
      x.qty.p5, x.qty.p50, x.qty.p80, x.qty.p90, x.qty.p95, x.qty.mean, x.qty.sd]),
  ];
  exportExcel('風險模擬', [{ name: '風險模擬', rows: lines }]);
}

/* ══════════ 基準版 / 請購單 ══════════ */

function pkgItems(pkg) { return pkg.itemCodes.map((c) => state.itemByCode.get(c)).filter(Boolean); }

/** 某採購包最新的基準版。 */
function latestBaseline(pkgCode) {
  return state.baselines.filter((b) => b.packageCode === pkgCode).sort((a, b) => b.rev - a.rev)[0] || null;
}

/** 工項 → 所屬最新基準版的差異（給清單上的標記用）。 */
function baselineDiffIndex() {
  const idx = new Map();
  for (const pkg of state.packages) {
    const bl = latestBaseline(pkg.code);
    if (!bl) continue;
    const d = B.diffAgainstBaseline(pricedAll(pkgItems(pkg)), bl, state.settings);
    for (const ch of d.changed) idx.set(ch.code, { bl, fields: ch.fields });
  }
  return idx;
}

function renderBaselines() {
  const host = $('#baselines');
  $('#blCount').textContent = String(state.baselines.length);
  if (!state.baselines.length) {
    host.innerHTML = '<div class="hint" style="padding:14px 12px;text-align:center">尚無基準版。採購包經工程確認後可凍結為 Baseline，再由它產生請購單。</div>';
    return;
  }
  const byId = new Map(state.baselines.map((b) => [b.id, b]));
  host.innerHTML = state.baselines.slice().reverse().map((bl) => {
    const pkg = state.packages.find((p) => p.code === bl.packageCode);
    const d = pkg ? B.diffAgainstBaseline(pricedAll(pkgItems(pkg)), bl, state.settings) : null;
    const isLatest = latestBaseline(bl.packageCode) === bl;
    const prs = state.prs.filter((p) => p.baselineId === bl.id);
    return `<div class="bl">
      <header>
        <b>${esc(bl.code)}</b><span class="chip">rev ${bl.rev}</span>
        ${isLatest ? '' : '<span class="chip">已被取代</span>'}
        <span class="chip acc">NT$ ${Q.fmt(bl.totals.cost, 0)}</span>
        <span class="spacer" style="flex:1"></span>
        ${d && d.dirty ? `<button class="btn sm" data-bldiff="${esc(bl.id)}">變更 ${d.changed.length + d.added.length + d.removed.length}</button>` : '<span class="chip ok">未異動</span>'}
      </header>
      <div class="body">
        <div class="hint">${esc(bl.packageName || bl.packageCode)} · ${bl.totals.count} 項 · 凍結 ${esc(bl.frozenAt.slice(0, 10))} · 確認 ${esc(bl.confirmedBy)}</div>
        ${bl.note ? `<div class="hint">${esc(bl.note)}</div>` : ''}
        ${d && d.dirty ? `<div class="dirty">較本基準版有 ${d.changed.length} 項異動、${d.added.length} 項新增、${d.removed.length} 項移除；金額差 ${Q.fmt(d.costDelta, 0)}</div>` : ''}
        ${prs.length ? `<div class="hint">請購單：${prs.map((p) => esc(p.no)).join('、')}</div>` : ''}
        <div class="acts">
          <button class="btn sm" data-blview="${esc(bl.id)}">明細</button>
          ${isLatest ? `<button class="btn sm primary" data-blpr="${esc(bl.id)}">產生請購單</button>` : ''}
          ${prs.map((p) => `<button class="btn sm" data-prexp="${esc(p.no)}">匯出 ${esc(p.no)}</button>`).join('')}
        </div>
      </div></div>`;
  }).join('');
  void byId;
}

function openFreeze(pkgIdx) {
  const pkg = state.packages[pkgIdx];
  if (!pkg) return;
  const items = pricedAll(pkgItems(pkg));
  const prev = latestBaseline(pkg.code);
  const d = prev ? B.diffAgainstBaseline(items, prev, state.settings) : null;
  const s = Q.summarize(items, state.settings);
  dialog(`凍結為基準版 — ${esc(pkg.code)}`, `
    <p>將 <b>${items.length}</b> 項、預估 <b>NT$ ${Q.fmt(s.cost, 0)}</b> 凍結為
    ${prev ? `第 <b>${prev.rev + 1}</b> 版（取代 ${esc(prev.code)}）` : '第 <b>1</b> 版'}。</p>
    ${d && d.dirty ? `<p class="chip warn" style="display:block;padding:7px 10px">較 ${esc(prev.code)} 已有 ${d.changed.length} 項異動，金額差 ${Q.fmt(d.costDelta, 0)}。</p>` : ''}
    <div class="fgrid">
      <div><label class="f">工程確認人（必填）</label><input type="text" id="bBy" placeholder="姓名／職稱"></div>
      <div style="grid-column:1/-1"><label class="f">備註</label><input type="text" id="bNote" placeholder="例：依 RFI-001 回覆修正後凍結"></div>
    </div>
    <p class="hint" style="margin-top:10px">凍結<b>不會</b>鎖住資料 —— 之後還是能改。基準版的用途是讓「改了什麼、誰改的、差多少錢」
    無所遁形：凍結後任何異動都會在這張卡片與清單上被標出來。沒有確認人的快照不是基準版，只是一份沒人負責的檔案。</p>`,
    [{ label: '取消' }, {
      label: '凍結', primary: true, fn: () => {
        const r = B.freezeBaseline(pkg, items, state.settings, {
          confirmedBy: $('#bBy').value, note: $('#bNote').value,
          previous: prev, existing: state.baselines,
          priceBase: state.priceBase || marketSnap(),
        });
        if (r.error) return setTimeout(() => dialog('無法凍結', `<p>${esc(r.error)}</p>`), 40);
        state.baselines.push(r.baseline);
        renderAll();
        setTimeout(() => dialog('已凍結', `<p>${esc(r.baseline.code)}（rev ${r.baseline.rev}）已建立，可由它產生請購單。</p>
          ${r.baseline.marketAt ? `<p class="hint">行情快照 ${esc(String(r.baseline.marketAt).slice(0, 10))} 已一併凍結 ——
          之後行情再怎麼動，對照這一版都不會冒出沒有人改過的幽靈差異。</p>`
          : '<p class="chip warn" style="display:block;padding:7px 10px">沒有行情快照可凍結。日後若啟用行情連動，對照這一版會出現無法歸因的單價差異。</p>'}`), 40);
      },
    }]);
}

function openBaselineDetail(id) {
  const bl = state.baselines.find((b) => b.id === id);
  if (!bl) return;
  dialog(`${bl.code} 明細（rev ${bl.rev}）`, `
    <p class="hint">${esc(bl.packageName || bl.packageCode)} · 凍結 ${esc(bl.frozenAt.slice(0, 16).replace('T', ' '))} · 工程確認 ${esc(bl.confirmedBy)}</p>
    <div style="max-height:52vh;overflow:auto"><table class="difftbl">
      <thead><tr><th>工項</th><th>料號</th><th style="text-align:right">建議採購量</th><th style="text-align:right">下單量</th><th style="text-align:right">單價</th><th style="text-align:right">金額</th><th>可信度</th></tr></thead>
      <tbody>${bl.items.map((s) => `<tr>
        <td>${esc(s.name)}<div class="hint">${esc(s.code)} · ${esc(s.spec)}</div></td>
        <td>${s.erpCode ? esc(s.erpCode) : '<span style="color:var(--bad)">缺</span>'}</td>
        <td class="n">${Q.fmt(s.suggestQty, 2)} ${esc(s.unit)}</td>
        <td class="n">${Q.fmt(s.orderQty, 2)} ${esc(s.orderUnit || s.unit)}</td>
        <td class="n">${Q.fmt(s.unitPrice, 2)}</td>
        <td class="n">${Q.fmt(s.cost, 0)}</td>
        <td><span class="chip band${s.band}">${s.band}</span></td></tr>`).join('')}</tbody>
      <tfoot><tr><th colspan="5">合計</th><th class="n">${Q.fmt(bl.totals.cost, 0)}</th><th></th></tr></tfoot>
    </table></div>`);
}

function openBaselineDiff(id) {
  const bl = state.baselines.find((b) => b.id === id);
  const pkg = bl && state.packages.find((p) => p.code === bl.packageCode);
  if (!bl || !pkg) return;
  const d = B.diffAgainstBaseline(pricedAll(pkgItems(pkg)), bl, state.settings);
  const fmtV = (v, kind) => (kind === 'number' ? Q.fmt(v, 2) : esc(String(v ?? '')));
  dialog(`較 ${bl.code} 的變更`, `
    <p>金額差 <b class="${d.costDelta >= 0 ? 'neg' : 'pos'}">${d.costDelta >= 0 ? '+' : ''}${Q.fmt(d.costDelta, 0)}</b></p>
    ${d.changed.length ? `<table class="difftbl"><thead><tr><th>工項</th><th>欄位</th><th style="text-align:right">基準版</th><th style="text-align:right">現在</th><th style="text-align:right">差異</th></tr></thead>
      <tbody>${d.changed.flatMap((ch) => ch.fields.map((f, i) => `<tr>
        <td>${i === 0 ? `${esc(ch.name)}<div class="hint">${esc(ch.code)}</div>` : ''}</td>
        <td>${esc(f.label)}</td>
        <td class="n dl">${fmtV(f.before, f.kind)}</td>
        <td class="n dn">${fmtV(f.after, f.kind)}</td>
        <td class="n ${f.delta > 0 ? 'neg' : f.delta < 0 ? 'pos' : ''}">${f.delta == null ? '—' : (f.delta > 0 ? '+' : '') + Q.fmt(f.delta, 2)}</td></tr>`)).join('')}</tbody></table>` : '<p class="hint">沒有欄位異動。</p>'}
    ${d.added.length ? `<p class="hint" style="margin-top:10px">新增 ${d.added.length} 項：${d.added.map((a) => esc(a.name)).join('、')}</p>` : ''}
    ${d.removed.length ? `<p class="hint">移除 ${d.removed.length} 項：${d.removed.map((a) => esc(a.name)).join('、')}</p>` : ''}
    <p class="hint" style="margin-top:10px">要讓這些變更成為新的採購依據，請重新凍結產生下一版基準版 ——
    每一版都留有誰確認、何時、為什麼。</p>`,
    [{ label: '關閉' }, { label: '重新凍結', primary: true, fn: () => openFreeze(state.packages.indexOf(pkg)) }]);
}

function openCreatePr(id) {
  const bl = state.baselines.find((b) => b.id === id);
  if (!bl) return;
  const ready = B.prReadiness(bl, { requireErpCode: state.settings.requireErpCode });
  const nextNo = B.nextPrNo(state.prs.map((p) => p.no), state.settings.prTemplate, new Date());
  const missHtml = ready.ok ? '' : `
    ${ready.missingCode.length ? `<p class="chip bad" style="display:block;padding:7px 10px">${ready.missingCode.length} 項缺 ERP 料號。ERP 匯入沒有料號一定退件，先補齊：</p>
      <div style="max-height:26vh;overflow:auto;margin:6px 0">${ready.missingCode.map((s) => `<div class="docrow">
        <span class="dn">${esc(s.name)}<span class="hint"> ${esc(s.code)}</span></span>
        <input type="text" data-erp="${esc(s.code)}" placeholder="ERP 料號" style="width:170px"></div>`).join('')}</div>` : ''}
    ${ready.missingPrice.length ? `<p class="chip warn" style="display:block;padding:7px 10px">${ready.missingPrice.length} 項未報價，金額會是空的：${ready.missingPrice.map((s) => esc(s.name)).join('、')}</p>` : ''}`;
  dialog(`產生請購單 — ${esc(bl.code)}`, `
    <p>單號將為 <b>${esc(nextNo)}</b>（樣板 <code>${esc(state.settings.prTemplate)}</code>，
    流水號每${{ day: '日', month: '月', year: '年', never: '（不）' }[B.resetScopeOf(state.settings.prTemplate)]}重置）</p>
    ${missHtml}
    <div class="fgrid">
      <div><label class="f">請購人（必填）</label><input type="text" id="pReq" placeholder="姓名"></div>
      <div><label class="f">部門</label><input type="text" id="pDept" value="${esc(state.settings.dept || '')}"></div>
      <div><label class="f">專案</label><input type="text" id="pProj" value="${esc(state.projName || '')}"></div>
      <div><label class="f">建議供應商</label><input type="text" id="pVend" value="${esc((state.packages.find((p) => p.code === bl.packageCode) || {}).vendor || '')}"></div>
      <div><label class="f">需求日期</label><input type="date" id="pNeed" value="${esc((state.packages.find((p) => p.code === bl.packageCode) || {}).needDate || '')}"></div>
      <div><label class="f">稅率</label><input type="number" id="pTax" step="0.01" value="${state.settings.taxRate}"></div>
    </div>
    <p class="hint" style="margin-top:10px">單價會自動換算到訂購單位 —— 6M/支的管子，單價寫的是每支而不是每公尺，
    否則 ERP 那邊金額會差六倍。</p>`,
    [{ label: '取消' }, {
      label: '產生', primary: true, fn: () => {
        $$('#dlgBody [data-erp]').forEach((inp) => {
          const v = inp.value.trim(); if (!v) return;
          const it = state.itemByCode.get(inp.dataset.erp);
          if (it) it.erpCode = v;
          const sn = bl.items.find((x) => x.code === inp.dataset.erp);
          if (sn) sn.erpCode = v;
        });
        const r = B.createPr(bl, {
          requester: $('#pReq').value, dept: $('#pDept').value, project: $('#pProj').value,
          vendor: $('#pVend').value, needDate: $('#pNeed').value,
          taxRate: parseFloat($('#pTax').value), template: state.settings.prTemplate,
        }, state.prs.map((p) => p.no));
        if (r.error) return setTimeout(() => dialog('無法產生', `<p>${esc(r.error)}</p>`), 40);
        state.prs.push(r.pr);
        renderAll();
        setTimeout(() => openExportPr(r.pr.no), 60);
      },
    }]);
}

function openExportPr(no) {
  const pr = state.prs.find((p) => p.no === no);
  if (!pr) return;
  const prof = state.settings.erpProfile || 'generic';
  dialog(`請購單 ${esc(pr.no)}`, `
    <div class="hint">${esc(pr.packageName || pr.packageCode)} · 基準版 ${esc(pr.baselineCode)} · 請購人 ${esc(pr.requester)}${pr.needDate ? ` · 需求日 ${esc(pr.needDate)}` : ''}</div>
    <div class="totrow" style="margin-top:8px"><span>未稅</span><b>NT$ ${Q.fmt(pr.subtotal, 0)}</b></div>
    <div class="totrow"><span>稅額（${(pr.taxRate * 100).toFixed(0)}%）</span><b>NT$ ${Q.fmt(pr.tax, 0)}</b></div>
    <div class="totrow"><span>含稅合計</span><b>NT$ ${Q.fmt(pr.total, 0)}</b></div>
    <div style="max-height:34vh;overflow:auto;margin-top:10px"><table class="difftbl">
      <thead><tr><th>#</th><th>料號</th><th>品名規格</th><th style="text-align:right">數量</th><th>單位</th><th style="text-align:right">單價</th><th style="text-align:right">金額</th></tr></thead>
      <tbody>${pr.lines.map((l) => `<tr><td>${l.seq}</td><td>${esc(l.erpCode) || '<span style="color:var(--bad)">缺</span>'}</td>
        <td>${esc(l.name)}<div class="hint">${esc(l.spec)}</div></td>
        <td class="n">${Q.fmt(l.qty, 2)}</td><td>${esc(l.unit)}</td>
        <td class="n">${Q.fmt(l.unitPrice, 2)}</td><td class="n">${Q.fmt(l.amount, 0)}</td></tr>`).join('')}</tbody></table></div>
    <h4 style="margin:14px 0 6px">匯入 ERP</h4>
    <div class="fgrid">
      <div><label class="f">檔案格式</label><select id="eProf">${Object.values(B.ERP_PROFILES).map((p) => `<option value="${p.key}" ${prof === p.key ? 'selected' : ''}>${p.label}</option>`).join('')}</select></div>
      <div style="align-self:end"><button class="btn" id="eMap">設定欄位對映</button></div>
    </div>
    <p class="hint" style="margin-top:10px">本工具不綁任何一套 ERP：中性資料模型 + 可設定的欄位對映。
    把對方的欄位名稱填進對映表，匯出的 Excel 表頭就會用那個名字，可直接餵進去。</p>`,
    [{ label: '關閉' },
      { label: '轉發包單 (PO)', fn: () => setTimeout(() => openCreatePo(pr.no), 60) },
      { label: '下載 Excel', primary: true, fn: () => downloadPr(pr.no, $('#eProf') ? $('#eProf').value : prof) }],
    (body) => {
      body.querySelector('#eProf').onchange = (e) => { state.settings.erpProfile = e.target.value; persist(); };
      body.querySelector('#eMap').onclick = () => { $('#dlg').close(); setTimeout(() => openErpMapping(pr.no), 60); };
    });
}

function openErpMapping(no) {
  const m = state.settings.erpMapping || { header: {}, line: {} };
  const row = (kind, f) => `<div class="docrow">
    <span class="dn" style="width:130px">${esc(f.label)}</span>
    <span class="hint" style="width:110px"><code>${esc(f.key)}</code></span>
    <input type="text" data-map="${kind}:${esc(f.key)}" value="${esc((m[kind] || {})[f.key] || '')}" placeholder="${esc(f.label)}"></div>`;
  dialog('ERP 欄位對映', `
    <p class="hint">留白＝沿用左邊的中文欄名。填入你們 ERP 匯入範本的欄位名稱（例如 <code>PURCH_NO</code>、<code>ITEM_NO</code>），
    匯出的 Excel 表頭就會用那個名字。</p>
    <h4 style="margin:12px 0 6px">表頭</h4>
    <div style="max-height:24vh;overflow:auto;display:grid;gap:5px">${B.PR_HEADER_FIELDS.map((f) => row('header', f)).join('')}</div>
    <h4 style="margin:12px 0 6px">明細</h4>
    <div style="max-height:24vh;overflow:auto;display:grid;gap:5px">${B.PR_LINE_FIELDS.map((f) => row('line', f)).join('')}</div>`,
    [{ label: '取消' }, {
      label: '儲存', primary: true, fn: () => {
        const next = { header: {}, line: {} };
        $$('#dlgBody [data-map]').forEach((inp) => {
          const [kind, key] = inp.dataset.map.split(':');
          const v = inp.value.trim();
          if (v) next[kind][key] = v;
        });
        state.settings.erpMapping = next;
        persist();
        setTimeout(() => openExportPr(no), 60);
      },
    }]);
}

function downloadPr(no, profile) {
  const pr = state.prs.find((p) => p.no === no);
  if (!pr) return;
  const { files } = B.toErpTables(pr, profile || state.settings.erpProfile, state.settings.erpMapping || {});
  // 表頭與明細改成同一個活頁簿的兩張工作表 —— ERP 匯入要的是兩張表，
  // 但使用者要的是一個檔。兩者不衝突。
  exportExcel(`請購單-${no}`, files.map((f) => ({
    name: f.name.replace(/\.csv$/i, '').replace(/^.*?[-_]/, '') || f.name,
    rows: f.rows,
  })));
}

/* ══════════ 對話框 ══════════ */

/**
 * 全站只有一個 <dialog> 元素，換內容就是換世代。
 *
 * 這個計數器是為了修一個踩過三次的錯：按鈕的 fn() 如果自己開了新對話框，
 * 舊的 close() 會緊接著執行，把剛開的那個一起關掉 —— 畫面上就是「按了沒反應」。
 * 所以關閉要帶世代號：世代已經往前跑了，代表內容已經被別人換掉，這個關閉就作廢。
 */
let dlgGen = 0;

/** 只關掉「當時那一個」對話框；若內容已被換成別的，就什麼都不做。 */
function dlgClose(gen) { if (gen === undefined || gen === dlgGen) $('#dlg').close(); }

function dialog(title, html, buttons = [{ label: '關閉' }], onBody) {
  const d = $('#dlg');
  const gen = ++dlgGen;
  $('#dlgTitle').textContent = title;
  $('#dlgBody').innerHTML = html;
  const foot = $('#dlgFoot');
  foot.innerHTML = '';
  (buttons.length ? buttons : [{ label: '關閉' }]).forEach((b) => {
    const el = document.createElement('button');
    el.className = 'btn' + (b.primary ? ' primary' : '');
    el.textContent = b.label;
    el.onclick = () => { if (b.fn) b.fn(); dlgClose(gen); };
    foot.appendChild(el);
  });
  if (onBody) onBody($('#dlgBody'), gen);
  if (!d.open) d.showModal();
  return gen;
}

function openSourceDialog(code) {
  const it = state.itemByCode.get(code);
  const res = Q.resolveBasis(it, state.settings);
  const pay = Q.paymentImpact(it, state.settings);
  const wd = R.wasteDistOf(it, state.settings);
  const rows = Q.BASIS_PRIORITY.map((k) => {
    const meta = Q.SOURCE_META[k];
    const v = it.qty[k];
    const editable = k === 'manual' || k === 'vendor' || k === 'boq' || k === 'drawing';
    return `<tr>
      <td><label style="display:flex;gap:6px;align-items:center">
        <input type="radio" name="basis" value="${k}" ${res.basis === k ? 'checked' : ''} ${Q.isNum(v) ? '' : 'disabled'} style="width:auto">
        ${esc(meta.label)}${Q.INDEPENDENT_SOURCES.includes(k) ? '' : ' <span class="chip">非獨立</span>'}</label></td>
      <td class="num">${editable ? `<input class="num" type="number" step="0.01" data-q="${k}" value="${v ?? ''}" style="width:120px">` : Q.fmt(v, 2)}</td>
      <td class="hint">${esc(sourceNote(it, k))}</td>
    </tr>`;
  }).join('');
  dialog(`數量來源 — ${it.name}`, `
    <p class="hint">${esc(it.code)} · ${esc(it.spec || '')} · 單位 ${esc(it.unit)}</p>
    <table class="fac"><thead><tr><td>來源</td><td style="text-align:right">數量</td><td>備註</td></tr></thead><tbody>${rows}</tbody></table>
    <div class="fgrid" style="margin-top:12px">
      <div><label class="f">人工確認 — 簽核人</label><input type="text" id="mBy" value="${esc(it.manualBy || '')}" placeholder="姓名／職稱"></div>
      <div><label class="f">人工確認 — 理由</label><input type="text" id="mNote" value="${esc(it.manualNote || '')}" placeholder="為什麼改這個數字"></div>
      <div><label class="f">損耗率 最可能</label><input type="number" id="mWaste" step="0.005" min="0" value="${it.wasteRate ?? state.settings.defaultWasteRate}"></div>
      <div><label class="f">損耗率 樂觀</label><input type="number" id="mWmin" step="0.005" min="0" value="${wd.min}"></div>
      <div><label class="f">損耗率 悲觀</label><input type="number" id="mWmax" step="0.005" min="0" value="${wd.max}"></div>
      <div><label class="f">服務水準</label><select id="mSl">
        ${[0.5, 0.8, 0.85, 0.9, 0.95].map((v) => `<option value="${v}" ${Math.abs(levelOf(it) - v) < 1e-9 ? 'selected' : ''}>P${Math.round(v * 100)}</option>`).join('')}
        <option value="" ${Q.isNum(it.serviceLevel) ? '' : 'selected'}>沿用預設 P${Math.round((state.settings.serviceLevel ?? 0.8) * 100)}</option>
      </select></div>
      <div><label class="f">單價 (NT$/${esc(it.unit)})</label><input type="number" id="mPrice" step="0.01" value="${it.unitPrice ?? ''}"></div>
      <div><label class="f">訂購單位</label><input type="text" id="oUnit" value="${esc(it.order.unit || it.unit)}"></div>
      <div><label class="f">每訂購單位含量 (${esc(it.unit)})</label><input type="number" id="oFactor" step="0.001" value="${it.order.unitFactor ?? 1}"></div>
      <div><label class="f">包裝倍數</label><input type="number" id="oPack" step="1" min="1" value="${it.order.packMultiple ?? 1}"></div>
      <div><label class="f">MOQ（訂購單位）</label><input type="number" id="oMoq" step="1" min="0" value="${it.order.moq ?? 0}"></div>
      <div><label class="f">ERP 料號</label><input type="text" id="mErp" value="${esc(it.erpCode || '')}" placeholder="請購單匯入 ERP 必填"></div>
    </div>
    <p class="hint" style="margin-top:10px">合約型態 <b>${esc(Q.CONTRACT_TYPES[state.settings.contractType === 'lumpsum' ? 'lumpsum' : 'remeasure'].label)}</b> 下的計價影響：
    <b class="pay ${pay.level}" style="display:inline">${esc(pay.label)}</b> — ${esc(pay.note)}</p>
    <p class="hint" style="margin-top:10px">目前判定：<b>${esc(res.rule)}</b>。
    人工確認會覆蓋所有自動判定，因此<b>必須</b>填簽核人與理由 —— 沒有理由的覆寫在爭議時等同沒有依據。</p>`,
    [{ label: '取消' }, {
      label: '儲存', primary: true, fn: () => {
        $$('#dlgBody [data-q]').forEach((inp) => {
          const k = inp.dataset.q;
          const v = inp.value.trim() === '' ? null : parseFloat(inp.value);
          it.qty[k] = Number.isFinite(v) ? v : null;
        });
        const picked = $('#dlgBody input[name=basis]:checked');
        it.basisOverride = picked ? picked.value : undefined;
        it.manualBy = $('#mBy').value.trim();
        it.manualNote = $('#mNote').value.trim();
        const w = parseFloat($('#mWaste').value); it.wasteRate = Number.isFinite(w) ? w : it.wasteRate;
        const lo = parseFloat($('#mWmin').value), hi = parseFloat($('#mWmax').value);
        if (Number.isFinite(lo) && Number.isFinite(hi) && hi >= lo) it.wasteDist = { min: lo, mode: it.wasteRate, max: hi };
        const sl = $('#mSl').value;
        if (sl === '') delete it.serviceLevel; else it.serviceLevel = parseFloat(sl);
        const pr = parseFloat($('#mPrice').value); it.unitPrice = Number.isFinite(pr) ? pr : null;
        it.erpCode = $('#mErp').value.trim();
        it.order = {
          unit: $('#oUnit').value.trim() || it.unit,
          unitFactor: parseFloat($('#oFactor').value) || 1,
          packMultiple: parseFloat($('#oPack').value) || 1,
          moq: parseFloat($('#oMoq').value) || 0,
        };
        renderAll();
      },
    }]);
}

function sourceNote(it, k) {
  if (k === 'drawing') {
    const p = it.provenance;
    if (!p) return it.drawingSource === 'auto' ? '圖層自動彙總' : '未連結圖面';
    const base = SH.provenanceLabel({ ...p, sheetNo: provSheet(p) });
    return it.drawingStale ? `${base}（此圖已改版，本數量為舊版）` : base;
  }
  if (k === 'manual') return it.manualNote || '（未填理由）';
  if (k === 'boq') return '契約／標單數量';
  if (k === 'vendor') return '供應商回覆數量';
  if (k === 'history') return '歷史專案類比，僅供參考';
  return '';
}

function openConfidenceDialog(code) {
  const it = state.itemByCode.get(code);
  const c = Q.confidence(it, { settings: state.settings });
  const rows = c.factors.map((f) => `<tr><td>${esc(f.label)}<div class="hint">${esc(f.note || '')}</div></td>
    <td class="${f.delta >= 0 ? 'pos' : 'neg'}">${f.delta >= 0 ? '+' : ''}${f.delta}</td></tr>`).join('');
  dialog(`可信度 ${c.band}（${c.score}） — ${it.name}`, `
    <table class="fac"><tbody>${rows}<tr><td><b>合計</b></td><td><b>${c.score}</b></td></tr></tbody></table>
    <p class="hint" style="margin-top:10px"><b>這是可稽核的啟發式評分，不是統計信賴區間。</b>
    分數只回答「這個數字的證據鏈有多完整」，不保證誤差落在某個範圍。等級門檻：A ≥85、B ≥70、C ≥55、D &lt;55；
    低於 <b>${esc(state.settings.gateBand)}</b> 的項目不得轉採購包。對照 AACE 18R-97 的估價分級精神：
    證據等級決定可承諾的精度，不是反過來。</p>`);
}

function openSettings() {
  const s = state.settings;
  dialog('參數設定', `
    <div class="fgrid">
      <div><label class="f">差異容忍（≤ 直接採圖面量）</label><input type="number" id="sWarn" step="0.005" min="0" value="${s.varianceWarn}"></div>
      <div><label class="f">差異上限（&gt; 鎖定待人工確認）</label><input type="number" id="sStop" step="0.005" min="0" value="${s.varianceStop}"></div>
      <div><label class="f">預設損耗率</label><input type="number" id="sWaste" step="0.005" min="0" value="${s.defaultWasteRate}"></div>
      <div><label class="f">轉採購最低可信度</label><select id="sGate">${['A', 'B', 'C', 'D'].map((b) => `<option ${s.gateBand === b ? 'selected' : ''}>${b}</option>`).join('')}</select></div>
      <div><label class="f">合約型態</label><select id="sContract">${Object.values(Q.CONTRACT_TYPES).map((c) => `<option value="${c.key}" ${s.contractType === c.key ? 'selected' : ''}>${c.label}</option>`).join('')}</select></div>
      <div><label class="f">換圖時的圖面量</label><select id="sClearDraw">
        <option value="keep" ${s.clearOnDrawingChange === 'keep' ? 'selected' : ''}>保留</option>
        <option value="prev" ${(s.clearOnDrawingChange || 'prev') === 'prev' ? 'selected' : ''}>清除上一張圖產生的（預設）</option>
        <option value="all" ${s.clearOnDrawingChange === 'all' ? 'selected' : ''}>清除全部圖面量</option>
      </select></div>
      <div><label class="f">RFI 擋採購的嚴重度</label><select id="sRfiGate">
        <option value="high" ${(s.rfiBlockSeverity || 'high') === 'high' ? 'selected' : ''}>高（預設）</option>
        <option value="med" ${s.rfiBlockSeverity === 'med' ? 'selected' : ''}>中以上</option>
        <option value="none" ${s.rfiBlockSeverity === 'none' ? 'selected' : ''}>不擋</option>
      </select></div>
    </div>
    <p class="hint" style="margin-top:8px">RFI 若不擋採購，它就只是裝飾品。預設「高」表示：有未結案的高嚴重度 RFI 的工項，
    不得轉採購包。改成「不擋」等於宣告你願意在問題未釐清前就下單。</p>
    <p class="hint" style="margin-top:8px">合約型態不影響任何數量計算，只改變差異的<b>解讀</b>：實作實算下多出來的量是可請領的增量，
    總價承攬下同一個數字是承包商要吸收的成本。這一欄決定你看到的是機會還是風險。</p>
    <p class="hint" style="margin-top:10px">門檻是風險偏好的具體化：把 3% 調到 8%，等於宣告「圖面與標單差 8% 以內都不必解釋」。
    這個數字最終要由誰承擔差異的責任來決定，不是由方便決定。</p>
    <h4 style="margin:14px 0 6px">損耗率機率模型</h4>
    <div class="fgrid">
      <div><label class="f">機率模式</label><select id="sStoch">
        <option value="1" ${s.stochastic !== false ? 'selected' : ''}>開啟（P50/P80）</option>
        <option value="0" ${s.stochastic === false ? 'selected' : ''}>關閉（單點損耗率）</option></select></div>
      <div><label class="f">分布</label><select id="sDist">${Object.values(R.DISTS).map((x) => `<option value="${x.key}" ${(s.dist || 'pert') === x.key ? 'selected' : ''}>${x.label}</option>`).join('')}</select></div>
      <div><label class="f">預設服務水準</label><select id="sSl">${[0.5, 0.8, 0.85, 0.9, 0.95].map((v) => `<option value="${v}" ${Math.abs((s.serviceLevel ?? 0.8) - v) < 1e-9 ? 'selected' : ''}>P${Math.round(v * 100)}</option>`).join('')}</select></div>
      <div><label class="f">相關係數 ρ</label><input type="number" id="sRho" step="0.05" min="0" max="1" value="${s.correlation ?? 0.3}"></div>
      <div><label class="f">模擬次數</label><input type="number" id="sIter" step="1000" min="500" value="${s.iterations ?? 10000}"></div>
      <div><label class="f">亂數種子</label><input type="number" id="sSeed" step="1" value="${s.seed ?? 20260913}"></div>
    </div>
    <p class="hint" style="margin-top:8px">關閉機率模式就回到單點損耗率 —— 你現有報表的 1,751 是這樣算出來的。
    ρ 是同工班／同工法造成的正相關：設 0 會低估整包風險，設 1 等於各項分位數直接相加。
    種子固定才能重現 —— 採購數字不能每按一次就變。</p>
    <h4 style="margin:14px 0 6px">請購單與 ERP</h4>
    <div class="fgrid">
      <div><label class="f">PR 編號樣板</label><input type="text" id="sPrTpl" value="${esc(s.prTemplate || B.DEFAULT_PR_TEMPLATE)}"></div>
      <div><label class="f">稅率</label><input type="number" id="sTax" step="0.01" value="${s.taxRate ?? 0.05}"></div>
      <div><label class="f">請購部門</label><input type="text" id="sDept" value="${esc(s.dept || '')}"></div>
      <div><label class="f">匯出時必須有 ERP 料號</label><select id="sReqErp">
        <option value="1" ${s.requireErpCode !== false ? 'selected' : ''}>是（建議）</option>
        <option value="0" ${s.requireErpCode === false ? 'selected' : ''}>否</option></select></div>
    </div>
    <p class="hint" style="margin-top:8px">樣板可用 <code>{YYYY} {YY} {MM} {DD} {SEQ:n}</code>。
    流水號的重置範圍由樣板自動推導：有 <code>{DD}</code> 就每日重置、只有 <code>{MM}</code> 就每月重置 ——
    避免「編碼到日、流水號卻全年連續」這種自相矛盾。</p>
    <h4 style="margin:14px 0 6px">專案資料</h4>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn" id="sExportProj">匯出專案 JSON</button>
      <button class="btn" id="sImportProj">匯入專案 JSON</button>
      <button class="btn" id="sReset">重置為範本</button>
    </div>
    <p class="hint" style="margin-top:6px"><b>重置為範本會清掉全部</b> —— 圖面量、BOQ 量、人工確認、採購包、
    基準版與已產生的請購單，全部回到剛開啟的狀態，且無法復原。
    只是要換一張圖或清掉某一張圖的量，用圖面量測工具列的「清除／更新」，那一顆不會動到其他來源。</p>`,
    [{ label: '取消' }, {
      label: '套用', primary: true, fn: () => {
        s.varianceWarn = parseFloat($('#sWarn').value) || 0;
        s.varianceStop = parseFloat($('#sStop').value) || 0;
        s.defaultWasteRate = parseFloat($('#sWaste').value) || 0;
        s.gateBand = $('#sGate').value;
        s.contractType = $('#sContract').value;
        s.rfiBlockSeverity = $('#sRfiGate').value;
        s.clearOnDrawingChange = $('#sClearDraw').value;
        s.prTemplate = $('#sPrTpl').value.trim() || B.DEFAULT_PR_TEMPLATE;
        const tx = parseFloat($('#sTax').value); s.taxRate = Number.isFinite(tx) ? tx : 0.05;
        s.dept = $('#sDept').value.trim();
        s.requireErpCode = $('#sReqErp').value === '1';
        s.stochastic = $('#sStoch').value === '1';
        s.dist = $('#sDist').value;
        s.serviceLevel = parseFloat($('#sSl').value);
        const rho = parseFloat($('#sRho').value); s.correlation = Number.isFinite(rho) ? Math.min(Math.max(rho, 0), 1) : 0.3;
        const it2 = parseInt($('#sIter').value, 10); s.iterations = Number.isFinite(it2) && it2 >= 500 ? it2 : 10000;
        const sd = parseInt($('#sSeed').value, 10); s.seed = Number.isFinite(sd) ? sd : 20260913;
        if (state.analysis) runAnalysis();
        renderAll();
      },
    }], (body, gen) => {
      body.querySelector('#sExportProj').onclick = () => { exportProject(); dlgClose(gen); };
      body.querySelector('#sImportProj').onclick = () => { $('#fileProject').click(); dlgClose(gen); };
      body.querySelector('#sReset').onclick = () => {
        if (!confirm('清除所有本機修改，回到範本狀態？\n\n包含：圖面量、BOQ 量、人工確認、採購包、基準版、請購單。\n此動作無法復原。')) return;
        try { localStorage.removeItem(LS_KEY); } catch { /* 無 localStorage 時直接重載 */ }
        location.reload();
      };
    });
}

function openHelp() {
  dialog('操作說明與方法論', `
    <h4>流程</h4>
    <ol style="margin:0 0 10px 18px;padding:0">
      <li>載入圖面（DXF／PDF 直接讀；DWG 需轉檔，見下）。</li>
      <li>設定比例：DXF 讀 <code>$INSUNITS</code>；PDF 必須先做校正。</li>
      <li>量測（長度／面積／矩形／計數／角度）或用「圖層自動抓量」。</li>
      <li>指派量測到工項 → 成為<b>圖面量</b>，與 <b>BOQ 量</b>比對出差異。</li>
      <li>差異超標的項目會被鎖定，必須人工確認並留下簽核人與理由。</li>
      <li>套損耗率得<b>建議採購量</b>，再依訂購單位／包裝倍數／MOQ 算<b>下單量</b>。</li>
      <li>勾選 → 右欄 → 轉採購 Package → 匯出 RFQ Excel。</li>
    </ol>
    <h4>快捷鍵</h4>
    <p><span class="k">Enter</span>／雙擊／右鍵 結束量測 · <span class="k">Esc</span> 取消 · <span class="k">Backspace</span> 退一點 ·
    <span class="k">S</span> 吸附 · <span class="k">O</span> 正交 · <span class="k">F</span> 全覽 · 滾輪縮放 · 拖曳平移</p>
    <h4>DWG</h4>
    <p>DWG 是封閉格式。本工具不內嵌任何 DWG 解析器，改採「程序外轉檔」：自建
    ODA File Converter／LibreDWG 服務並設定 <code>DWG_CONVERT_URL</code>，圖面不出公司。
    詳見 <code>docs/TAKEOFF.md</code>。</p>
    <h4>這個工具不做什麼</h4>
    <p>不取代 BIM 模型算量、不做鋼筋翻樣、不自動判讀掃描圖上的文字標註、不宣稱量測結果可直接作為契約數量。
    它做的是：把「圖面量 / BOQ 量 / 人工確認」三條線攤開比對，讓每一筆採購量都有可稽核的來源。</p>`);
}

/* ══════════ 採購包與匯出 ══════════ */

function toPackage() {
  const list = selectedItems();
  if (!list.length) return dialog('沒有已選工項', '<p>請先勾選要打包的工項。</p>');
  const blockMap = rfiBlockMap();
  const ok = [], bad = [];
  for (const it of list) {
    const p = Q.suggestPurchase(priced(it), state.settings);
    const c = Q.confidence(it, { settings: state.settings, basis: p.basis });
    const rfiWhy = blockMap.get(it.code);
    (p.blocked || !Q.bandAtLeast(c.band, state.settings.gateBand) || rfiWhy)
      ? bad.push([it, c, p, rfiWhy]) : ok.push(it);
  }
  const badHtml = bad.length ? `<p class="chip bad" style="display:block;padding:8px 10px">${bad.length} 項未達門檻，不會納入本包：</p>
    <ul style="margin:6px 0 10px 18px;padding:0">${bad.map(([it, c, p, why]) => `<li>${esc(it.name)} — ${esc(why || (p.blocked ? p.basis.rule : `可信度 ${c.band} 低於門檻 ${state.settings.gateBand}`))}</li>`).join('')}</ul>` : '';
  dialog('轉採購 Package', `
    ${badHtml}
    <p>將 <b>${ok.length}</b> 項納入新採購包。</p>
    <div class="fgrid">
      <div><label class="f">包代碼</label><input type="text" id="pCode" value="PKG-${String(state.packages.length + 1).padStart(3, '0')}"></div>
      <div><label class="f">包名稱</label><input type="text" id="pName" value="${esc(suggestPkgName(ok))}"></div>
      <div><label class="f">供應商／分包</label><input type="text" id="pVendor" placeholder="未定"></div>
      <div><label class="f">需求到貨日</label><input type="date" id="pDate" value="${suggestNeedDate(ok)}"></div>
    </div>
    <p class="hint">需求到貨日預設 = 今天 + 最長前置期 + 7 天緩衝。前置期是採購包能不能拆的關鍵：
    把 120 天的配電盤跟 14 天的 PVC 管綁在同一包，等於讓整包被最慢的品項綁架。</p>`,
    [{ label: '取消' }, {
      label: '建立', primary: true, fn: () => {
        if (!ok.length) return;
        state.packages.push({
          code: $('#pCode').value.trim() || `PKG-${state.packages.length + 1}`,
          name: $('#pName').value.trim(), vendor: $('#pVendor').value.trim(),
          needDate: $('#pDate').value, itemCodes: ok.map((i) => i.code), createdAt: new Date().toISOString(),
        });
        renderAll();
      },
    }]);
}

/**
 * 自動建議拆包：依前置期分桶 × 供應商分組，長前置排最前。
 * 只是「建議」—— 使用者逐包勾選確認才會建立，不做無聲的批次動作。
 */
function autoPackage() {
  const list = selectedItems();
  if (!list.length) return dialog('沒有已選工項', '<p>請先勾選要打包的工項，或在左側勾選整個分類。</p>');
  const r = Q.suggestPackages(pricedAll(list), state.settings, { blocked: rfiBlockMap() });
  if (!r.packages.length) {
    return dialog('無法建議拆包', `<p>已選的 ${list.length} 項全部未達門檻，沒有可打包的工項。</p>
      <ul style="margin:6px 0 0 18px;padding:0">${r.excluded.map((e) => `<li>${esc(e.name)} — ${esc(e.reason)}</li>`).join('')}</ul>`);
  }
  const cards = r.packages.map((p, i) => {
    const items = p.itemCodes.map((c) => state.itemByCode.get(c)).filter(Boolean);
    return `<div class="sugpkg">
      <input type="checkbox" data-sp="${i}" checked style="width:auto;margin-top:3px">
      <div class="g">
        <b>${esc(p.code)}</b> · ${esc(p.name)}
        <div class="hint">${items.length} 項 · 預估 NT$ ${Q.fmt(p.cost, 0)} · 建議到貨 ${esc(p.needDate)}</div>
        <div class="hint">${esc(p.reason)}</div>
        <div class="hint" style="margin-top:3px">${items.map((x) => `${esc(x.name)}(${x.leadTimeDays || 0}天)`).join('、')}</div>
      </div></div>`;
  }).join('');
  const exHtml = r.excluded.length ? `<p class="chip bad" style="display:block;padding:7px 10px;margin-top:10px">
    ${r.excluded.length} 項未達門檻，不會納入任何包：</p>
    <ul style="margin:6px 0 0 18px;padding:0">${r.excluded.map((e) => `<li class="hint">${esc(e.name)} — ${esc(e.reason)}</li>`).join('')}</ul>` : '';
  dialog('自動建議拆包', `
    <p class="hint">分組原則：<b>前置期分桶 × 供應商</b>。一個包的交期等於包裡最慢那一項，
    所以前置期差一個量級的東西不同包；長前置（要徑物料）排在最前面，提醒你先發包。</p>
    ${cards}${exHtml}`,
    [{ label: '取消' }, {
      label: '建立勾選的包', primary: true, fn: () => {
        let n = 0;
        $$('#dlgBody [data-sp]').forEach((cb) => {
          if (!cb.checked) return;
          const p = r.packages[+cb.dataset.sp];
          state.packages.push({
            code: p.code, name: p.name, vendor: p.vendor, needDate: p.needDate,
            itemCodes: p.itemCodes, createdAt: new Date().toISOString(), auto: true, reason: p.reason,
          });
          n++;
        });
        renderAll();
        if (n) setTimeout(() => dialog('已建立', `<p>建立 ${n} 個採購包。每包都可以再改名稱、供應商與到貨日。</p>`), 60);
      },
    }]);
}

function suggestPkgName(items) {
  if (!items.length) return '採購包';
  const tops = new Set(items.map((i) => String(i.wbs).split('.')[0]));
  const names = [...tops].map((c) => (state.nodeByCode.get(c) || {}).name).filter(Boolean);
  return names.join('＋') + ' 採購包';
}

function suggestNeedDate(items) {
  const lead = items.reduce((a, i) => Math.max(a, i.leadTimeDays || 0), 0);
  const d = new Date(Date.now() + (lead + 7) * 86400000);
  return d.toISOString().slice(0, 10);
}

/**
 * 嘗試讓瀏覽器存檔。
 *
 * 有些宿主環境（嵌在 iframe 裡的檢視器、內嵌瀏覽器）會把頁面自己發起的下載
 * 一律擋掉，而且**擋掉時不會拋錯**，點了就是沒反應。所以這裡永遠不假設成功，
 * 一律另外提供「複製貼進 Excel」這條不依賴下載的路。
 */
function tryDownload(name, blob) {
  try {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    return true;
  } catch (e) { console.warn('下載被擋', e); return false; }
}

/** 這個頁面是不是被嵌在別人的框裡 —— 嵌著就很可能下載會被擋。 */
function isEmbedded() {
  try { return window.self !== window.top; } catch { return true; }
}

/**
 * 匯出範圍摘要 —— 回答「這一份到底匯了什麼」。
 *
 * 原本畫面上只寫「已產生 BOQ-全部…30 筆資料」，沒有一個字說明「全部」是指什麼。
 * 使用者問的正是這個：全部圖面的工項？還是單張圖面的工項？
 *
 * 答案是**都不是**：匯出的是**本專案 BOM 的工項**，
 * 而這些工項的圖面量可能來自**好幾張不同的圖**，也可能根本沒有圖面量
 * （數量來自 BOQ、人工確認或計算式）。
 *
 * 這個函式把那件事算出來：幾筆有圖面量、分別來自哪幾張圖、幾筆沒有。
 * 匯出的是一份要寄出去、要拿去對帳的檔案 —— 它涵蓋什麼，必須寫在臉上。
 */
function exportScope(items, label) {
  const byDrawing = new Map();
  let noDrawing = 0, stale = 0, noProv = 0;
  for (const it of items) {
    if (!Q.isNum(it.qty && it.qty.drawing)) { noDrawing++; continue; }
    const d = (it.provenance && it.provenance.drawing) || '';
    if (!d) { noProv++; continue; }
    byDrawing.set(d, (byDrawing.get(d) || 0) + 1);
    if (it.drawingStale) stale++;
  }
  return {
    label, total: items.length,
    drawings: [...byDrawing.entries()].map(([name, n]) => ({ name, n, sheetNo: sheetNoFor(name) })).sort((a, b) => b.n - a.n),
    withDrawing: items.length - noDrawing - noProv,
    noDrawing, noProv, stale,
    current: state.drawing ? state.drawing.name : null,
  };
}

/** 把範圍摘要畫成一段人話。 */
function scopeHtml(sc) {
  if (!sc) return '';
  const many = sc.drawings.length > 1;
  return `
    <div style="border:1px solid var(--line);border-radius:9px;padding:10px 12px;margin:10px 0">
      <div style="font-weight:700;margin-bottom:6px">匯出範圍</div>
      <div class="totrow"><span>${esc(sc.label)}</span><b>${sc.total} 個工項</b></div>
      <p class="hint" style="margin:6px 0 0"><b>這是工項清單，不是「某一張圖的清單」。</b>
        同一份清單裡的圖面量可能來自不同張圖，也可能根本不是從圖上量的。</p>

      ${sc.drawings.length ? `<table class="mat" style="margin-top:8px">
        <thead><tr><th>圖號</th><th>圖面量的出處</th><th class="n">工項數</th></tr></thead><tbody>
        ${sc.drawings.map((d) => `<tr>
          <td>${d.sheetNo ? `<b>${esc(d.sheetNo)}</b>` : '<span class="chip warn">未設圖號</span>'}</td>
          <td>${esc(d.name)}${sc.current === d.name ? ' <span class="chip acc">目前載入</span>' : ''}</td>
          <td class="n">${d.n}</td></tr>`).join('')}
        ${sc.noProv ? `<tr><td></td><td class="hint">有圖面量但沒記錄出處</td><td class="n">${sc.noProv}</td></tr>` : ''}
        ${sc.noDrawing ? `<tr><td></td><td class="hint">沒有圖面量（數量來自 BOQ／人工確認／計算式）</td><td class="n">${sc.noDrawing}</td></tr>` : ''}
        </tbody></table>
        ${sc.drawings.some((d) => !d.sheetNo) ? `<p class="hint" style="margin-top:6px">
          標「未設圖號」的圖，匯出檔的<b>圖號欄會是空白</b> —— 圖號不在檔案裡，程式從檔名推不出來時不會硬湊一個。
          要補：載入那張圖，按工具列上的圖號膠囊填進去。</p>` : ''}`
    : `<p class="chip warn" style="display:block;padding:8px 10px;margin-top:8px;white-space:normal">
        這 ${sc.total} 個工項<b>都沒有圖面量</b> —— 數量來自 BOQ、人工確認或計算式，不是從圖上量出來的。</p>`}

      ${many ? `<p class="chip acc" style="display:block;padding:8px 10px;margin-top:8px;white-space:normal">
        這份清單橫跨 <b>${sc.drawings.length} 張圖</b>。若你要的是「單張圖的工項」，
        請先在清單上用搜尋或勾選縮小範圍，再用「清單上<b>已勾選</b>的工項 Excel」那一顆。</p>` : ''}

      ${sc.current && !sc.drawings.some((d) => d.name === sc.current) ? `
        <p class="hint" style="margin-top:8px">目前載入的是《${esc(sc.current)}》，但這份匯出裡<b>沒有</b>任何一筆數量來自它
        —— 匯出的範圍與「現在打開哪張圖」無關。</p>` : ''}

      ${sc.stale ? `<p class="chip bad" style="display:block;padding:8px 10px;margin-top:8px;white-space:normal">
        其中 <b>${sc.stale}</b> 筆的圖面量標記為<b>舊版</b>（該圖已改版，數量還是上一版算的）。
        這份檔案匯出去之前請先處理。</p>` : ''}
    </div>`;
}

/**
 * 匯出 Excel。這是全站唯一的匯出出口。
 *
 * 為什麼不是 CSV：CSV 沒有編碼欄位，Excel 只能拿系統碼頁去猜，
 * 繁體中文 Windows 會猜成 Big5，UTF-8 的中文就全變亂碼 ——
 * 加 BOM 有時有效、有時被當成資料。.xlsx 內部是 UTF-8 XML，編碼不用猜。
 * 而且一個檔可以放多張工作表，不必把清單、採購包、工序拆成好幾個檔。
 *
 * sheets = [{ name, rows }]，第一列是表頭。
 */
function exportExcel(baseName, sheets, opts = {}) {
  const list = (sheets || []).filter((x) => x && x.rows && x.rows.length);
  if (!list.length) return dialog('沒有資料', '<p>這次匯出沒有任何內容。</p>');
  const prepared = list.map((x) => ({ ...x, widths: x.widths || XL.autoWidths(x.rows) }));
  const file = `${baseName}-${new Date().toISOString().slice(0, 10)}.xlsx`;
  let bytes;
  try { bytes = XL.build(prepared); }
  catch (e) { return dialog('匯出失敗', `<p>${esc(e.message)}</p>`); }
  const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const embedded = isEmbedded();
  if (!embedded) tryDownload(file, blob);

  const total = prepared.reduce((a, x) => a + x.rows.length - 1, 0);
  const tsv = prepared.length === 1 ? XL.toTsv(prepared[0].rows) : '';
  dialog('匯出 Excel', `
    <p>已產生 <b>${esc(file)}</b>　${prepared.length} 張工作表、${total} 筆資料。</p>
    ${scopeHtml(opts.scope)}
    <table class="mkt" style="margin:8px 0"><thead><tr><th>工作表</th><th class="n">筆數</th><th class="n">欄數</th></tr></thead>
      <tbody>${prepared.map((x) => `<tr><td>${esc(x.name)}</td><td class="n">${x.rows.length - 1}</td>
        <td class="n">${Math.max(...x.rows.map((r) => r.length))}</td></tr>`).join('')}</tbody></table>
    ${embedded ? `<p class="chip warn" style="display:block;padding:8px 10px;white-space:normal">
      這個頁面是嵌在別的視窗裡開的，該環境通常會擋掉網頁自己發起的下載（點了沒反應）。
      按下面的「下載」還是可以試；若真的沒反應，改用下面的複製貼上 —— 那條路不需要下載權限。</p>` : ''}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
      <button class="btn primary" id="xDl">下載 ${esc(file)}</button>
      ${tsv ? '<button class="btn" id="xCopy">複製（可直接貼進 Excel）</button>' : ''}
    </div>
    ${tsv ? `<label class="f" style="margin-top:10px;display:block">或全選這裡複製，貼到 Excel 的 A1</label>
      <textarea id="xTsv" readonly spellcheck="false" style="width:100%;height:160px;font-family:var(--mono);font-size:11.5px;white-space:pre;overflow:auto">${esc(tsv)}</textarea>
      <p class="hint">貼上的是 TSV（欄位以 Tab 分隔）—— Excel 會自動分欄，而且不經過任何編碼猜測，中文不會變亂碼。</p>`
      : '<p class="hint">多張工作表只能用下載取得；單張工作表才提供複製貼上。</p>'}`,
    [{ label: '關閉' }], (body) => {
      body.querySelector('#xDl').onclick = () => {
        if (!tryDownload(file, blob)) {
          setTimeout(() => dialog('下載被環境擋下', '<p>這個環境不允許網頁自己發起下載。請改用「複製（可直接貼進 Excel）」。</p>'), 40);
        }
      };
      const cp = body.querySelector('#xCopy');
      if (cp) cp.onclick = async () => {
        const ta = body.querySelector('#xTsv');
        try {
          await navigator.clipboard.writeText(tsv);
          cp.textContent = '已複製 ✓';
          setTimeout(() => { cp.textContent = '複製（可直接貼進 Excel）'; }, 2000);
        } catch {
          ta.focus(); ta.select();
          cp.textContent = '已選取，請按 Ctrl+C';
        }
      };
    });
}

/** JSON 專案檔仍走純下載 —— 它不是給人看的，貼上沒有意義。 */
function download(name, text, mime = 'application/json') {
  const blob = new Blob([text], { type: mime });
  if (!tryDownload(name, blob)) {
    dialog('下載被環境擋下', `<p>這個環境不允許網頁自己發起下載，無法儲存 <b>${esc(name)}</b>。</p>
      <p class="hint">請改在自己的伺服器上開這個工具，或用「匯出 Excel」那條路。</p>`);
  }
}

function itemRow(it) {
  const p = Q.suggestPurchase(priced(it), state.settings);
  const c = Q.confidence(it, { settings: state.settings, basis: p.basis });
  const v = Q.variance(it.qty.drawing, it.qty.boq);
  const pay = Q.paymentImpact(it, state.settings);
  return [
    it.wbs, it.code, it.name, it.spec, it.unit,
    it.qty.drawing, it.qty.boq, v ? v.abs : '', v ? (v.pct * 100).toFixed(2) + '%' : '',
    it.qty.manual, p.basis.basis ? Q.SOURCE_META[p.basis.basis].label : '待確認', p.basis.status, p.basis.rule,
    c.score, c.band, it.wasteRate ?? state.settings.defaultWasteRate,
    p.suggestQty, p.orderQty, p.orderUnit, p.deliveredQty, it.unitPrice, p.cost,
    pay.label, pay.note, it.leadTimeDays, it.manualBy, it.manualNote,
    provSheet(it.provenance),
    it.provenance ? SH.provenanceLabel({ ...it.provenance, sheetNo: provSheet(it.provenance) }) : '',
  ];
}

const CSV_HEAD = ['WBS', '工項代碼', '名稱', '規格', '單位', '圖面量', 'BOQ量', '差異量', '差異率', '人工確認',
  '正式採購基準', '狀態', '判定規則', '可信度分數', '可信度等級', '損耗率', '建議採購量', '下單量', '訂購單位',
  '到貨量', '單價', '預估金額', '計價影響', '計價說明', '前置期(天)', '簽核人', '確認理由', '圖號', '數量出處'];

function openExport() {
  dialog('匯出', `
    <div style="display:grid;gap:8px">
      <button class="btn" id="eAll">本專案<b>全部工項</b> Excel（跨所有圖面）</button>
      <button class="btn" id="eSel">清單上<b>已勾選</b>的工項 Excel</button>
      <button class="btn" id="ePkg">所有採購包 RFQ Excel（一包一張工作表）</button>
      <button class="btn" id="eJson">專案 JSON（含來源與簽核紀錄）</button>
    </div>
    <p class="chip acc" style="display:block;padding:8px 10px;margin-top:10px;white-space:normal">
    這裡匯出的是 <b>BOM 工項清單</b>，不是「某一張圖的清單」。
    工具的 BOM 橫跨整個專案，同一份清單裡的圖面量可能來自好幾張圖，
    也可能根本不是從圖上量的（BOQ／人工確認／計算式）。
    <b>要匯出單張圖的工項，請先在清單上勾選那些工項，再用「已勾選」那一顆。</b>
    每次匯出都會列出這一份的數量分別來自哪幾張圖。</p>
    <p class="hint" style="margin-top:10px">匯出的是 .xlsx，內部是 UTF-8 XML，Excel 不需要猜編碼，中文不會亂碼
    （CSV 沒有編碼欄位，繁中 Windows 會猜成 Big5，這是過去亂碼的來源）。
    匯出檔保留「判定規則、簽核人、確認理由、數量出處」四欄 —— 這四欄才是稽核時真正被問的東西。</p>`,
    [{ label: '關閉' }], (body, gen) => {
      body.querySelector('#eAll').onclick = () => { exportCsv(state.items, 'BOQ-全部', '本專案 BOM 的全部工項'); dlgClose(gen); };
      body.querySelector('#eSel').onclick = () => { exportCsv(selectedItems(), 'BOQ-已選', '清單上已勾選的工項'); dlgClose(gen); };
      body.querySelector('#ePkg').onclick = () => { exportAllPackages(); dlgClose(gen); };
      body.querySelector('#eJson').onclick = () => { exportProject(); dlgClose(gen); };
    });
}

function exportCsv(items, name, scopeLabel) {
  if (!items.length) return dialog('沒有資料', '<p>清單是空的。</p>');
  exportExcel(name, [{ name: '工程量清單', rows: [CSV_HEAD, ...items.map(itemRow)] }],
    { scope: exportScope(items, scopeLabel || '本次匯出') });
}

/** 單一採購包的詢價單列 —— 抬頭三列 + 空列 + 表頭 + 明細。 */
function packageRows(pkg) {
  const items = pkg.itemCodes.map((c) => state.itemByCode.get(c)).filter(Boolean);
  return [
    ['採購包', pkg.code, pkg.name || ''],
    ['供應商', pkg.vendor || '未定'],
    ['需求到貨日', pkg.needDate || ''],
    [],
    CSV_HEAD, ...items.map(itemRow),
  ];
}

function exportPackageCsv(pkg) {
  const items = pkg.itemCodes.map((c) => state.itemByCode.get(c)).filter(Boolean);
  exportExcel(`RFQ-${pkg.code}`, [{ name: '詢價單', rows: packageRows(pkg) }],
    { scope: exportScope(items, `採購包 ${pkg.code}${pkg.name ? ' ' + pkg.name : ''} 的工項`) });
}

/**
 * 全部採購包匯出成**一個**活頁簿，一個包一張工作表。
 *
 * 不是每個包各下載一個檔：瀏覽器對連續多次下載本來就會擋，
 * 而且採購真正要的是「一次寄給不同廠商前先自己核對過」，分成十個檔只會更難核。
 * 工作表名稱用採購包代碼，重名時 safeSheetName 會自動加序號。
 */
function exportAllPackages() {
  if (!state.packages.length) return dialog('沒有資料', '<p>目前沒有任何採購包。</p>');
  const used = new Set();
  const sheets = state.packages.map((pkg) => ({
    name: XL.safeSheetName(pkg.code || pkg.name || '採購包', used),
    rows: packageRows(pkg),
  }));
  const all = state.packages.flatMap((pkg) => pkg.itemCodes.map((c) => state.itemByCode.get(c)).filter(Boolean));
  exportExcel('RFQ-全部採購包', sheets, { scope: exportScope(all, `全部 ${state.packages.length} 個採購包的工項`) });
}

function exportProject() {
  const data = {
    exportedAt: new Date().toISOString(),
    template: state.template.name,
    settings: state.settings,
    items: state.items,
    packages: state.packages,
    vendors: state.vendors,
    pos: state.pos,
    rfiLog: state.rfiLog,
    baselines: state.baselines,
    prs: state.prs,
    tasks: state.tasks,
    selected: [...state.selected],
  };
  download(`takeoff-project-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2));
}

async function importProject(file) {
  try {
    const d = JSON.parse(await file.text());
    if (!Array.isArray(d.items)) throw new Error('缺少 items');
    for (const s of d.items) {
      const it = state.itemByCode.get(s.code);
      if (it) Object.assign(it, s);
    }
    state.packages = d.packages || [];
    state.selected = new Set(d.selected || []);
    state.settings = { ...state.settings, ...(d.settings || {}) };
    state.rfiLog = d.rfiLog || state.rfiLog;
    state.baselines = d.baselines || state.baselines;
    state.prs = d.prs || state.prs;
    state.tasks = d.tasks || state.tasks;
    state.priceBase = d.priceBase || state.priceBase;
    renderAll();
    dialog('匯入完成', `<p>已載入 ${d.items.length} 筆工項狀態。</p>`);
  } catch (e) { dialog('匯入失敗', `<p>${esc(e.message)}</p>`); }
}

/** BOQ CSV 匯入：容忍欄位順序，靠表頭關鍵字對位。 */
async function importBoqCsv(file) {
  const text = await file.text();
  const rows = parseCsv(text);
  if (rows.length < 2) return dialog('匯入失敗', '<p>CSV 內容不足。</p>');
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const find = (...keys) => head.findIndex((h) => keys.some((k) => h.includes(k)));
  const ci = find('代碼', 'code', '項次');
  const qi = find('boq', '數量', 'qty', 'quantity');
  const pi = find('單價', 'price');
  if (ci < 0 || qi < 0) {
    return dialog('無法辨識欄位', `<p>需要「工項代碼」與「BOQ量」兩欄。偵測到的表頭：</p><p class="k">${esc(rows[0].join(' | '))}</p>`);
  }
  let hit = 0, miss = [];
  for (const r of rows.slice(1)) {
    const code = (r[ci] || '').trim();
    const it = state.itemByCode.get(code);
    if (!it) { if (code) miss.push(code); continue; }
    const q = parseFloat(String(r[qi]).replace(/,/g, ''));
    if (Number.isFinite(q)) { it.qty.boq = q; hit++; }
    if (pi >= 0) { const p = parseFloat(String(r[pi]).replace(/,/g, '')); if (Number.isFinite(p)) it.unitPrice = p; }
  }
  renderAll();
  dialog('BOQ 匯入完成', `<p>更新 ${hit} 筆。</p>${miss.length ? `<p class="hint">找不到對應工項代碼 ${miss.length} 筆：${esc(miss.slice(0, 12).join('、'))}${miss.length > 12 ? '…' : ''}</p>` : ''}`);
}

/** 最小可用的 CSV 解析（支援引號、逸出引號、CRLF）。 */
function parseCsv(text) {
  const out = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); out.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); out.push(row); }
  return out.filter((r) => r.some((c) => String(c).trim() !== ''));
}


/* ══════════ 解析中心 ══════════ */

const SCOPE_TOPS = () => state.nodes.filter((n) => !n.parent);

function renderScope() {
  const box = $('#scopeBox');
  const all = state.scope.length === 0;
  box.innerHTML = `<label class="${all ? 'on' : ''}"><input type="checkbox" data-scope="__all" ${all ? 'checked' : ''}> 全工程</label>`
    + SCOPE_TOPS().map((n) => {
      const on = state.scope.includes(n.code);
      return `<label class="${on ? 'on' : ''}"><input type="checkbox" data-scope="${esc(n.code)}" ${on ? 'checked' : ''}> ${esc(n.code)} ${esc(n.name)}</label>`;
    }).join('');
}

function onScopeChange(e) {
  const cb = e.target.closest('[data-scope]');
  if (!cb) return;
  if (cb.dataset.scope === '__all') state.scope = [];
  else {
    const c = cb.dataset.scope;
    if (cb.checked) state.scope = [...new Set([...state.scope, c])];
    else state.scope = state.scope.filter((x) => x !== c);
  }
  renderScope(); persist();
}

function renderDocs() {
  const host = $('#docList');
  if (!state.docs.length) {
    host.innerHTML = '<div class="hint">尚未載入任何文件。沒有文件就沒有解析結果 —— 這個工具不會憑空生出百分比。</div>';
    return;
  }
  host.innerHTML = state.docs.map((d) => {
    const k = A.DOC_KINDS[d.kind];
    const sheet = d.kind === 'drawing'
      ? `<select data-docsheet="${esc(d.id)}">${Object.values(A.SHEET_TYPES).map((t) => `<option value="${t.key}" ${d.sheetType === t.key ? 'selected' : ''}>${t.label}</option>`).join('')}</select>`
      : '';
    const stat = [
      d.pages ? `${d.pages} 頁` : '',
      d.entities ? `${d.entities} 實體` : '',
      d.rows ? `${d.rows} 列` : '',
      d.text ? `${Q.fmt(d.text.length)} 字` : '<span style="color:var(--warn)">無可讀文字</span>',
      d.scaleSet ? '<span style="color:var(--ok)">已設比例</span>' : (d.kind === 'drawing' ? '<span style="color:var(--warn)">未設比例</span>' : ''),
    ].filter(Boolean).join(' · ');
    return `<div class="docrow">
      <span class="chip acc">${esc(k ? k.label : d.kind)}</span>
      <span class="dn" title="${esc(d.name)}">${esc(d.name)}</span>
      ${sheet}
      <span class="hint">${stat}</span>
      ${d.viewable ? `<button class="btn sm" data-docopen="${esc(d.id)}">開啟量測</button>` : ''}
      <button class="btn sm" data-docdel="${esc(d.id)}">移除</button>
    </div>`;
  }).join('');
}

/** 讀進一份文件並抽出可比對的文字。抽不到文字就照實標示，不假裝解析成功。 */
async function ingestDoc(file, kind) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const id = 'd' + Math.random().toString(36).slice(2, 9);
  const doc = { id, kind, name: file.name, sheetType: A.guessSheetType(file.name), at: new Date().toISOString(), text: '' };
  $('#analyzeHint').textContent = `讀取 ${file.name}…`;
  try {
    if (ext === 'pdf') {
      const r = await readPdf(file);
      doc.text = r.text; doc.pages = r.pages;
      if (kind === 'drawing') { doc.viewable = true; doc._file = file; }
    } else if (ext === 'dxf' || ext === 'dwg') {
      const parsed = ext === 'dxf' ? await parseDxfFile(file) : await convertAndParseDwg(file);
      doc.text = dxfText(parsed);
      doc.entities = parsed.entities.length;
      doc.viewable = true; doc._doc = parsed; doc._file = file;
      doc.scaleSet = !!(parsed.units && parsed.units.toM);
    } else {
      const text = await file.text();
      doc.text = text;
      doc.rows = text.split(/\r?\n/).filter((l) => l.trim()).length;
      if (kind === 'boq') await applyBoqText(text, doc);
    }
  } catch (err) {
    doc.error = err.message;
    dialog('文件讀取失敗', `<p>${esc(file.name)}：${esc(err.message)}</p>
      <p class="hint">仍會保留在清單中並標示為無法解析 —— 讓你看得到缺口，而不是安靜跳過。</p>`);
  }
  state.docs.push(doc);
  renderDocs(); persist();
  $('#analyzeHint').textContent = '已載入 ' + state.docs.length + ' 份文件，可以開始解析。';
  return doc;
}

async function readPdf(file) {
  const pdfjs = await loadPdfjs();
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const cap = Math.min(pdf.numPages, 80);
  const chunks = [];
  for (let i = 1; i <= cap; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    let lastY = null; let line = [];
    const lines = [];
    for (const it of tc.items) {
      const y = it.transform ? Math.round(it.transform[5]) : 0;
      if (lastY !== null && Math.abs(y - lastY) > 2) { lines.push(line.join(' ')); line = []; }
      line.push(it.str); lastY = y;
    }
    if (line.length) lines.push(line.join(' '));
    chunks.push(`--- ${file.name} p.${i} ---\n` + lines.join('\n'));
  }
  return { text: chunks.join('\n'), pages: pdf.numPages, capped: cap < pdf.numPages };
}

let _pdfjs = null;
async function loadPdfjs() {
  if (_pdfjs) return _pdfjs;
  const m = await import('../../vendor/pdfjs/pdf.min.mjs');
  m.GlobalWorkerOptions.workerSrc = new URL('../../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  _pdfjs = m;
  return m;
}

async function parseDxfFile(file) {
  const buf = await file.arrayBuffer();
  if (DXF.isBinaryDxf(buf)) throw new Error('二進位 DXF，請在 CAD 另存為 ASCII DXF');
  const doc = DXF.parseDxf(ENC.decodeDxf(buf).text);
  if (!doc.entities.length) throw new Error('DXF 中找不到可用實體');
  return doc;
}

async function convertAndParseDwg(file) {
  const endpoint = window.TAKEOFF_DWG_ENDPOINT || '/api/convert-dwg';
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) },
    body: await file.arrayBuffer(),
  }).catch((e) => { throw new Error('轉檔服務無法連線：' + e.message); });
  if (!r.ok) throw new Error(`DWG 轉檔服務回應 ${r.status}，請設定 DWG_CONVERT_URL 或改用 DXF／PDF`);
  const doc = DXF.parseDxf(await r.text());
  if (!doc.entities.length) throw new Error('轉檔結果沒有可用實體');
  return doc;
}

/** DXF 的「文字」= 圖層名 + 文字實體 + 圖塊名，供標籤比對用。 */
function dxfText(doc) {
  const flat = DXF.flatten(doc);
  const texts = flat.filter((e) => e.type === 'TEXT').map((e) => e.text);
  const blocks = [...new Set(flat.filter((e) => e.type === 'INSERT').map((e) => e.name))];
  const layers = [...new Set(flat.map((e) => e.layer))];
  return `圖層：${layers.join(' ')}\n圖塊：${blocks.join(' ')}\n${texts.join('\n')}`;
}

async function applyBoqText(text, doc) {
  const rows = parseCsv(text);
  if (rows.length < 2) return;
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const find = (...keys) => head.findIndex((h) => keys.some((k) => h.includes(k)));
  const ci = find('代碼', 'code', '項次'); const qi = find('boq', '數量', 'qty'); const pi = find('單價', 'price');
  if (ci < 0 || qi < 0) { doc.warn = '無法辨識 BOQ 欄位（需要工項代碼與數量）'; return; }
  let hit = 0;
  for (const r of rows.slice(1)) {
    const it = state.itemByCode.get((r[ci] || '').trim());
    if (!it) continue;
    const q = parseFloat(String(r[qi]).replace(/,/g, ''));
    if (Number.isFinite(q)) { it.qty.boq = q; hit++; }
    if (pi >= 0) { const p = parseFloat(String(r[pi]).replace(/,/g, '')); if (Number.isFinite(p)) it.unitPrice = p; }
  }
  doc.applied = hit;
  renderAll();
}

async function openDocInViewer(id) {
  const d = state.docs.find((x) => x.id === id);
  if (!d) return;
  setMidTab('view');
  if (d._doc) {
    state.drawing = { name: d.name, kind: 'dxf', doc: d._doc };
    state.viewer.loadDxf(d._doc);
    $('#drawName').textContent = `${d.name} · ${d._doc.entities.length} 實體 · 單位 ${d._doc.units.name}`;
    renderSheetChip();
    $('#pageChip').hidden = true;
  } else if (d._file) {
    await loadPdfFile(d._file);
  }
  updateScaleChip(); renderMeasureList();
  state.viewer.on('scale', () => { d.scaleSet = !!state.viewer.metersPerUnit; renderDocs(); });
  d.scaleSet = !!state.viewer.metersPerUnit;
  renderDocs();
}

function analysisCtx() {
  return { items: state.items, docs: state.docs, settings: state.settings, scope: state.scope, rfiLog: state.rfiLog };
}

/** 目前被 RFI 閘門擋住的工項 → 原因。轉採購與自動拆包都吃這份。 */
function rfiBlockMap() {
  const rfis = (state.analysis && state.analysis.metrics.rfis) || A.resolveRfis(analysisCtx());
  const m = A.blockingRfiItems(rfis, state.settings);
  const out = new Map();
  for (const [code, list] of m) {
    out.set(code, `有 ${list.length} 筆未結案 RFI（${list.map((r) => r.code || '候選').join('、')}）—— 發出並結案、或填理由「不追」之後才能放行`);
  }
  return out;
}

function runAnalysis() {
  const ctx = analysisCtx();
  if (!state.docs.length && !confirm('尚未載入任何文件。仍要只依現有工項資料解析嗎？')) return;
  const m = A.metrics(ctx);
  state.analysis = { at: new Date().toISOString(), metrics: m, scope: [...state.scope] };
  $('#scanResult').hidden = false;
  renderStats(m); renderStages(m); renderRfi(m.rfis);
  persist();
}

function statCard(key, label, value, opts = {}) {
  const cls = opts.level ? ' ' + opts.level : '';
  return `<div class="stat${cls}" data-stat="${key}" title="${esc(opts.title || '點擊查看細節')}">
    <span class="k">${esc(label)}</span>
    <span class="v">${esc(String(value))}</span><span class="u">${esc(opts.unit || '')}</span>
    ${opts.bar != null ? `<div class="bar"><i style="width:${Math.round(opts.bar * 100)}%"></i></div>` : ''}
  </div>`;
}

function renderStats(m) {
  const c = m.completeness;
  const lvl = (n, warnAt, badAt) => (n >= badAt ? 'bad' : n >= warnAt ? 'warn' : '');
  $('#stats').innerHTML = [
    statCard('completeness', '圖說完整性', (c.value * 100).toFixed(0), { unit: '%', bar: c.value, level: c.value >= 0.85 ? 'ok' : c.value >= 0.6 ? 'warn' : 'bad', title: '點擊查看五項權重明細' }),
    statCard('wbs', 'WBS', m.wbsCount, { unit: '項' }),
    statCard('items', '工項', m.itemCount, { unit: '項' }),
    statCard('material', '材料/設備', m.materialCount, { unit: '項' }),
    statCard('confirmed', '數量已確認', m.qtyConfirmed, { unit: '項', level: m.qtyConfirmed === m.itemCount ? 'ok' : '' }),
    statCard('special', '特殊規格', m.specialCount, { unit: '項', level: m.specialCount ? 'warn' : '' }),
    statCard('variance', '差異', m.varianceCount, { unit: '項', level: lvl(m.varianceCount, 1, 8) }),
    statCard('rfi', m.rfi && m.rfi.overdue ? `RFI 未結案（逾期 ${m.rfi.overdue}）` : 'RFI 未結案', m.rfiCount,
      { unit: '項', level: m.rfi && m.rfi.overdue ? 'bad' : lvl(m.rfiCount, 1, 10) }),
    statCard('longlead', '長交期', m.longLeadCount, { unit: '項', level: m.longLeadCount ? 'warn' : '' }),
  ].join('');
}

function renderStages(m) {
  const ctxm = { ...m, docs: state.docs.length, packages: state.packages.length, baseline: state.packages.filter((p) => p.baseline).length };
  $('#stages').innerHTML = A.STAGES.map((st, i) => {
    const warn = st.warn && st.warn(ctxm);
    const done = !warn && st.done(ctxm);
    return `${i ? '<span class="arrow">→</span>' : ''}<span class="stage ${warn ? 'warn' : done ? 'done' : ''}">${done ? '✓' : warn ? '!' : '○'} ${esc(st.label)}</span>`;
  }).join('');
}

function renderRfi(rfis) {
  const sum = A.rfiSummary(rfis);
  $('#rfiCount').textContent = `未結案 ${sum.open} / 共 ${sum.total}${sum.overdue ? ` · 逾期 ${sum.overdue}` : ''}`;
  const today = new Date().toISOString().slice(0, 10);
  const f = state.rfiFilter;
  const shown = rfis.filter((r) => {
    if (f === 'all') return true;
    if (f === 'open') return A.isRfiOpen(r);
    if (f === 'closed') return !A.isRfiOpen(r);
    if (f === 'overdue') return r.status === 'issued' && r.dueDate && r.dueDate < today;
    return true;
  });

  const host = $('#rfiList');
  if (!rfis.length) {
    host.innerHTML = '<div class="hint">沒有偵測到不一致。注意：這只代表「已載入的文件之間」沒有矛盾，不代表圖說本身正確。</div>';
    return;
  }
  if (!shown.length) { host.innerHTML = `<div class="hint">目前篩選（${esc(f)}）下沒有項目。</div>`; return; }

  host.innerHTML = shown.map((r) => {
    const st = A.RFI_STATUS[r.status] || A.RFI_STATUS.candidate;
    const overdue = r.status === 'issued' && r.dueDate && r.dueDate < today;
    const acts = [];
    if (r.status === 'candidate') { acts.push(['issue', '發出 RFI', 'primary']); acts.push(['dismiss', '不追', '']); }
    else if (r.status === 'issued') { acts.push(['answer', '登記回覆', 'primary']); acts.push(['close', '直接結案', '']); acts.push(['dismiss', '不追', '']); }
    else if (r.status === 'answered') { acts.push(['close', '結案', 'primary']); acts.push(['answer', '修改回覆', '']); }
    else { acts.push(['reopen', '重開', '']); }

    const meta = [
      r.code ? `文號 ${r.code}` : null,
      r.docNo ? `公文 ${r.docNo}` : null,
      r.issuedAt ? `發出 ${r.issuedAt.slice(0, 10)}` : null,
      r.dueDate ? `期限 ${r.dueDate}` : null,
      r.assignee ? `對象 ${r.assignee}` : null,
      r.closedAt ? `結案 ${r.closedAt}（${(A.RFI_CLOSE_ACTIONS[r.closeAction] || {}).label || ''}）` : null,
      r.dismissReason ? `不追：${r.dismissReason}` : null,
    ].filter(Boolean).join(' · ');

    return `<div class="rfi ${r.severity}${A.isRfiOpen(r) ? '' : ' done'}">
      <h4>
        <span class="chip ${st.level === 'ok' ? 'ok' : st.level === 'warn' ? 'warn' : st.level === 'acc' ? 'acc' : ''}">${esc(st.label)}</span>
        ${r.code ? `<span class="chip">${esc(r.code)}</span>` : ''}
        <span class="chip ${r.severity === 'high' ? 'bad' : r.severity === 'med' ? 'warn' : ''}">${esc((A.RFI_TYPES[r.type] || {}).label || r.type)}</span>
        ${overdue ? '<span class="chip bad">逾期</span>' : ''}
        ${r.vanished ? '<span class="chip warn" title="已發出後，觸發條件在最新解析中已不存在">條件已消失</span>' : ''}
        ${esc(r.title)}
        ${r.itemCode ? `<button class="btn sm" data-rfigo="${esc(r.itemCode)}">看工項</button>` : ''}</h4>
      <p>${esc(r.question)}</p>
      ${(r.evidence || []).length ? `<table><tbody>${r.evidence.map((e) => `<tr><td>${esc(e.label)}</td><td>${esc(e.value)}</td><td>${esc(e.from || '')}</td></tr>`).join('')}</tbody></table>` : ''}
      ${r.answer ? `<div class="ans">回覆：${esc(r.answer)}${r.answeredBy ? `<div class="hint">${esc(r.answeredBy)} · ${esc(r.answeredAt || '')}</div>` : ''}</div>` : ''}
      ${meta ? `<div class="meta">${esc(meta)}</div>` : `<div class="meta">建議發問對象：${esc(r.askTo || '')}</div>`}
      ${r.vanished ? '<div class="meta" style="color:var(--warn)">這筆已發文出去，但最新解析已找不到觸發條件（可能對方已改圖）。請確認後結案，不要放著。</div>' : ''}
      <div class="acts">${acts.map(([k, label, cls]) => `<button class="btn sm ${cls}" data-rfi="${k}" data-id="${esc(r.id)}">${label}</button>`).join('')}</div>
      ${(r.history || []).length ? `<details class="hist"><summary>歷程 ${r.history.length} 筆</summary><ul>${r.history.map((h) => `<li>${esc(h.at.slice(0, 16).replace('T', ' '))} ${esc(h.from)} → ${esc(h.to)}${h.by ? ` · ${esc(h.by)}` : ''}${h.note ? ` · ${esc(h.note)}` : ''}</li>`).join('')}</ul></details>` : ''}
    </div>`;
  }).join('');
}

function onStatClick(key) {
  const m = state.analysis && state.analysis.metrics;
  if (!m) return;
  if (key === 'completeness') {
    const c = m.completeness;
    return dialog(`圖說完整性 ${(c.value * 100).toFixed(1)}%`, `
      <table class="fac"><thead><tr><td>項目</td><td style="text-align:right">權重</td><td style="text-align:right">達成率</td><td style="text-align:right">貢獻</td></tr></thead>
      <tbody>${c.parts.map((p) => `<tr><td>${esc(p.label)}<div class="hint">${esc(p.note)}</div></td>
        <td>${(p.weight * 100).toFixed(0)}%</td><td>${(p.score * 100).toFixed(0)}%</td><td>${(p.weight * p.score * 100).toFixed(1)}%</td></tr>`).join('')}
      <tr><td><b>合計</b></td><td></td><td></td><td><b>${(c.value * 100).toFixed(1)}%</b></td></tr></tbody></table>
      <p class="hint" style="margin-top:10px">這不是 AI 判斷的「像不像完整」，是五個可查證比例的加權。
      要拉高它只有一條路：補文件、補規格、設比例、結案 RFI。數字不會因為換個演算法變好看。</p>`);
  }
  if (key === 'rfi') { $('#rfiList').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  const filters = {
    variance: () => { state.onlyIssues = true; $('#onlyIssues').checked = true; },
    confirmed: () => { state.onlyIssues = false; $('#onlyIssues').checked = false; },
    special: () => { state.search = ''; $('#treeSearch').value = ''; },
    longlead: () => { state.search = ''; $('#treeSearch').value = ''; },
  };
  if (key === 'special' || key === 'longlead') {
    const long = state.settings.longLeadDays || 90;
    const list = key === 'special' ? state.items.filter((i) => i.special) : state.items.filter((i) => (i.leadTimeDays || 0) >= long);
    return dialog(key === 'special' ? '特殊規格工項' : `長交期工項（≥ ${long} 天）`,
      list.length ? `<ul style="margin:0 0 0 18px;padding:0">${list.map((i) => `<li><b>${esc(i.name)}</b>（${esc(i.code)}）— ${esc(i.spec || '')}
        ${i.leadTimeDays ? `<span class="chip warn">${i.leadTimeDays} 天</span>` : ''}
        ${i.specialNote ? `<div class="hint">${esc(i.specialNote)}</div>` : ''}</li>`).join('')}</ul>
        <p class="hint" style="margin-top:10px">${key === 'special'
          ? '特殊規格＝無法用標準品替代的項目。它們決定了你在議價時的實際籌碼有多少。'
          : '長交期項目是排程的要徑。它們應該最先發包，而不是等整包 BOQ 都確認完。'}</p>`
        : '<p>沒有符合的工項。</p>');
  }
  if (filters[key]) { filters[key](); setMidTab('list'); renderTable(); }
  else setMidTab('list');
}

/* ── RFI 狀態流操作 ── */

function currentRfi(id) {
  const list = (state.analysis && state.analysis.metrics.rfis) || A.resolveRfis(analysisCtx());
  return list.find((r) => r.id === id);
}

function applyRfiResult(res, okMsg) {
  if (res.error) { dialog('無法執行', `<p>${esc(res.error)}</p>`); return false; }
  state.rfiLog = res.log;
  if (res.itemPatch) {
    const it = state.itemByCode.get(res.itemPatch.code);
    if (it) {
      for (const [k, v] of Object.entries(res.itemPatch.set)) {
        if (k === 'qty.manual') it.qty.manual = v; else it[k] = v;
      }
    }
  }
  runAnalysis();
  renderAll();
  if (okMsg) setTimeout(() => dialog('已更新', `<p>${okMsg}</p>`), 50);
  return true;
}

function openIssueRfi(id) {
  const r = currentRfi(id); if (!r) return;
  const nextCode = A.nextRfiCode(state.rfiLog);
  dialog(`發出 RFI — ${nextCode}`, `
    <p class="hint">${esc(r.title)}</p>
    <div class="fgrid">
      <div><label class="f">公文文號</label><input type="text" id="rDoc" placeholder="例：函字第 001 號"></div>
      <div><label class="f">發問對象</label><input type="text" id="rTo" value="${esc(r.askTo || '')}"></div>
      <div><label class="f">回覆期限（天）</label><input type="number" id="rDays" value="7" min="1"></div>
      <div><label class="f">發出人</label><input type="text" id="rBy" placeholder="姓名／職稱"></div>
    </div>
    <p class="hint" style="margin-top:10px">按下發出後，本筆會取得正式文號 <b>${esc(nextCode)}</b>，
    問題內容即<b>凍結</b> —— 之後就算重新解析、條件改變，你發文問的那句話都不會被改寫。</p>`,
    [{ label: '取消' }, {
      label: '發出', primary: true, fn: () => {
        applyRfiResult(A.issueRfi(state.rfiLog, r, {
          docNo: $('#rDoc').value, assignee: $('#rTo').value,
          dueDays: parseInt($('#rDays').value, 10) || 7, by: $('#rBy').value,
        }), `已發出 ${nextCode}。逾期未回覆會在清單中標紅。`);
      },
    }]);
}

function openAnswerRfi(id) {
  const r = currentRfi(id); if (!r) return;
  dialog(`登記回覆 — ${esc(r.code || '')}`, `
    <p class="hint">${esc(r.title)}</p>
    <div><label class="f">回覆內容</label><textarea id="aText" rows="4" placeholder="照抄對方回覆的原文，不要自行改寫">${esc(r.answer || '')}</textarea></div>
    <div class="fgrid" style="margin-top:10px">
      <div><label class="f">回覆人</label><input type="text" id="aBy" value="${esc(r.answeredBy || '')}" placeholder="例：設計單位 王工程師"></div>
      <div><label class="f">回覆日期</label><input type="date" id="aAt" value="${esc(r.answeredAt || new Date().toISOString().slice(0, 10))}"></div>
    </div>
    <p class="hint" style="margin-top:10px">原文照抄的理由：結案時如果採用回覆數量，這段文字會被寫進工項的「確認理由」，
    成為日後估驗與爭議時的依據。改寫過的回覆沒有證據力。</p>`,
    [{ label: '取消' }, {
      label: '登記', primary: true, fn: () => {
        applyRfiResult(A.answerRfi(state.rfiLog, r, {
          answer: $('#aText').value, answeredBy: $('#aBy').value, answeredAt: $('#aAt').value,
        }));
      },
    }]);
}

function openCloseRfi(id) {
  const r = currentRfi(id); if (!r) return;
  const it = r.itemCode ? state.itemByCode.get(r.itemCode) : null;
  dialog(`結案 — ${esc(r.code || '')}`, `
    <p class="hint">${esc(r.title)}</p>
    ${r.answer ? `<div class="ans">回覆：${esc(r.answer)}${r.answeredBy ? `<div class="hint">${esc(r.answeredBy)} · ${esc(r.answeredAt || '')}</div>` : ''}</div>` : '<p class="chip warn" style="display:block;padding:6px 9px">尚未登記回覆就結案，請在備註寫明依據。</p>'}
    <div style="margin-top:11px"><label class="f">結案動作</label>
      <select id="cAct">${Object.values(A.RFI_CLOSE_ACTIONS).map((a) => `<option value="${a.key}">${a.label}</option>`).join('')}</select></div>
    <div id="cValWrap" style="margin-top:9px"></div>
    <div style="margin-top:9px"><label class="f">備註</label><input type="text" id="cNote" placeholder="選填"></div>
    <p class="hint" style="margin-top:10px">採用回覆數量會寫進工項的<b>人工確認</b>，簽核人記為回覆人、理由記為本 RFI 文號與回覆原文 ——
    這就是 RFI 閉環：問題的答案變成工項上可稽核的事實，而不是躺在信箱裡。</p>`,
    [{ label: '取消' }, {
      label: '結案', primary: true, fn: () => {
        const act = $('#cAct').value;
        const valEl = $('#cVal');
        applyRfiResult(A.closeRfi(state.rfiLog, r, {
          action: act, value: valEl ? valEl.value : null, note: $('#cNote').value,
        }), '已結案。若該工項原本被 RFI 擋住轉採購，現在會重新檢查。');
      },
    }], (body) => {
      const sel = body.querySelector('#cAct');
      const wrap = body.querySelector('#cValWrap');
      const draw = () => {
        const a = A.RFI_CLOSE_ACTIONS[sel.value];
        if (!a.needs) { wrap.innerHTML = ''; return; }
        wrap.innerHTML = a.needs === 'number'
          ? `<label class="f">回覆數量（${esc(it ? it.unit : '')}）</label><input type="number" id="cVal" step="0.01" value="${it && Q.isNum(it.qty.drawing) ? it.qty.drawing : ''}">`
          : `<label class="f">回覆規格</label><input type="text" id="cVal" value="${esc(it ? it.spec || '' : '')}">`;
      };
      sel.onchange = draw; draw();
    });
}

function openDismissRfi(id) {
  const r = currentRfi(id); if (!r) return;
  dialog(`不追 — ${esc(r.code || '候選')}`, `
    <p class="hint">${esc(r.title)}</p>
    <div><label class="f">理由（必填）</label><textarea id="dReason" rows="3" placeholder="為什麼判定這筆不成立"></textarea></div>
    <p class="hint" style="margin-top:10px">沒有理由的「不追」等於沒有紀錄。日後有人問「當初為什麼沒追這一條」，
    這一欄就是答案。</p>`,
    [{ label: '取消' }, {
      label: '確定不追', primary: true, fn: () => {
        applyRfiResult(A.dismissRfi(state.rfiLog, r, { reason: $('#dReason').value }));
      },
    }]);
}

function openReopenRfi(id) {
  const r = currentRfi(id); if (!r) return;
  const reason = prompt('重開理由：', '');
  if (reason == null) return;
  applyRfiResult(A.reopenRfi(state.rfiLog, r, { reason }));
}

function exportRfiCsv() {
  const rfis = (state.analysis && state.analysis.metrics.rfis) || [];
  if (!rfis.length) return dialog('沒有 RFI', '<p>目前沒有偵測到不一致。</p>');
  const head = ['RFI編號', '狀態', '類型', '嚴重度', 'WBS', '工項代碼', '標題', '問題內容', '發問對象',
    '公文文號', '發出日', '回覆期限', '逾期', '回覆內容', '回覆人', '回覆日', '結案日', '結案動作', '不追理由', '條件是否仍存在', '證據'];
  const today = new Date().toISOString().slice(0, 10);
  const lines = [head, ...rfis.map((r) => [
    r.code || '（候選）', (A.RFI_STATUS[r.status] || {}).label || r.status,
    (A.RFI_TYPES[r.type] || {}).label || r.type, { high: '高', med: '中', low: '低' }[r.severity],
    r.wbs, r.itemCode || '', r.title, r.question, r.assignee || r.askTo,
    r.docNo || '', (r.issuedAt || '').slice(0, 10), r.dueDate || '',
    r.status === 'issued' && r.dueDate && r.dueDate < today ? '是' : '',
    r.answer || '', r.answeredBy || '', r.answeredAt || '',
    r.closedAt || '', (A.RFI_CLOSE_ACTIONS[r.closeAction] || {}).label || '', r.dismissReason || '',
    r.vanished ? '已消失' : '存在',
    (r.evidence || []).map((e) => `${e.label}：${e.value}（${e.from || ''}）`).join(' / '),
  ])];
  exportExcel(`RFI-${state.projName}`, [{ name: 'RFI', rows: lines }]);
}

// 供 e2e 測試觀察內部狀態
window.__takeoff = { state, Q, DXF, A, B, R, S, PR, CS, ENC, U, SV, PS, LM, DD, BD, VD, PO, VF, SH,
  runAnalysis, renderAll, runSchedule, loadMarket, openCalcSheet,
  sheetNoFor, provSheet, syncProvSheets, itemRow, CSV_HEAD, exportScope };
