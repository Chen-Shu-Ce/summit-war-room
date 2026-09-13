/**
 * viewer.js — 圖面檢視與量測引擎（DXF 幾何 / PDF 頁面共用一套座標與量測邏輯）。
 *
 * 座標系
 *   world  ：DXF＝圖檔單位且 y 向上；PDF＝PDF user space (pt) 且 y 向下。
 *            以 yUp 旗標統一，量測數學共用。
 *   screen ：sx = x·k + tx；sy = (yUp ? −y : y)·k + ty
 *
 * 量測值一律先算「world 單位」，再由 scale（世界單位→公尺）換成工程單位。
 * PDF 未校正時 metersPerUnit = null，量測值刻意不顯示工程單位 —— 沒有比例的尺寸是假數字。
 */

import * as SV from './survey.js';
import * as DXF from './dxf.js';

const PT_TO_M = 0.0254 / 72;   // 1 PDF pt = 1/72 inch

export const TOOLS = {
  pan:     { key: 'pan',     label: '平移',   verts: 0 },
  length:  { key: 'length',  label: '長度',   verts: Infinity },
  area:    { key: 'area',    label: '面積',   verts: Infinity },
  rect:    { key: 'rect',    label: '矩形',   verts: 2 },
  count:   { key: 'count',   label: '計數',   verts: 1 },
  angle:   { key: 'angle',   label: '角度',   verts: 3 },
  calib:   { key: 'calib',   label: '比例校正', verts: 2 },
};

