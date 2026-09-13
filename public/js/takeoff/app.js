/**
 * app.js — 三欄式工程量清單選擇器的 UI 與流程編排。
 *   左：WBS 階層（父子連動、tri-state 多選）
 *   中：BOM 明細（多來源數量比較／可信度／建議採購量）＋ 圖面量測
 *   右：已選清單 → 採購 Package
 */

import * as Q from './quantity.js';
import * as DXF from './dxf.js';
import { Viewer, TOOLS } from './viewer.js';

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
};

/* ══════════ 啟動 ══════════ */

init().catch((e) => { console.error(e); alert('初始化失敗：' + e.message); });

async function init() {
  const res = await fetch('./data/wbs-template.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('無法載入 WBS 範本 (' + res.status + ')');
  state.template = await res.json();
  state.settings = { ...Q.DEFAULT_SETTINGS, ...(state.template.settings || {}) };
  buildModel(state.template);
  restore();
  wire();
  state.viewer = new Viewer($('#cv'));
  bindViewer(state.viewer);
  renderAll();
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
        coverage: i.coverage, calibration: i.calibration, calibrationRms: i.calibrationRms,
        packageId: i.packageId, closed: i.closed,
      })),
      selected: [...state.selected], packages: state.packages, settings: state.settings,
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
  const rows = [];
  let lastWbs = null;
  list.forEach((it, idx) => {
    if (it.wbs !== lastWbs) {
      lastWbs = it.wbs;
      const n = state.nodeByCode.get(it.wbs);
      rows.push(`<tr class="grp"><td colspan="12">${esc(it.wbs)} · ${esc(n ? n.name : '未分類')}</td></tr>`);
    }
    const p = Q.suggestPurchase(it, state.settings);
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
      <td class="num"><button class="srcbtn" data-src="${esc(it.code)}">${Q.fmt(it.qty.drawing, 2)}</button></td>
      <td class="num">${Q.fmt(it.qty.boq, 2)}</td>
      <td class="num">${varianceCell(it)}</td>
      <td><button class="srcbtn" data-basis="${esc(it.code)}">${esc(basisLabel)}</button> ${statusChip}</td>
      <td><button class="srcbtn chip band${c.band}" data-conf="${esc(it.code)}">${c.band} ${c.score}</button></td>
      <td class="num"><input class="cellin num" type="number" step="0.5" min="0" max="100" data-waste="${esc(it.code)}" value="${Q.roundTo((it.wasteRate ?? state.settings.defaultWasteRate) * 100, 2)}"></td>
      <td class="num sug">${p.suggestQty == null ? '<span class="chip bad">—</span>' : Q.fmt(p.suggestQty, 2) + ' ' + esc(it.unit)}</td>
      <td class="num">${p.orderQty == null ? '—' : `${Q.fmt(p.orderQty, 2)} ${esc(p.orderUnit)}${p.moqApplied ? ' <span class="chip warn">MOQ</span>' : ''}`}</td>
      <td class="num">${p.cost == null ? '—' : Q.fmt(p.cost, 0)}</td>
    </tr>`);
    if (!gate && sel) {
      rows.push(`<tr><td></td><td colspan="11" class="hint" style="color:var(--bad)">此項未達轉採購門檻（可信度 ${c.band}，門檻 ${state.settings.gateBand}）：${esc(p.basis.rule)}</td></tr>`);
    }
  });
  body.innerHTML = rows.join('') || '<tr><td colspan="12" class="hint" style="padding:22px;text-align:center">沒有符合條件的工項</td></tr>';
  $('#midTitle').textContent = `工程量清單 (BOM) · ${list.length} 項`;
}

/* ══════════ 右欄：已選 + 採購包 ══════════ */

function selectedItems() { return state.items.filter((i) => state.selected.has(i.code)); }

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
        const p = Q.suggestPurchase(it, state.settings);
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
  const s = Q.summarize(list, state.settings);
  $('#totals').innerHTML = `
    <div class="totrow"><span>已選工項</span><b>${s.count}</b></div>
    <div class="totrow"><span>預估金額</span><b>NT$ ${Q.fmt(s.cost, 0)}${s.unpriced ? ` <span class="chip warn">${s.unpriced} 項未報價</span>` : ''}</b></div>
    <div class="totrow"><span>可信度分布</span><b>
      <span class="chip bandA">A ${s.bands.A}</span> <span class="chip bandB">B ${s.bands.B}</span>
      <span class="chip bandC">C ${s.bands.C}</span> <span class="chip bandD">D ${s.bands.D}</span></b></div>
    <div class="totrow"><span>需複核 / 鎖定</span><b>${s.review} / ${s.blocked}</b></div>`;
}

function renderPkgs() {
  const host = $('#pkgs');
  $('#pkgCount').textContent = String(state.packages.length);
  if (!state.packages.length) { host.innerHTML = '<div class="hint" style="padding:16px;text-align:center">尚無採購包。選好工項後按「轉採購 Package」。</div>'; return; }
  host.innerHTML = state.packages.map((p, i) => {
    const items = p.itemCodes.map((c) => state.itemByCode.get(c)).filter(Boolean);
    const s = Q.summarize(items, state.settings);
    const lead = items.reduce((a, it) => Math.max(a, it.leadTimeDays || 0), 0);
    return `<div class="pkg">
      <header><b>${esc(p.code)}</b><span class="chip">${items.length} 項</span><span class="chip acc">NT$ ${Q.fmt(s.cost, 0)}</span>
        <span class="spacer" style="flex:1"></span>
        <button class="btn sm" data-pkg-csv="${i}">RFQ CSV</button>
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

function renderAll() { renderTree(); renderTable(); renderCart(); renderPkgs(); persist(); }

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
  $('#pkgs').addEventListener('input', (e) => {
    const t = e.target;
    const set = (attr, key) => { const i = t.getAttribute(attr); if (i != null) { state.packages[+i][key] = t.value; persist(); } };
    set('data-pkg-name', 'name'); set('data-pkg-vendor', 'vendor'); set('data-pkg-date', 'needDate');
  });
  $('#pkgs').addEventListener('click', (e) => {
    const d = e.target.closest('[data-pkg-del]');
    if (d) { if (confirm('刪除此採購包？')) { state.packages.splice(+d.dataset.pkgDel, 1); renderAll(); } return; }
    const c = e.target.closest('[data-pkg-csv]');
    if (c) exportPackageCsv(state.packages[+c.dataset.pkgCsv]);
  });

  // 頂部
  $('#btnImportDrawing').onclick = () => $('#fileDrawing').click();
  $('#fileDrawing').onchange = (e) => { const f = e.target.files[0]; if (f) loadDrawing(f); e.target.value = ''; };
  $('#btnImportBoq').onclick = () => $('#fileBoq').click();
  $('#fileBoq').onchange = (e) => { const f = e.target.files[0]; if (f) importBoqCsv(f); e.target.value = ''; };
  $('#fileProject').onchange = (e) => { const f = e.target.files[0]; if (f) importProject(f); e.target.value = ''; };
  $('#btnSettings').onclick = openSettings;
  $('#btnExport').onclick = openExport;
  $('#btnHelp').onclick = openHelp;

  // 分頁（中欄清單 / 圖面）
  $('#tabList').onclick = () => setMidTab('list');
  $('#tabView').onclick = () => setMidTab('view');

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
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) /\.(csv)$/i.test(f.name) ? importBoqCsv(f) : /\.json$/i.test(f.name) ? importProject(f) : loadDrawing(f);
  });

  window.addEventListener('resize', () => state.viewer && state.viewer.resize());
}

