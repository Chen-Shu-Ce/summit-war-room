/** node --test tests/  —— 算量核心與 DXF 解析的回歸測試 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Q from '../public/js/takeoff/quantity.js';
import * as D from '../public/js/takeoff/dxf.js';

const near = (a, b, tol = 1e-6, m = '') => assert.ok(Math.abs(a - b) <= tol, `${m} 期待 ${b} 實得 ${a}`);

/* ── 數量引擎 ── */

test('附件一情境：1,700 × 1.03 = 1,751', () => {
  const it = { qty: { drawing: 1710, boq: 1650, manual: 1700 }, wasteRate: 0.03, order: { unit: 'M', unitFactor: 1 } };
  const p = Q.suggestPurchase(it);
  assert.equal(p.basis.basis, 'manual');
  assert.equal(p.baseQty, 1700);
  assert.equal(p.wasteQty, 51);
  assert.equal(p.suggestQty, 1751);          // 不得因浮點誤差變成 1751.0000000000002
  assert.equal(p.deliveredQty, 1751);
});

test('差異率以 BOQ 量為分母', () => {
  const v = Q.variance(1710, 1650);
  assert.equal(v.abs, 60);
  near(v.pct, 60 / 1650, 1e-12);
});

test('差異超過上限時鎖定，不得產生建議採購量', () => {
  const it = { qty: { drawing: 5820, boq: 5200 }, wasteRate: 0.08 };
  const p = Q.suggestPurchase(it);
  assert.equal(p.blocked, true);
  assert.equal(p.suggestQty, null);
  assert.equal(p.basis.status, 'blocked');
});

test('差異落在警戒與上限之間 → 採圖面量但標記需複核', () => {
  const it = { qty: { drawing: 1240, boq: 1220 } };            // 1.64% → ok
  assert.equal(Q.resolveBasis(it).status, 'ok');
  const it2 = { qty: { drawing: 214, boq: 198 } };             // 8.08% → review
  const r2 = Q.resolveBasis(it2);
  assert.equal(r2.basis, 'drawing');
  assert.equal(r2.status, 'review');
});

test('包裝倍數與 MOQ：620M 給水管 → 6M/支', () => {
  const it = { qty: { drawing: 620, boq: 600 }, wasteRate: 0.05, order: { unit: '支', unitFactor: 6, packMultiple: 1, moq: 10 } };
  const p = Q.suggestPurchase(it);
  assert.equal(p.baseQty, 620);
  assert.equal(p.suggestQty, 651);
  assert.equal(p.orderQty, 109);              // ceil(651/6) = 108.5 → 109
  assert.equal(p.deliveredQty, 654);
  near(p.overshoot, (654 - 620) / 620, 1e-6);
});

test('MOQ 生效時以 MOQ 為下單量', () => {
  const it = { qty: { drawing: 12 }, wasteRate: 0, order: { unit: '箱', unitFactor: 6, moq: 5 } };
  const p = Q.suggestPurchase(it);
  assert.equal(p.orderQty, 5);
  assert.equal(p.moqApplied, true);
  assert.equal(p.deliveredQty, 30);
});

test('ceilTo 不因浮點雜訊多進一階', () => {
  assert.equal(Q.ceilTo(1751.0000000000002, 1), 1751);
  assert.equal(Q.ceilTo(1751.4, 1), 1752);
  assert.equal(Q.ceilTo(107, 5), 110);
});

test('可信度：人工確認不列入交叉驗證（避免自我印證）', () => {
  const withManual = { qty: { drawing: 1710, boq: 1650, manual: 1700 }, manualBy: 'A', manualNote: 'B', measureType: 'length', drawingSource: 'measure', layerMapped: true, coverage: 'full', calibration: 'two-point', calibrationRms: 0.001 };
  const c = Q.confidence(withManual);
  const agree = c.factors.find((f) => f.label.includes('一致'));
  assert.ok(agree, '應有一致性因子');
  assert.ok(!agree.label.includes('三來源'), '兩個獨立來源不應被算成三來源');
});

test('可信度：人工值落在來源區間外要扣分', () => {
  const good = { qty: { drawing: 1710, boq: 1650, manual: 1700 }, manualBy: 'A', manualNote: 'B' };
  const bad = { qty: { drawing: 1710, boq: 1650, manual: 1200 }, manualBy: 'A', manualNote: 'B' };
  assert.ok(Q.confidence(bad).score < Q.confidence(good).score);
  assert.ok(Q.confidence(bad).factors.some((f) => f.label.includes('區間外')));
});