export class Viewer {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.mode = null;                  // 'dxf' | 'pdf'
    this.doc = null;                   // DXF doc
    this.flat = [];                    // 攤平後的 DXF 實體
    this.page = null;                  // pdf.js page
    this.raster = null;                // PDF 離屏點陣
    this.rasterScale = 0;
    this.yUp = true;
    this.view = { k: 1, tx: 0, ty: 0 };
    this.bounds = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    this.tool = 'pan';
    this.active = null;                // 進行中的量測 { type, pts }
    this.measurements = [];
    this.calibrations = [];            // [{ dPt, realM }]
    this.metersPerUnit = null;         // world 單位 → 公尺（整頁預設）
    this.scaleMethod = 'none';         // none | two-point | vector-rms | declared-scale | native
    // 分區比例：一張施工圖常同時有平面 1:100 與大樣 1:10，
    // 整張套同一個比例會讓大樣的量測整批錯 10 倍，而且完全看不出來。
    this.scaleZones = [];              // [{ id, name, rect:{x0,y0,x1,y1}, metersPerUnit, method, ratio, rms }]
    this.notToScale = false;           // 圖面標示 NO SCALE：量測一律不換算工程單位
    this.notToScaleWhy = null;
    this.snap = true;
    this.ortho = false;
    this.hover = null;
    this.snapPt = null;
    this.layerVisible = {};
    this.listeners = {};
    this._bind();
  }

  on(ev, fn) { (this.listeners[ev] ||= []).push(fn); return this; }
  emit(ev, d) { (this.listeners[ev] || []).forEach((f) => f(d)); }

  /* ── 載入 ── */

  loadDxf(doc) {
    this.mode = 'dxf'; this.doc = doc; this.page = null; this.raster = null;
    this.flat = DXF.flatten(doc);
    this.bounds = DXF.bounds(doc);
    // 全覽要看「內容」的範圍，不是「全部實體」的範圍。
    // 地籍圖常把內容畫在 TWD97 TM2 測量座標上，圖例與指北針卻畫在原點旁 ——
    // 對全部實體取外框會得到 270 萬單位的跨距，自動全覽因此縮到看不見任何東西。
    const cb = SV.contentBounds(this.flat);
    this.contentBounds = cb && cb.split ? cb : null;
    this.yUp = true;
    this.layerVisible = {};
    for (const e of this.flat) this.layerVisible[e.layer || '0'] ??= true;
    const toM = doc.units && doc.units.toM;
    this.metersPerUnit = toM || null;
    this.scaleMethod = toM ? 'native' : 'none';
    this.calibrations = [];
    this.scaleZones = [];
    this.fit();
    this.emit('loaded', { mode: 'dxf' });
  }

  async loadPdf(pdfDoc, pageNo = 1) {
    this.mode = 'pdf'; this.doc = null; this.flat = [];
    this.pdf = pdfDoc;
    this.page = await pdfDoc.getPage(pageNo);
    this.pageNo = pageNo;
    const vp = this.page.getViewport({ scale: 1 });
    this.pageSize = { w: vp.width, h: vp.height };
    this.bounds = { minX: 0, minY: 0, maxX: vp.width, maxY: vp.height };
    this.yUp = false;
    this.raster = null; this.rasterScale = 0;
    this.metersPerUnit = null;
    this.scaleMethod = 'none';
    this.calibrations = [];
    this.scaleZones = [];
    this.fit();
    await this.ensureRaster();
    this.render();
    this.emit('loaded', { mode: 'pdf', pageNo, pages: pdfDoc.numPages });
  }

  /* ── 視圖 ── */

  resize() {
    const r = this.cv.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cv.width = Math.max(1, Math.round(r.width * dpr));
    this.cv.height = Math.max(1, Math.round(r.height * dpr));
    this.dpr = dpr;
    this.css = { w: r.width, h: r.height };
    this.render();
  }

  /** opts.all = true 時強制用全部實體的外框（含離群的圖例）。 */
  fit(pad = 0.06, opts = {}) {
    const r = this.cv.getBoundingClientRect();
    const w = r.width || 800, h = r.height || 600;
    const b = (!opts.all && this.contentBounds) ? this.contentBounds : this.bounds;
    const bw = Math.max(b.maxX - b.minX, 1e-9);
    const bh = Math.max(b.maxY - b.minY, 1e-9);
    const k = Math.min(w / bw, h / bh) * (1 - pad * 2);
    this.view.k = k;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    this.view.tx = w / 2 - cx * k;
    this.view.ty = h / 2 - (this.yUp ? -cy : cy) * k;
    this.render();
  }

  toScreen(p) {
    return { x: p.x * this.view.k + this.view.tx, y: (this.yUp ? -p.y : p.y) * this.view.k + this.view.ty };
  }
  toWorld(p) {
    const x = (p.x - this.view.tx) / this.view.k;
    const y = (p.y - this.view.ty) / this.view.k;
    return { x, y: this.yUp ? -y : y };
  }

  /* ── PDF 點陣化：縮放跨過 1.6 倍才重繪，兼顧清晰度與效能 ── */
  async ensureRaster() {
    if (this.mode !== 'pdf' || !this.page) return;
    const want = Math.min(Math.max(this.view.k * (this.dpr || 1), 0.4), 6);
    if (this.raster && this.rasterScale && want / this.rasterScale < 1.6 && this.rasterScale / want < 1.6) return;
    const vp = this.page.getViewport({ scale: want });
    const c = document.createElement('canvas');
    c.width = Math.min(Math.round(vp.width), 8000);
    c.height = Math.min(Math.round(vp.height), 8000);
    const rc = { canvasContext: c.getContext('2d', { willReadFrequently: true }), viewport: vp };
    if (this._renderTask) { try { this._renderTask.cancel(); } catch { /* 前一次算繪已取消 */ } }
    this._renderTask = this.page.render(rc);
    try { await this._renderTask.promise; } catch { return; }
    this.raster = c; this.rasterScale = want;
    this._px = null;
  }

  /* ── 繪製 ── */

  render() {
    const ctx = this.ctx;
    if (!ctx || !this.css) return;
    const dpr = this.dpr || 1;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.css.w, this.css.h);
    ctx.fillStyle = getComputedStyle(this.cv).getPropertyValue('--paper') || '#fff';
    ctx.fillRect(0, 0, this.css.w, this.css.h);

    if (this.mode === 'pdf' && this.raster) {
      // 點陣圖是以 rasterScale 產生的；貼回畫布時只要換算成目前 view.k 的尺寸。
      const w = this.pageSize.w * this.view.k, h = this.pageSize.h * this.view.k;
      ctx.save();
      ctx.shadowColor = 'rgba(15,23,42,.18)'; ctx.shadowBlur = 12; ctx.shadowOffsetY = 2;
      ctx.fillStyle = '#fff';
      ctx.fillRect(this.view.tx, this.view.ty, w, h);          // 先畫紙張，讓圖幅邊界看得見
      ctx.restore();
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.raster, this.view.tx, this.view.ty, w, h);
      ctx.strokeStyle = 'rgba(15,23,42,.28)'; ctx.lineWidth = 1;
      ctx.strokeRect(this.view.tx + .5, this.view.ty + .5, w, h);
    } else if (this.mode === 'dxf') {
      this.drawDxf(ctx);
    }
    this.drawMeasures(ctx);
    ctx.restore();
  }

  drawDxf(ctx) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#243b53';
    const S = (p) => this.toScreen(p);
    const vis = (e) => this.layerVisible[e.layer || '0'] !== false;
    ctx.beginPath();
    for (const e of this.flat) {
      if (!vis(e)) continue;
      if (e.type === 'LINE') { const a = S(e.pts[0]), b = S(e.pts[1]); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
      else if (e.type === 'POLYLINE') {
        const n = e.pts.length; if (!n) continue;
        const first = S(e.pts[0]); ctx.moveTo(first.x, first.y);
        const seg = (a, b) => {
          // 有 bulge 的邊必須畫成圓弧：量測算的是弧長，畫面也要畫弧，否則圖面與數字對不起來。
          if (!a.bulge) { const q = S(b); ctx.lineTo(q.x, q.y); return; }
          const arc = bulgeGeom(a, b, a.bulge);
          if (!arc) { const q = S(b); ctx.lineTo(q.x, q.y); return; }
          const c = S(arc.center);
          ctx.arc(c.x, c.y, Math.max(arc.R * this.view.k, 0.5), -arc.a0, -arc.a1, a.bulge > 0);
        };
        for (let i = 1; i < n; i++) seg(e.pts[i - 1], e.pts[i]);
        if (e.closed) { seg(e.pts[n - 1], e.pts[0]); ctx.closePath(); }
      } else if (e.type === 'CIRCLE') {
        const c = S(e.c); const r = e.r * this.view.k;
        ctx.moveTo(c.x + r, c.y); ctx.arc(c.x, c.y, Math.max(r, 0.5), 0, Math.PI * 2);
      } else if (e.type === 'ARC') {
        const c = S(e.c); const r = Math.max(e.r * this.view.k, 0.5);
        const a0 = -e.a0 * Math.PI / 180, a1 = -e.a1 * Math.PI / 180;
        ctx.moveTo(c.x + r * Math.cos(a0), c.y + r * Math.sin(a0));
        ctx.arc(c.x, c.y, r, a0, a1, true);
      }
    }
    ctx.stroke();
    // 圖塊插入點
    ctx.fillStyle = '#c026d3';
    for (const e of this.flat) {
      if (e.type !== 'INSERT' || !vis(e)) continue;
      const p = S(e.pt); ctx.fillRect(p.x - 2.5, p.y - 2.5, 5, 5);
    }
    // 文字（僅在夠大時繪製，避免小比例時滿版雜訊）
    if (this.view.k > 0.02) {
      ctx.fillStyle = '#64748b';
      for (const e of this.flat) {
        if (e.type !== 'TEXT' || !vis(e)) continue;
        const h = (e.h || 2.5) * this.view.k;
        if (h < 6 || h > 200) continue;
        const p = S(e.pt);
        ctx.font = `${h}px system-ui, sans-serif`;
        ctx.fillText(String(e.text).slice(0, 60), p.x, p.y);
      }
    }
  }

  drawMeasures(ctx) {
    const all = this.active ? this.measurements.concat([this.active]) : this.measurements;
    for (const m of all) {
      const isActive = m === this.active;
      const col = m.type === 'calib' ? '#7c3aed' : m.type === 'count' ? '#c2410c' : m.type === 'area' || m.type === 'rect' ? '#0f766e' : '#1d4ed8';
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = isActive ? 2 : 1.6;
      ctx.setLineDash(isActive ? [6, 4] : []);
      const pts = m.type === 'rect' && m.pts.length === 2 ? rectPts(m.pts) : m.pts;
      if (m.type === 'count') {
        for (const p of pts) { const s = this.toScreen(p); ctx.beginPath(); ctx.arc(s.x, s.y, 5, 0, Math.PI * 2); ctx.fill(); }
      } else if (pts.length) {
        ctx.beginPath();
        pts.forEach((p, i) => { const s = this.toScreen(p); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
        if ((m.type === 'area' || m.type === 'rect') && pts.length > 2) ctx.closePath();
        if (isActive && this.hover && m.type !== 'count') { const s = this.toScreen(this.hover); ctx.lineTo(s.x, s.y); }
        ctx.stroke();
        if ((m.type === 'area' || m.type === 'rect') && pts.length > 2) { ctx.globalAlpha = 0.12; ctx.fill(); ctx.globalAlpha = 1; }
        for (const p of pts) { const s = this.toScreen(p); ctx.fillRect(s.x - 3, s.y - 3, 6, 6); }
      }
      ctx.setLineDash([]);
      const lab = this.label(m);
      if (lab && pts.length) {
        const s = this.toScreen(pts[pts.length - 1]);
        ctx.font = '12px ui-monospace, monospace';
        const w = ctx.measureText(lab).width + 10;
        ctx.fillStyle = 'rgba(15,23,42,.86)';
        ctx.fillRect(s.x + 8, s.y - 20, w, 18);
        ctx.fillStyle = '#fff';
        ctx.fillText(lab, s.x + 13, s.y - 7);
      }
    }
    if (this.snapPt) {
      const s = this.toScreen(this.snapPt);
      ctx.strokeStyle = '#16a34a'; ctx.lineWidth = 1.5;
      ctx.strokeRect(s.x - 5, s.y - 5, 10, 10);
    }
  }

  /* ── 量測計算 ── */

  rawValue(m) {
    const pts = m.type === 'rect' && m.pts.length === 2 ? rectPts(m.pts) : m.pts;
    switch (m.type) {
      case 'count': return pts.length;
      case 'area': case 'rect': return pts.length >= 3 ? DXF.polylineArea(pts, true) : 0;
      case 'angle': return pts.length >= 3 ? angleAt(pts[1], pts[0], pts[2]) : 0;
      default: {
        let L = 0; for (let i = 0; i + 1 < pts.length; i++) L += DXF.dist(pts[i], pts[i + 1]); return L;
      }
    }
  }

  /** 這個點落在哪個比例分區。沒有分區就回 null，用整頁預設。 */
  zoneAt(p) {
    if (!p || !this.scaleZones.length) return null;
    for (let i = this.scaleZones.length - 1; i >= 0; i--) {
      const z = this.scaleZones[i], r = z.rect;
      if (p.x >= Math.min(r.x0, r.x1) && p.x <= Math.max(r.x0, r.x1)
        && p.y >= Math.min(r.y0, r.y1) && p.y <= Math.max(r.y0, r.y1)) return z;
    }
    return null;
  }

  /** 這筆量測該用哪個比例。以量測的第一個點決定分區。 */
  scaleFor(m) {
    const pts = (m && m.pts) || [];
    const z = this.zoneAt(pts[0]);
    if (z && z.metersPerUnit > 0) return { s: z.metersPerUnit, zone: z };
    return { s: this.metersPerUnit, zone: null };
  }

  /**
   * 圖面標示「不按比例（NO SCALE / NTS）」。
   *
   * 這跟「還沒校正」是兩回事：還沒校正是缺一個數字，校了就能算；
   * 不按比例是**圖本身的幾何就不代表實際尺寸**，校正再準也沒有意義。
   * 標單圖、示意圖大量如此，而且圖上通常另外寫著真實尺寸 ——
   * 那些數字要用讀的，不是用量的。
   */
  setNotToScale(on, why) {
    this.notToScale = !!on;
    this.notToScaleWhy = on ? (why || '圖面標示不按比例') : null;
    this.render();
    this.emit('scale', this.scaleInfo());
    return this.scaleInfo();
  }

  /** 換算為工程單位：長度→m、面積→m²、角度→度、計數→個。 */
  engValue(m) {
    const raw = this.rawValue(m);
    if (m.type === 'count') return { value: raw, unit: '個' };
    if (m.type === 'angle') return { value: raw, unit: '°' };
    // 不按比例的圖：不論有沒有校正，都不給工程單位。
    // 給了就等於背書一個沒有意義的數字。
    if (this.notToScale) return { value: null, unit: null, raw, notToScale: true, why: this.notToScaleWhy };
    const { s, zone } = this.scaleFor(m);
    if (!s) return { value: null, unit: null, raw, zone: null };
    if (m.type === 'area' || m.type === 'rect') return { value: raw * s * s, unit: 'M2', zone };
    return { value: raw * s, unit: 'M', zone };
  }

  /* ── 分區比例 ── */

  /**
   * 新增一個比例分區。
   *
   * 真實施工圖的常態：同一張 A1 圖，圖框寫 1:100，但 SECTION A-A 是 1:10。
   * 整張套一個比例，大樣的量測會整批錯 10 倍 —— 而且畫面上完全正常。
   */
  addScaleZone(rect, metersPerUnit, meta = {}) {
    if (!rect || !(metersPerUnit > 0)) return null;
    const z = {
      id: 'z' + Math.random().toString(36).slice(2, 8),
      name: meta.name || `分區 ${this.scaleZones.length + 1}`,
      rect, metersPerUnit,
      method: meta.method || 'two-point',
      ratio: meta.ratio ?? null, rms: meta.rms ?? null,
      at: new Date().toISOString(),
    };
    this.scaleZones.push(z);
    this.render();
    this.emit('scale', this.scaleInfo());
    return z;
  }

  removeScaleZone(id) {
    const i = this.scaleZones.findIndex((z) => z.id === id);
    if (i < 0) return false;
    this.scaleZones.splice(i, 1);
    this.render();
    this.emit('scale', this.scaleInfo());
    return true;
  }

  clearScaleZones() { this.scaleZones = []; this.render(); this.emit('scale', this.scaleInfo()); }

  label(m) {
    const e = this.engValue(m);
    if (m.type === 'calib') return `校正 ${this.rawValue(m).toFixed(1)}`;
    if (e.notToScale) return `${this.rawValue(m).toFixed(1)} (不按比例)`;
    if (e.value == null) return `${this.rawValue(m).toFixed(1)} (未校正)`;
    const d = m.type === 'count' ? 0 : 2;
    return `${e.value.toLocaleString('zh-TW', { maximumFractionDigits: d })} ${e.unit}`;
  }

  /* ── 比例校正 ── */

  /** 兩點校正：可累積多筆，≥2 筆改用最小平方求比例並回報 RMS 殘差。 */
  addCalibration(dUnits, realMeters) {
    if (!(dUnits > 0) || !(realMeters > 0)) return null;
    this.calibrations.push({ d: dUnits, r: realMeters });
    const num = this.calibrations.reduce((a, c) => a + c.d * c.r, 0);
    const den = this.calibrations.reduce((a, c) => a + c.d * c.d, 0);
    const k = num / den;                                  // 最小平方解 r ≈ k·d
    this.metersPerUnit = k;
    if (this.calibrations.length >= 2) {
      const rel = this.calibrations.map((c) => (k * c.d - c.r) / c.r);
      const rms = Math.sqrt(rel.reduce((a, v) => a + v * v, 0) / rel.length);
      this.calibrationRms = rms;
      this.scaleMethod = 'vector-rms';
    } else {
      this.calibrationRms = 0;
      this.scaleMethod = 'two-point';
    }
    this.render();
    this.emit('scale', this.scaleInfo());
    return this.scaleInfo();
  }

  /** 依圖框標註比例設定（1:N）。PDF 專用；DXF 用原生單位。 */
  setDeclaredScale(n) {
    if (!(n > 0)) return null;
    this.metersPerUnit = PT_TO_M * n;
    this.scaleMethod = 'declared-scale';
    this.calibrations = []; this.calibrationRms = null;
    this.render();
    this.emit('scale', this.scaleInfo());
    return this.scaleInfo();
  }

  setNativeUnit(toM) {
    this.metersPerUnit = toM;
    this.scaleMethod = 'native';
    this.render();
    this.emit('scale', this.scaleInfo());
    return this.scaleInfo();
  }

  scaleInfo() {
    return {
      metersPerUnit: this.metersPerUnit,
      method: this.scaleMethod,
      rms: this.calibrationRms ?? null,
      points: this.calibrations.length,
      ratio: this.mode === 'pdf' && this.metersPerUnit ? Math.round(this.metersPerUnit / PT_TO_M) : null,
      zones: this.scaleZones.map((z) => ({ id: z.id, name: z.name, ratio: z.ratio, method: z.method })),
      notToScale: !!this.notToScale, notToScaleWhy: this.notToScaleWhy || null,
    };
  }

  /* ── 吸附 ── */

  /** DXF：真 OSNAP（端點／中點／圓心）；PDF：像素邊緣吸附。 */
  findSnap(worldPt, screenPt) {
    if (!this.snap) return null;
    const tolW = 10 / this.view.k;
    if (this.mode === 'dxf') {
      let best = null, bd = tolW;
      const test = (p, kind) => { const d = Math.hypot(p.x - worldPt.x, p.y - worldPt.y); if (d < bd) { bd = d; best = { ...p, kind }; } };
      for (const e of this.flat) {
        if (this.layerVisible[e.layer || '0'] === false) continue;
        if (e.pts) {
          for (let i = 0; i < e.pts.length; i++) {
            test(e.pts[i], '端點');
            const q = e.pts[i + 1] || (e.closed ? e.pts[0] : null);
            if (q) test({ x: (e.pts[i].x + q.x) / 2, y: (e.pts[i].y + q.y) / 2 }, '中點');
          }
        }
        if (e.pt) test(e.pt, '插入點');
        if (e.c) test(e.c, '圓心');
      }
      return best;
    }
    return this.pixelSnap(screenPt);
  }

  /** 讀取離屏點陣的暗像素，吸附到最近的線條。對掃描件與向量件都有效。 */
  pixelSnap(screenPt) {
    if (!this.raster) return null;
    const rk = this.rasterScale / this.view.k;
    const rx = Math.round((screenPt.x - this.view.tx) * rk);
    const ry = Math.round((screenPt.y - this.view.ty) * rk);
    const R = Math.max(4, Math.round(8 * rk));
    const x0 = Math.max(0, rx - R), y0 = Math.max(0, ry - R);
    const w = Math.min(this.raster.width - x0, R * 2), h = Math.min(this.raster.height - y0, R * 2);
    if (w <= 0 || h <= 0) return null;
    let data;
    try { data = this.raster.getContext('2d', { willReadFrequently: true }).getImageData(x0, y0, w, h).data; }
    catch { return null; }
    let best = null, bd = Infinity;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const lum = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
        if (data[i + 3] < 32 || lum > 110) continue;
        const d = (x0 + x - rx) ** 2 + (y0 + y - ry) ** 2;
        if (d < bd) { bd = d; best = { x: x0 + x, y: y0 + y }; }
      }
    }
    if (!best) return null;
    return { x: best.x / this.rasterScale, y: best.y / this.rasterScale, kind: '影像' };
  }

  /* ── 互動 ── */

  setTool(t) {
    this.tool = t;
    this.active = null;
    this.cv.style.cursor = t === 'pan' ? 'grab' : 'crosshair';
    this.render();
  }

  commit() {
    const m = this.active;
    if (!m) return null;
    const need = m.type === 'angle' ? 3 : m.type === 'count' ? 1 : m.type === 'area' ? 3 : 2;
    if (m.pts.length < need) { this.active = null; this.render(); return null; }
    this.active = null;
    if (m.type === 'calib') {
      const d = DXF.dist(m.pts[0], m.pts[1]);
      this.emit('calib-request', { dUnits: d, measurement: m });
      this.render();
      return null;
    }
    m.id = 'm' + Math.random().toString(36).slice(2, 9);
    m.createdAt = Date.now();
    this.measurements.push(m);
    this.render();
    this.emit('measure', m);
    return m;
  }

  cancel() { this.active = null; this.render(); }
  removeMeasurement(id) {
    this.measurements = this.measurements.filter((m) => m.id !== id);
    this.render(); this.emit('measure-change');
  }
  clearMeasurements() { this.measurements = []; this.render(); this.emit('measure-change'); }

  _bind() {
    const cv = this.cv;
    let dragging = false, last = null, moved = 0;

    cv.addEventListener('contextmenu', (e) => { e.preventDefault(); if (this.active) this.commit(); });

    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      const sp = this._sp(e);
      moved = 0; last = sp;
      if (this.tool === 'pan' || e.button === 1 || e.shiftKey && this.tool === 'pan') { dragging = true; cv.style.cursor = 'grabbing'; }
      else if (e.button === 0) { dragging = false; }
      else { dragging = true; }
    });

    cv.addEventListener('pointermove', (e) => {
      const sp = this._sp(e);
      if (dragging && last) {
        this.view.tx += sp.x - last.x; this.view.ty += sp.y - last.y;
        moved += Math.abs(sp.x - last.x) + Math.abs(sp.y - last.y);
        last = sp; this.render();
        return;
      }
      last = sp;
      if (this.tool === 'pan') { this.snapPt = null; return; }
      let wp = this.toWorld(sp);
      const s = this.findSnap(wp, sp);
      this.snapPt = s ? { x: s.x, y: s.y } : null;
      if (s) wp = { x: s.x, y: s.y };
      if (this.ortho && this.active && this.active.pts.length) {
        const p0 = this.active.pts[this.active.pts.length - 1];
        if (Math.abs(wp.x - p0.x) > Math.abs(wp.y - p0.y)) wp = { x: wp.x, y: p0.y }; else wp = { x: p0.x, y: wp.y };
      }
      this.hover = wp;
      this.render();
      this.emit('hover', { world: wp, snap: s ? s.kind : null });
    });

    cv.addEventListener('pointerup', (e) => {
      try { cv.releasePointerCapture(e.pointerId); } catch { /* 指標已釋放 */ }
      if (dragging) { dragging = false; cv.style.cursor = this.tool === 'pan' ? 'grab' : 'crosshair'; return; }
      if (moved > 4) return;
      if (this.tool === 'pan') return;
      const sp = this._sp(e);
      let wp = this.toWorld(sp);
      const s = this.findSnap(wp, sp);
      if (s) wp = { x: s.x, y: s.y };
      if (this.ortho && this.active && this.active.pts.length) {
        const p0 = this.active.pts[this.active.pts.length - 1];
        if (Math.abs(wp.x - p0.x) > Math.abs(wp.y - p0.y)) wp = { x: wp.x, y: p0.y }; else wp = { x: p0.x, y: wp.y };
      }
      if (!this.active) this.active = { type: this.tool, pts: [] };
      this.active.pts.push(wp);
      const t = TOOLS[this.tool];
      const cap = this.tool === 'rect' ? 2 : this.tool === 'calib' ? 2 : this.tool === 'angle' ? 3 : t.verts;
      if (this.active.pts.length >= cap) this.commit();
      else this.render();
    });

    cv.addEventListener('dblclick', () => { if (this.active) this.commit(); });

    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const sp = this._sp(e);
      const before = this.toWorld(sp);
      const f = Math.exp(-e.deltaY * 0.0015);
      this.view.k = Math.min(Math.max(this.view.k * f, 1e-6), 1e7);
      const after = this.toWorld(sp);
      this.view.tx += (after.x - before.x) * this.view.k;
      this.view.ty += ((this.yUp ? -1 : 1) * (after.y - before.y)) * this.view.k;
      if (this.mode === 'pdf') { clearTimeout(this._rt); this._rt = setTimeout(() => this.ensureRaster().then(() => this.render()), 140); }
      this.render();
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      if (!document.body.contains(cv)) return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (e.key === 'Escape') this.cancel();
      else if (e.key === 'Enter') this.commit();
      else if (e.key === 'Backspace' && this.active) { this.active.pts.pop(); this.render(); }
      else if (e.key === 'o' || e.key === 'O') { this.ortho = !this.ortho; this.emit('flags', { ortho: this.ortho, snap: this.snap }); }
      else if (e.key === 's' || e.key === 'S') { this.snap = !this.snap; this.emit('flags', { ortho: this.ortho, snap: this.snap }); }
      else if (e.key === 'f' || e.key === 'F') this.fit();
    });
  }

  _sp(e) {
    const r = this.cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
}

/** 由 bulge 反算圓弧的圓心、半徑與起訖角（world 座標、y 向上為正角）。 */
function bulgeGeom(p0, p1, b) {
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  const c = Math.hypot(dx, dy);
  if (c < 1e-12) return null;
  const th = 4 * Math.atan(b);                    // 有號夾角
  const R = c / (2 * Math.sin(th / 2));           // 有號半徑
  const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
  const h = R * Math.cos(th / 2);                 // 圓心到弦中點的有號距離
  const center = { x: mx - (dy / c) * h, y: my + (dx / c) * h };
  return {
    center, R: Math.abs(R),
    a0: Math.atan2(p0.y - center.y, p0.x - center.x),
    a1: Math.atan2(p1.y - center.y, p1.x - center.x),
  };
}

function rectPts(p) {
  const [a, b] = p;
  return [{ x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y }];
}

function angleAt(v, a, b) {
  const a1 = Math.atan2(a.y - v.y, a.x - v.x);
  const a2 = Math.atan2(b.y - v.y, b.x - v.x);
  let d = Math.abs(a1 - a2) * 180 / Math.PI;
  if (d > 180) d = 360 - d;
  return d;
}