function rangeSelect(a, b, on) {
  const list = visibleItems();
  const [lo, hi] = a < b ? [a, b] : [b, a];
  for (let i = lo; i <= hi; i++) if (list[i]) on ? state.selected.add(list[i].code) : state.selected.delete(list[i].code);
}

function setMidTab(t) {
  const isView = t === 'view';
  $('#tabList').setAttribute('aria-pressed', String(!isView));
  $('#tabView').setAttribute('aria-pressed', String(isView));
  $('#tableWrap').classList.toggle('off', isView);
  $('#viewWrap').classList.toggle('on', isView);
  if (isView) requestAnimationFrame(() => { state.viewer.resize(); state.viewer.fit(); });
}

/* ══════════ 圖面載入 ══════════ */

async function loadDrawing(file) {
  const name = file.name;
  const ext = (name.split('.').pop() || '').toLowerCase();
  setMidTab('view');
  $('#drawName').textContent = `載入中… ${name}`;
  try {
    if (ext === 'pdf') await loadPdfFile(file);
    else if (ext === 'dxf') await loadDxfFile(file);
    else if (ext === 'dwg') await loadDwgFile(file);
    else throw new Error('僅支援 DWG / DXF / PDF');
  } catch (e) {
    console.error(e);
    $('#drawName').textContent = '載入失敗';
    dialog('圖面載入失敗', `<p>${esc(e.message)}</p>`);
  }
}

