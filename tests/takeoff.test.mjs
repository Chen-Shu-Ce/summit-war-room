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

/* ── 合約型態的計價影響 ── */

test('實作實算：圖面量高於標單 → 可計價增量', () => {
  const it = { unit: 'M', qty: { drawing: 1710, boq: 1650 } };
  const r = Q.paymentImpact(it, { contractType: 'remeasure' });
  assert.match(r.label, /可計價增量/);
  assert.match(r.note, /實作實算/);
});

test('實作實算：差異超過容忍時提醒先辦數量變更', () => {
  const it = { unit: 'M', qty: { drawing: 1800, boq: 1650 } };   // 9.1% > 5%
  const r = Q.paymentImpact(it, { contractType: 'remeasure', varianceWarn: 0.05 });
  assert.match(r.note, /數量變更/);
  assert.equal(r.level, 'info');
});

test('實作實算：圖面量低於標單 → 估驗扣減，採購要以圖面量為準', () => {
  const it = { unit: 'M', qty: { drawing: 480, boq: 520 } };
  const r = Q.paymentImpact(it, { contractType: 'remeasure' });
  assert.match(r.label, /計價減量/);
  assert.match(r.note, /扣減/);
});

test('總價承攬：增量標記為承包商自行吸收', () => {
  const it = { unit: 'M', qty: { drawing: 1710, boq: 1650 } };
  const r = Q.paymentImpact(it, { contractType: 'lumpsum' });
  assert.match(r.label, /自行吸收/);
  assert.equal(r.level, 'warn');
});

test('缺少來源時不亂下計價結論', () => {
  assert.equal(Q.paymentImpact({ qty: { drawing: 100 } }).label, '—');
});

test('容忍門檻預設為 5%', () => {
  assert.equal(Q.DEFAULT_SETTINGS.varianceWarn, 0.05);
  assert.equal(Q.resolveBasis({ qty: { drawing: 1710, boq: 1650 } }).status, 'ok');   // 3.6% ≤ 5%
  assert.equal(Q.resolveBasis({ qty: { drawing: 1750, boq: 1650 } }).status, 'review'); // 6.1% > 5%
});

/* ── 自動拆包 ── */

const PKG_ITEMS = [
  { code: 'A', name: '配電盤', unit: '台', leadTimeDays: 120, unitPrice: 100, qty: { drawing: 6, boq: 6 } },
  { code: 'B', name: '冰水管', unit: 'M', leadTimeDays: 45, unitPrice: 10, qty: { drawing: 340, boq: 330 } },
  { code: 'C', name: 'PVC管', unit: 'M', leadTimeDays: 14, unitPrice: 5, qty: { drawing: 480, boq: 490 } },
  { code: 'D', name: '電纜', unit: 'M', leadTimeDays: 45, unitPrice: 20, qty: { drawing: 1710, boq: 1650 } },
  { code: 'E', name: '網路線', unit: 'M', leadTimeDays: 25, unitPrice: 1, qty: { drawing: 5820, boq: 5200 } }, // 11.9% → 鎖定
];

test('自動拆包：依前置期分桶，長前置排最前', () => {
  const r = Q.suggestPackages(PKG_ITEMS, {}, { today: new Date('2026-01-01T00:00:00Z') });
  assert.equal(r.packages[0].bucket, 'long');
  assert.deepEqual(r.packages[0].itemCodes, ['A']);
  const buckets = r.packages.map((p) => p.bucket);
  assert.deepEqual(buckets, ['long', 'short', 'spot']);
});

test('自動拆包：同桶的品項合併，交期取最長前置 + 緩衝', () => {
  const r = Q.suggestPackages(PKG_ITEMS, {}, { today: new Date('2026-01-01T00:00:00Z'), bufferDays: 7 });
  const short = r.packages.find((p) => p.bucket === 'short');
  assert.deepEqual(short.itemCodes.sort(), ['B', 'D']);
  assert.equal(short.maxLead, 45);
  assert.equal(short.needDate, '2026-02-22');            // 1/1 + 52 天
});

test('自動拆包：未過閘門的品項被排除並附原因', () => {
  const r = Q.suggestPackages(PKG_ITEMS, {}, { today: new Date('2026-01-01T00:00:00Z') });
  assert.equal(r.excluded.length, 1);
  assert.equal(r.excluded[0].code, 'E');
  assert.match(r.excluded[0].reason, /超過上限|可信度/);
  assert.ok(!r.packages.some((p) => p.itemCodes.includes('E')));
});