test('可信度：正分封頂，不會飽和成無鑑別力', () => {
  const c = Q.confidence({ qty: { drawing: 1710, boq: 1650, manual: 1700 }, manualBy: 'A', manualNote: 'B', layerMapped: true, coverage: 'full' });
  assert.ok(c.score <= 100);
  assert.equal(c.band, 'A');
  const weak = Q.confidence({ qty: { drawing: 500 }, drawingSource: 'auto', layerMapped: false, coverage: 'partial', measureType: 'length' });
  assert.ok(weak.score < c.score - 20, '弱證據必須明顯低分');
});

test('未校正的 PDF 量測會被重罰', () => {
  const base = { qty: { drawing: 1000, boq: 1000 }, measureType: 'length', drawingSource: 'measure', layerMapped: true, coverage: 'full' };
  const cal = Q.confidence({ ...base, calibration: 'two-point', calibrationRms: 0.002 });
  const un = Q.confidence({ ...base, calibration: 'none' });
  assert.ok(un.score < cal.score);
  assert.ok(un.factors.some((f) => f.label.includes('未做比例校正')));
});

test('未封閉輪廓求面積要扣分', () => {
  const a = Q.confidence({ qty: { drawing: 100, boq: 100 }, measureType: 'area', closed: true, layerMapped: true, coverage: 'full' });
  const b = Q.confidence({ qty: { drawing: 100, boq: 100 }, measureType: 'area', closed: false, layerMapped: true, coverage: 'full' });
  assert.ok(b.score < a.score);
});

/* ── DXF 解析 ── */

const doc = D.parseDxf(readFileSync(new URL('./fixture.dxf', import.meta.url), 'utf8'));

test('DXF：讀到單位與圖層', () => {
  assert.equal(doc.header.$INSUNITS, 4);
  assert.equal(doc.units.name, '公厘');
  assert.ok(Object.keys(doc.layers).length >= 3, JSON.stringify(Object.keys(doc.layers)));
  assert.ok(doc.blocks['LUM-150W'], '圖塊應被解析');
});

test('DXF：3-4-5 直線長度 = 5000', () => {
  const line = doc.entities.find((e) => e.type === 'LINE');
  near(D.dist(line.pts[0], line.pts[1]), 5000, 1e-9);
});

test('DXF：封閉矩形周長 6000、面積 2,000,000', () => {
  const agg = D.aggregateByLayer(doc).find((g) => g.layer === 'S-FORM');
  near(agg.area, 2000000 + Math.PI * 500 * 500, 1e-6, '面積 = 矩形 + 圓');
  near(agg.length, 6000 + 2 * Math.PI * 500, 1e-6, '長度 = 周長 + 圓周');
  assert.equal(agg.closedCount, 2);
});

test('DXF：bulge=1 兩點距 2000 → 半圓弧長 π·1000', () => {
  const b = D.bulgeArc({ x: 0, y: 0 }, { x: 2000, y: 0 }, 1);
  near(b.len, Math.PI * 1000, 1e-9);
  near(b.R, 1000, 1e-9);
});

test('DXF：電纜圖層長度 = 直線 + 1/4 圓弧 + 半圓', () => {
  const agg = D.aggregateByLayer(doc).find((g) => g.layer === 'E-CABLE-PWR');
  near(agg.length, 5000 + (Math.PI / 2) * 1000 + Math.PI * 1000, 1e-6);
});

test('DXF：圖塊插入含陣列 → 4 個燈具、展開長度 400', () => {
  const agg = D.aggregateByLayer(doc).find((g) => g.layer === 'E-LITE');
  assert.equal(agg.blocks['LUM-150W'], 4, '2 個單插 + 1 個 2 欄陣列 = 4');
  near(agg.length, 400, 1e-9, '每個圖塊內含 100 長線段');
});

test('DXF：邊界框涵蓋所有實體', () => {
  const b = D.bounds(doc);
  assert.ok(b.minX <= 0 && b.maxX >= 9000 && b.maxY >= 9000, JSON.stringify(b));
});

test('DXF：偵測二進位 DXF 與 DWG 版本標記', () => {
  const bin = new TextEncoder().encode('AutoCAD Binary DXF\r\n').buffer;
  assert.equal(D.isBinaryDxf(bin), true);
  const dwg = new TextEncoder().encode('AC1032abcdef').buffer;
  assert.equal(D.dwgVersion(dwg).name, 'AutoCAD 2018+');
});