async function loadDxfFile(file) {
  const buf = await file.arrayBuffer();
  if (DXF.isBinaryDxf(buf)) throw new Error('這是二進位 DXF。請在 CAD 另存為「ASCII DXF」後再匯入。');
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  const doc = DXF.parseDxf(text);
  if (!doc.entities.length) throw new Error('DXF 中找不到可用實體（模型空間為空或版本過舊）。');
  state.drawing = { name: file.name, kind: 'dxf', doc };
  state.viewer.loadDxf(doc);
  $('#drawName').textContent = `${file.name} · ${doc.entities.length} 實體 · 單位 ${doc.units.name}`;
  $('#pageChip').hidden = true;
  updateScaleChip();
  renderMeasureList();
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

async function loadPdfFile(file) {
  const pdfjs = await import('../../vendor/pdfjs/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  const buf = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buf }).promise;
  state.drawing = { name: file.name, kind: 'pdf', pdf, pageNo: 1, pages: pdf.numPages };
  await state.viewer.loadPdf(pdf, 1);
  $('#drawName').textContent = `${file.name} · ${pdf.numPages} 頁`;
  const chip = $('#pageChip');
  chip.hidden = false;
  chip.innerHTML = `第 <b>1</b>/${pdf.numPages} 頁`;
  chip.style.cursor = 'pointer';
  chip.onclick = async () => {
    const n = parseInt(prompt(`跳至第幾頁？(1–${pdf.numPages})`, String(state.drawing.pageNo)), 10);
    if (!n || n < 1 || n > pdf.numPages) return;
    state.drawing.pageNo = n;
    await state.viewer.loadPdf(pdf, n);
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
async function loadDwgFile(file) {
  const buf = await file.arrayBuffer();
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
        state.drawing = { name: file.name, kind: 'dwg', doc, via: 'server' };
        state.viewer.loadDxf(doc);
        $('#drawName').textContent = `${file.name} · 經轉檔服務 · ${doc.entities.length} 實體`;
        updateScaleChip(); renderMeasureList(); openLayers();
        return;
      }
    }
    const detail = await r.text().catch(() => '');
    throw new Error(`轉檔服務回應 ${r.status}${detail ? '：' + detail.slice(0, 200) : ''}`);
  } catch (err) {
    if (window.TAKEOFF_LIBREDWG_BASE) { await loadDwgViaWasm(buf, file.name); return; }
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

async function loadDwgViaWasm(buf, name) {
  const base = window.TAKEOFF_LIBREDWG_BASE.replace(/\/?$/, '/');
  const mod = await import(/* @vite-ignore */ base + 'libredwg-web.js');
  const lib = await mod.LibreDwg.create(base);
  const dwg = lib.dwg_read_data(buf, mod.Dwg_File_Type.DWG);
  const db = lib.convert(dwg);
  const doc = DXF.fromDwgDatabase(db);
  try { lib.dwg_free(dwg); } catch { /* 記憶體釋放失敗不影響解析結果 */ }
  state.drawing = { name, kind: 'dwg', doc, via: 'wasm' };
  state.viewer.loadDxf(doc);
  $('#drawName').textContent = `${name} · WASM 解析 · ${doc.entities.length} 實體`;
  updateScaleChip(); renderMeasureList(); openLayers();
}

/* ══════════ 比例與量測 ══════════ */

function bindViewer(v) {
  v.on('hover', ({ world, snap }) => {
    $('#coord').textContent = `x ${world.x.toFixed(1)}  y ${world.y.toFixed(1)}${snap ? '  · ' + snap : ''}`;
  });
  v.on('measure', () => renderMeasureList());
  v.on('measure-change', () => renderMeasureList());
  v.on('scale', () => updateScaleChip());
  v.on('calib-request', ({ dUnits }) => {
    dialog('比例校正', `
      <p>已在圖上量到 <b class="num">${dUnits.toFixed(2)}</b> 個圖面單位。請輸入這段的實際長度：</p>
      <div class="fgrid">
        <div><label class="f">實際長度</label><input type="number" id="calLen" step="0.001" min="0" value="1"></div>
        <div><label class="f">單位</label><select id="calUnit"><option value="1">公尺 m</option><option value="0.001">公厘 mm</option><option value="0.01">公分 cm</option><option value="0.3048">英呎 ft</option></select></div>
      </div>
      <p class="hint">可重複校正多段已知尺寸：兩段以上會改用最小平方求比例，並回報 RMS 殘差 —— 殘差就是這份圖「量得準不準」的客觀證據。</p>`,
      [{ label: '取消' }, {
        label: '套用', primary: true, fn: () => {
          const len = parseFloat($('#calLen').value) * parseFloat($('#calUnit').value);
          const info = v.addCalibration(dUnits, len);
          if (info) applyCalibrationToItems(info);
        },
      }]);
  });
}

function applyCalibrationToItems(info) {
  for (const it of state.items) {
    if (it.provenance && it.provenance.kind === 'measure') {
      it.calibration = info.method; it.calibrationRms = info.rms ?? 0;
    }
  }
  renderAll();
}

function updateScaleChip() {
  const v = state.viewer;
  const i = v.scaleInfo();
  const chip = $('#scaleChip');
  chip.style.cursor = 'pointer';
  if (!i.metersPerUnit) { chip.className = 'chip bad'; chip.textContent = '比例：未設定（量測無效）'; return; }
  const label = { native: '圖檔原生單位', 'two-point': '兩點校正', 'vector-rms': `${i.points} 段最小平方`, 'declared-scale': '圖框標註比例' }[i.method] || i.method;
  chip.className = 'chip ' + (i.method === 'declared-scale' ? 'warn' : i.rms != null && i.rms > 0.02 ? 'warn' : 'ok');
  chip.textContent = `比例：${label}${i.ratio ? ` 1:${i.ratio}` : ''}${i.rms ? ` · RMS ${(i.rms * 100).toFixed(2)}%` : ''}`;
}

function openScaleDialog(firstTime = false) {
  const v = state.viewer;
  if (!v.mode) return dialog('尚未載入圖面', '<p>請先載入 DWG／DXF／PDF。</p>');
  dialog('設定圖面比例', `
    ${firstTime ? '<p class="chip bad" style="display:block;padding:7px 10px">PDF 沒有真實尺寸資訊。未設定比例前，所有量測值都不會換算成工程單位。</p>' : ''}
    <h4>方法一：實測校正（建議）</h4>
    <p>選「比例校正」工具，在圖上點兩點已知尺寸（例如標註的柱距），輸入實際長度。重複 2 段以上可取得 RMS 殘差。</p>
    <h4>方法二：圖框標註比例</h4>
    <div class="fgrid">
      <div><label class="f">比例 1 : N</label><input type="number" id="ratioN" min="1" step="1" value="${v.scaleInfo().ratio || 100}"></div>
      <div style="align-self:end"><button class="btn" id="btnRatio">套用</button></div>
    </div>
    <p class="hint">此法假設 PDF 由 CAD 以 1:1 圖紙尺寸輸出且未經縮放列印。實務上常見「A1 圖縮印成 A3」而失真，
    所以本工具在可信度評分中對這個方法扣分。</p>`, [{ label: '關閉' }], (body) => {
    body.querySelector('#btnRatio').onclick = () => {
      const n = parseInt(body.querySelector('#ratioN').value, 10);
      v.setDeclaredScale(n); updateScaleChip(); $('#dlg').close();
    };
  });
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
        it.closed = m.type === 'area' || m.type === 'rect' ? true : it.closed;
        const info = v.scaleInfo();
        it.calibration = info.method; it.calibrationRms = info.rms ?? 0;
        it.provenance = {
          kind: 'measure', drawing: state.drawing ? state.drawing.name : '', page: state.drawing && state.drawing.pageNo,
          measurements: [...((it.provenance && it.provenance.measurements) || []), { id: m.id, type: m.type, value: e.value, factor: f }],
          at: new Date().toISOString(),
        };
        m.itemCode = it.code;
        renderAll(); renderMeasureList();
      },
    }]);
}