test('自動拆包：指定供應商的品項自成一包', () => {
  const items = PKG_ITEMS.map((i) => (i.code === 'B' ? { ...i, vendor: '甲廠' } : i));
  const r = Q.suggestPackages(items, {}, { today: new Date('2026-01-01T00:00:00Z') });
  const withVendor = r.packages.filter((p) => p.vendor === '甲廠');
  assert.equal(withVendor.length, 1);
  assert.deepEqual(withVendor[0].itemCodes, ['B']);
});

/* ── 圖說解析：規格屬性與 RFI 引擎 ── */
import * as A from '../public/js/takeoff/analysis.js';

test('規格屬性抽取：材質／尺寸／等級／標準', () => {
  const a = A.specAttrs('SUS304 φ50 Sch10 CNS 13392');
  assert.deepEqual(a.material, ['SUS304']);
  assert.ok(a.size.includes('Φ50'), JSON.stringify(a.size));
  assert.ok(a.grade.some((g) => g.includes('SCH10')), JSON.stringify(a.grade));
  assert.ok(a.standard.some((s) => s.startsWith('CNS')), JSON.stringify(a.standard));
});

test('規格完整性：材料類需材質＋尺寸＋標準', () => {
  const full = { measureType: 'length', name: '不鏽鋼給水管', spec: 'SUS304 φ50 Sch10 CNS 13392' };
  const thin = { measureType: 'length', name: '水管', spec: 'φ50' };
  assert.equal(A.specCompleteness(full).ok, true);
  const r = A.specCompleteness(thin);
  assert.equal(r.ok, false);
  assert.ok(r.missing.includes('material') && r.missing.includes('standard'), JSON.stringify(r.missing));
});

test('統包項（式）不判規格完整性', () => {
  assert.equal(A.specCompleteness({ measureType: 'lumpsum', spec: 'TAB 含報告書' }).ok, true);
});

test('標籤計數：MCC-1、MCC-2 算兩個實例', () => {
  const r = A.countTag('平面圖標示 MCC-1 與 MCC-2，另有 MCC-1 重覆標註', 'MCC');
  assert.equal(r.count, 2);
  assert.deepEqual(r.instances.sort(), ['MCC-1', 'MCC-2']);
});

const RFI_ITEMS = [
  { code: '410.01', wbs: '410', name: '不鏽鋼給水管', spec: 'SUS304 φ50 Sch10 CNS 13392', unit: 'M',
    measureType: 'length', qty: { drawing: 620, boq: 600 }, drawingSource: 'measure', coverage: 'full' },
  { code: '310.01', wbs: '310', name: '低壓配電盤 MCC', spec: '480V 3P4W 800A IP54 CNS 3990', unit: '台',
    measureType: 'count', equipTag: 'MCC', qty: { drawing: 6, boq: 6 }, drawingSource: 'auto', coverage: 'full' },
  { code: '710.01', wbs: '710', name: 'Cat.6A UTP 網路線', spec: '4P 23AWG LSZH TIA-568-C.2', unit: 'M',
    measureType: 'length', qty: { drawing: 5820, boq: 5200 }, drawingSource: 'auto', coverage: 'partial' },
  { code: '810.01', wbs: '810', name: '不鏽鋼工作檯', spec: '', unit: '台',
    measureType: 'count', qty: {}, coverage: 'none' },
];

const RFI_DOCS = [
  { id: 'd1', kind: 'drawing', sheetType: 'plan', name: 'E-P-01 電氣平面圖', scaleSet: true,
    text: '電氣平面圖\nMCC-1 位於 B1 機房\nMCC-2 位於 1F 機房\nMCC-3 位於 2F 機房' },
  { id: 'd2', kind: 'drawing', sheetType: 'system', name: 'E-S-01 電氣單線系統圖', scaleSet: false,
    text: '單線系統圖\nMCC-1\nMCC-2' },
  { id: 'd3', kind: 'spec', name: '機電工程規範.pdf',
    text: '第 22 節 給水管路\n不鏽鋼給水管 應採用 SUS316 φ50 Sch10，符合 CNS 13392。\n第 26 節 配電盤' },
  { id: 'd4', kind: 'equipment', name: '設備表.csv', text: 'TAG,名稱\nMCC-1,配電盤\nMCC-2,配電盤\nMCC-3,配電盤' },
];

const CTX = { items: RFI_ITEMS, docs: RFI_DOCS, settings: { varianceWarn: 0.05, varianceStop: 0.10 } };

test('RFI：圖說 ≠ BOQ（差異超過容忍）', () => {
  const r = A.detectRfi(CTX).filter((x) => x.type === 'drawing-vs-boq');
  assert.equal(r.length, 1);
  assert.equal(r[0].itemCode, '710.01');
  assert.equal(r[0].severity, 'high');            // 11.9% > 10%
  assert.ok(r[0].evidence.length >= 3);
});