/* ══════════ 圖層 → 工項自動抓量 ══════════ */

function openLayers() {
  const v = state.viewer;
  if (v.mode !== 'dxf' || !v.doc) return dialog('僅適用向量圖檔', '<p>圖層自動抓量需要 DXF／DWG 幾何。PDF 請用量測工具逐段量。</p>');
  const agg = DXF.aggregateByLayer(v.doc);
  const toM = v.metersPerUnit;
  const rows = agg.map((g, i) => {
    const guess = guessItem(g.layer);
    const blocks = Object.entries(g.blocks).map(([n, c]) => `${n}×${c}`).join('、');
    return `<div class="layerrow">
      <input type="checkbox" data-lv="${esc(g.layer)}" ${v.layerVisible[g.layer] === false ? '' : 'checked'} style="width:auto" title="顯示／隱藏">
      <span class="lname" title="${esc(g.layer)}">${esc(g.layer)}</span>
      <span class="num" style="width:96px">${toM ? Q.fmt(g.length * toM, 1) + ' M' : Q.fmt(g.length, 1)}</span>
      <span class="num" style="width:96px">${toM ? Q.fmt(g.area * toM * toM, 1) + ' M²' : Q.fmt(g.area, 1)}</span>
      <span class="num" style="width:54px">${g.count}</span>
      <select data-map="${i}" style="width:250px">
        <option value="">— 不對映 —</option>
        ${state.items.map((it) => `<option value="${esc(it.code)}" ${guess === it.code ? 'selected' : ''}>${esc(it.code)} · ${esc(it.name)}（${esc(it.unit)}）</option>`).join('')}
      </select>
      <span class="hint" style="width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(blocks)}</span>
    </div>`;
  }).join('');
  dialog('圖層彙總 → 工項自動抓量', `
    <div class="hint" style="display:flex;gap:8px;padding:0 10px 6px">
      <span style="flex:1">圖層（${agg.length}）</span><span style="width:96px;text-align:right">長度</span>
      <span style="width:96px;text-align:right">面積</span><span style="width:54px;text-align:right">數量</span>
      <span style="width:250px">對映工項</span><span style="width:120px">圖塊</span></div>
    <div style="max-height:46vh;overflow:auto">${rows}</div>
    <p class="hint">自動抓量取的是「該圖層所有實體的總長／總面積／實體數」。它的前提是<b>圖層紀律</b>：
    同一圖層只放同一種構件、不重複描繪、不用圖層當註記。這個前提在多數實際專案不成立，
    所以自動抓量的結果會標記為 <code>auto</code> 並在可信度上扣分，必須人工抽查。</p>`,
    [{ label: '關閉' }, {
      label: '套用對映', primary: true, fn: () => {
        let n = 0;
        $$('#dlgBody [data-map]').forEach((sel) => {
          const code = sel.value; if (!code) return;
          const g = agg[+sel.dataset.map];
          const it = state.itemByCode.get(code);
          const val = layerValueFor(it, g, toM);
          if (val == null) return;
          it.qty.drawing = Q.roundTo(val, 4);
          it.drawingSource = 'auto';
          it.layerMapped = true;
          it.calibration = 'native';
          it.calibrationRms = 0;
          it.closed = it.measureType === 'area' ? g.closedCount > 0 : it.closed;
          it.provenance = { kind: 'dxf-layer', drawing: state.drawing ? state.drawing.name : '', layer: g.layer, at: new Date().toISOString() };
          n++;
        });
        renderAll();
        if (n) setTimeout(() => dialog('已套用', `<p>已從 ${n} 個圖層寫入圖面量。請切回清單檢查差異欄與可信度。</p>`), 60);
      },
    }], (body) => {
      body.addEventListener('change', (e) => {
        const cb = e.target.closest('[data-lv]'); if (!cb) return;
        v.layerVisible[cb.dataset.lv] = cb.checked; v.render();
      });
    });
}