test('RFI：圖說 ≠ 規範（SUS304 對上規範的 SUS316）', () => {
  const r = A.detectRfi(CTX).filter((x) => x.type === 'drawing-vs-spec');
  assert.equal(r.length, 1);
  assert.equal(r[0].itemCode, '410.01');
  assert.match(r[0].question, /SUS316/);
  assert.match(r[0].question, /機電工程規範/);
});

test('RFI：平面圖 3 處 vs 系統圖 2 處', () => {
  const r = A.detectRfi(CTX).filter((x) => x.type === 'plan-vs-system');
  assert.equal(r.length, 1);
  assert.match(r[0].title, /平面圖 3 處、系統圖 2 處/);
});

test('RFI：數量無法判斷與規格不完整', () => {
  const all = A.detectRfi(CTX);
  const q = all.filter((x) => x.type === 'qty-undeterminable');
  assert.equal(q.length, 1);
  assert.equal(q[0].itemCode, '810.01');
  assert.equal(q[0].severity, 'high');
  const sp = all.filter((x) => x.type === 'spec-incomplete');
  assert.ok(sp.some((x) => x.itemCode === '810.01'), '空白規格應被抓出');
});

test('RFI：依嚴重度排序並給連續編號', () => {
  const all = A.detectRfi(CTX);
  assert.equal(all[0].code, 'RFI-001');
  const sev = all.map((r) => r.severity);
  const rank = { high: 0, med: 1, low: 2 };
  for (let i = 1; i < sev.length; i++) assert.ok(rank[sev[i - 1]] <= rank[sev[i]], sev.join(','));
  assert.ok(all.every((r) => r.askTo));
});

test('分析範圍過濾：只看 400 大類', () => {
  const r = A.detectRfi({ ...CTX, scope: ['400'] });
  assert.ok(r.every((x) => String(x.wbs).startsWith('4')), JSON.stringify(r.map((x) => x.wbs)));
});

test('九項指標：全部由實際資料算出', () => {
  const m = A.metrics(CTX);
  assert.equal(m.itemCount, 4);
  assert.equal(m.wbsCount, 4);
  assert.equal(m.qtyConfirmed, 2);          // 710.01 差異 11.9% 被鎖定、810.01 完全無數量
  assert.equal(m.varianceCount, 1);
  assert.ok(m.rfiCount >= 4);
  assert.equal(m.longLeadCount, 0);
});

test('圖說完整性：五項加權且可攤開', () => {
  const m = A.metrics(CTX);
  const c = m.completeness;
  assert.ok(c.value > 0 && c.value < 1, String(c.value));
  assert.equal(c.parts.length, 5);
  assert.ok(Math.abs(c.parts.reduce((a, p) => a + p.weight, 0) - 1) < 1e-9, '權重必須合計為 1');
  const scale = c.parts.find((p) => p.key === 'scale');
  assert.equal(scale.score, 0.5);           // 兩份圖面只有一份設了比例
});

test('圖說完整性：沒有任何資料時不會憑空生出百分比', () => {
  const c = A.completeness({ items: [], docs: [] }, []);
  assert.equal(c.value, 0);
});

test('規範衝突：泛稱（不鏽鋼）不得用來認定衝突，也不得掩蓋真衝突', () => {
  const item = { name: '不鏽鋼給水管', spec: 'SUS304 φ50' };
  const same = { name: 'x', text: '不鏽鋼給水管 採用 SUS304 φ50' };
  const diff = { name: 'y', text: '不鏽鋼給水管 應採用 SUS316 φ50' };
  const vague = { name: 'z', text: '不鏽鋼給水管 依圖施作' };
  assert.equal(A.specConflict(item, same), null, '同材質不應報衝突');
  assert.ok(A.specConflict(item, diff), 'SUS304 vs SUS316 必須報衝突');
  assert.equal(A.specConflict(item, vague), null, '規範沒寫具體材質時不得宣稱衝突');
});

test('規格完整性：混凝土以強度為規格，不得要求材質尺寸而生出假 RFI', () => {
  const conc = { measureType: 'volume', name: '結構混凝土', spec: "f'c=280 kgf/cm² 泵送 CNS 3090" };
  assert.equal(A.specCompleteness(conc).ok, true, JSON.stringify(A.specCompleteness(conc).missing));
  const rebar = { measureType: 'weight', name: '竹節鋼筋', spec: 'SD420W #8 (D25) CNS 560' };
  assert.equal(A.specCompleteness(rebar).ok, true, JSON.stringify(A.specCompleteness(rebar).missing));
});

test('規格完整性：工項可自訂必要屬性', () => {
  const it = { measureType: 'length', spec: 'φ50', requiredSpec: ['size'] };
  assert.equal(A.specCompleteness(it).ok, true);
});