function guessItem(layer) {
  const l = layer.toLowerCase();
  let best = null, bestLen = 0;
  for (const it of state.items) {
    for (const h of (it.layerHints || [])) {
      const hh = String(h).toLowerCase();
      if (hh && l.includes(hh) && hh.length > bestLen) { best = it.code; bestLen = hh.length; }
    }
  }
  return best;
}

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

/* ══════════ 對話框 ══════════ */

function dialog(title, html, buttons = [{ label: '關閉' }], onBody) {
  const d = $('#dlg');
  $('#dlgTitle').textContent = title;
  $('#dlgBody').innerHTML = html;
  const foot = $('#dlgFoot');
  foot.innerHTML = '';
  (buttons.length ? buttons : [{ label: '關閉' }]).forEach((b) => {
    const el = document.createElement('button');
    el.className = 'btn' + (b.primary ? ' primary' : '');
    el.textContent = b.label;
    el.onclick = () => { if (b.fn) b.fn(); d.close(); };
    foot.appendChild(el);
  });
  if (onBody) onBody($('#dlgBody'));
  if (!d.open) d.showModal();
}

function openSourceDialog(code) {
  const it = state.itemByCode.get(code);
  const res = Q.resolveBasis(it, state.settings);
  const pay = Q.paymentImpact(it, state.settings);
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
      <div><label class="f">損耗率</label><input type="number" id="mWaste" step="0.005" min="0" value="${it.wasteRate ?? state.settings.defaultWasteRate}"></div>
      <div><label class="f">單價 (NT$/${esc(it.unit)})</label><input type="number" id="mPrice" step="0.01" value="${it.unitPrice ?? ''}"></div>
      <div><label class="f">訂購單位</label><input type="text" id="oUnit" value="${esc(it.order.unit || it.unit)}"></div>
      <div><label class="f">每訂購單位含量 (${esc(it.unit)})</label><input type="number" id="oFactor" step="0.001" value="${it.order.unitFactor ?? 1}"></div>
      <div><label class="f">包裝倍數</label><input type="number" id="oPack" step="1" min="1" value="${it.order.packMultiple ?? 1}"></div>
      <div><label class="f">MOQ（訂購單位）</label><input type="number" id="oMoq" step="1" min="0" value="${it.order.moq ?? 0}"></div>
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
        const pr = parseFloat($('#mPrice').value); it.unitPrice = Number.isFinite(pr) ? pr : null;
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
    return p.kind === 'dxf-layer' ? `圖層 ${p.layer}｜${p.drawing}` : `量測 ${(p.measurements || []).length} 筆｜${p.drawing}${p.page ? ' p.' + p.page : ''}`;
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
    </div>
    <p class="hint" style="margin-top:8px">合約型態不影響任何數量計算，只改變差異的<b>解讀</b>：實作實算下多出來的量是可請領的增量，
    總價承攬下同一個數字是承包商要吸收的成本。這一欄決定你看到的是機會還是風險。</p>
    <p class="hint" style="margin-top:10px">門檻是風險偏好的具體化：把 3% 調到 8%，等於宣告「圖面與標單差 8% 以內都不必解釋」。
    這個數字最終要由誰承擔差異的責任來決定，不是由方便決定。</p>
    <h4 style="margin:14px 0 6px">專案資料</h4>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn" id="sExportProj">匯出專案 JSON</button>
      <button class="btn" id="sImportProj">匯入專案 JSON</button>
      <button class="btn" id="sReset">重置為範本</button>
    </div>`,
    [{ label: '取消' }, {
      label: '套用', primary: true, fn: () => {
        s.varianceWarn = parseFloat($('#sWarn').value) || 0;
        s.varianceStop = parseFloat($('#sStop').value) || 0;
        s.defaultWasteRate = parseFloat($('#sWaste').value) || 0;
        s.gateBand = $('#sGate').value;
        s.contractType = $('#sContract').value;
        renderAll();
      },
    }], (body) => {
      body.querySelector('#sExportProj').onclick = () => { exportProject(); $('#dlg').close(); };
      body.querySelector('#sImportProj').onclick = () => { $('#fileProject').click(); $('#dlg').close(); };
      body.querySelector('#sReset').onclick = () => {
        if (!confirm('清除所有本機修改，回到範本狀態？')) return;
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
      <li>勾選 → 右欄 → 轉採購 Package → 匯出 RFQ CSV。</li>
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
  const ok = [], bad = [];
  for (const it of list) {
    const p = Q.suggestPurchase(it, state.settings);
    const c = Q.confidence(it, { settings: state.settings, basis: p.basis });
    (p.blocked || !Q.bandAtLeast(c.band, state.settings.gateBand)) ? bad.push([it, c, p]) : ok.push(it);
  }
  const badHtml = bad.length ? `<p class="chip bad" style="display:block;padding:8px 10px">${bad.length} 項未達門檻，不會納入本包：</p>
    <ul style="margin:6px 0 10px 18px;padding:0">${bad.map(([it, c, p]) => `<li>${esc(it.name)} — 可信度 ${c.band}；${esc(p.basis.rule)}</li>`).join('')}</ul>` : '';
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
  const r = Q.suggestPackages(list, state.settings);
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

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function download(name, text, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob(['﻿' + text], { type: mime });   // BOM 讓 Excel 正確判讀 UTF-8
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function itemRow(it) {
  const p = Q.suggestPurchase(it, state.settings);
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
    it.provenance ? (it.provenance.kind === 'dxf-layer' ? `圖層:${it.provenance.layer}@${it.provenance.drawing}` : `量測@${it.provenance.drawing}`) : '',
  ];
}

const CSV_HEAD = ['WBS', '工項代碼', '名稱', '規格', '單位', '圖面量', 'BOQ量', '差異量', '差異率', '人工確認',
  '正式採購基準', '狀態', '判定規則', '可信度分數', '可信度等級', '損耗率', '建議採購量', '下單量', '訂購單位',
  '到貨量', '單價', '預估金額', '計價影響', '計價說明', '前置期(天)', '簽核人', '確認理由', '數量出處'];

function openExport() {
  dialog('匯出', `
    <div style="display:grid;gap:8px">
      <button class="btn" id="eAll">全部工項 CSV</button>
      <button class="btn" id="eSel">已選工項 CSV</button>
      <button class="btn" id="ePkg">所有採購包 RFQ CSV</button>
      <button class="btn" id="eJson">專案 JSON（含來源與簽核紀錄）</button>
    </div>
    <p class="hint" style="margin-top:10px">CSV 含 UTF-8 BOM，Excel 直接開不會亂碼。
    匯出檔保留「判定規則、簽核人、確認理由、數量出處」四欄 —— 這四欄才是稽核時真正被問的東西。</p>`,
    [{ label: '關閉' }], (body) => {
      body.querySelector('#eAll').onclick = () => { exportCsv(state.items, 'BOQ-全部'); $('#dlg').close(); };
      body.querySelector('#eSel').onclick = () => { exportCsv(selectedItems(), 'BOQ-已選'); $('#dlg').close(); };
      body.querySelector('#ePkg').onclick = () => { state.packages.forEach(exportPackageCsv); $('#dlg').close(); };
      body.querySelector('#eJson').onclick = () => { exportProject(); $('#dlg').close(); };
    });
}

function exportCsv(items, name) {
  if (!items.length) return dialog('沒有資料', '<p>清單是空的。</p>');
  const lines = [CSV_HEAD, ...items.map(itemRow)].map((r) => r.map(csvCell).join(','));
  download(`${name}-${new Date().toISOString().slice(0, 10)}.csv`, lines.join('\n'));
}

function exportPackageCsv(pkg) {
  const items = pkg.itemCodes.map((c) => state.itemByCode.get(c)).filter(Boolean);
  const head = [`採購包,${pkg.code},${pkg.name || ''}`, `供應商,${pkg.vendor || '未定'}`, `需求到貨日,${pkg.needDate || ''}`, ''];
  const lines = [CSV_HEAD, ...items.map(itemRow)].map((r) => r.map(csvCell).join(','));
  download(`RFQ-${pkg.code}.csv`, head.concat(lines).join('\n'));
}

function exportProject() {
  const data = {
    exportedAt: new Date().toISOString(),
    template: state.template.name,
    settings: state.settings,
    items: state.items,
    packages: state.packages,
    selected: [...state.selected],
  };
  download(`takeoff-project-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), 'application/json');
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

// 供 e2e 測試觀察內部狀態
window.__takeoff = { state, Q, DXF };
