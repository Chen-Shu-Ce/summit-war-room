/** Baseline 凍結、變更對照、PR 編號與 ERP 匯出的回歸測試。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as B from '../public/js/takeoff/baseline.js';

const SETTINGS = { varianceWarn: 0.05, varianceStop: 0.10, defaultWasteRate: 0.03, gateBand: 'C' };

const mkItem = (over = {}) => ({
  code: '321.01', wbs: '321', name: '低壓電力電纜 XLPE', spec: '600V 3C×38mm² CNS 11174',
  unit: 'M', erpCode: 'CB-38-001', measureType: 'length',
  qty: { drawing: 1710, boq: 1650, manual: 1700 }, manualBy: 'A', manualNote: 'B',
  wasteRate: 0.03, order: { unit: 'M', unitFactor: 1, packMultiple: 1, moq: 0 },
  unitPrice: 780, leadTimeDays: 45, drawingSource: 'measure', coverage: 'full', layerMapped: true,
  ...over,
});

/* ── PR 編號 ── */

test('PR 編號：依你的範例 PR-202609130001 產生', () => {
  const no = B.formatPrNo(B.DEFAULT_PR_TEMPLATE, new Date('2026-09-13T00:00:00'), 1);
  assert.equal(no, 'PR-202609130001');
});

test('PR 編號：樣板可改成只到月', () => {
  const t = 'PR-{YYYY}{MM}{SEQ:4}';
  assert.equal(B.formatPrNo(t, new Date('2026-09-13T00:00:00'), 7), 'PR-2026090007');
});

test('PR 編號：重置範圍由樣板自動推導，不會自相矛盾', () => {
  assert.equal(B.resetScopeOf('PR-{YYYY}{MM}{DD}{SEQ:4}'), 'day');
  assert.equal(B.resetScopeOf('PR-{YYYY}{MM}{SEQ:4}'), 'month');
  assert.equal(B.resetScopeOf('PR-{YYYY}{SEQ:4}'), 'year');
  assert.equal(B.resetScopeOf('PR-{SEQ:6}'), 'never');
  assert.equal(B.resetScopeOf('PR-{YYYY}{MM}{DD}{SEQ:4}', 'month'), 'month', '仍可明確覆寫');
});

test('PR 編號：同一天接續，跨日重置', () => {
  const d1 = new Date('2026-09-13T00:00:00');
  const d2 = new Date('2026-09-14T00:00:00');
  const existing = [];
  existing.push(B.nextPrNo(existing, B.DEFAULT_PR_TEMPLATE, d1));
  existing.push(B.nextPrNo(existing, B.DEFAULT_PR_TEMPLATE, d1));
  existing.push(B.nextPrNo(existing, B.DEFAULT_PR_TEMPLATE, d1));
  assert.deepEqual(existing, ['PR-202609130001', 'PR-202609130002', 'PR-202609130003']);
  assert.equal(B.nextPrNo(existing, B.DEFAULT_PR_TEMPLATE, d2), 'PR-202609140001', '跨日要重置');
});

test('PR 編號：只到月的樣板跨日不重置、跨月才重置', () => {
  const t = 'PR-{YYYY}{MM}{SEQ:4}';
  const a = B.nextPrNo([], t, new Date('2026-09-13T00:00:00'));
  const b = B.nextPrNo([a], t, new Date('2026-09-28T00:00:00'));
  assert.equal(b, 'PR-2026090002');
  assert.equal(B.nextPrNo([a, b], t, new Date('2026-10-01T00:00:00')), 'PR-2026100001');
});

test('PR 編號：不受其他區間的舊號干擾', () => {
  const old = ['PR-202608310099', 'PR-202512310123'];
  assert.equal(B.nextPrNo(old, B.DEFAULT_PR_TEMPLATE, new Date('2026-09-13T00:00:00')), 'PR-202609130001');
});

/* ── Baseline 凍結 ── */

const PKG = { code: 'PKG-001', name: '電氣採購包' };

test('Baseline：沒有工程確認人不得凍結', () => {
  const r = B.freezeBaseline(PKG, [mkItem()], SETTINGS, {});
  assert.match(r.error, /工程確認人/);
});

test('Baseline：凍結後保留採購狀態快照與總額', () => {
  const { baseline } = B.freezeBaseline(PKG, [mkItem()], SETTINGS, { confirmedBy: '工程部 李經理' });
  assert.equal(baseline.rev, 1);
  assert.equal(baseline.confirmedBy, '工程部 李經理');
  assert.equal(baseline.items.length, 1);
  const s = baseline.items[0];
  assert.equal(s.basisValue, 1700);
  assert.equal(s.suggestQty, 1751);
  assert.equal(s.band, 'A');
  assert.equal(s.erpCode, 'CB-38-001');
  assert.equal(baseline.totals.cost, 1751 * 780);
});

test('Baseline：重新凍結產生新版並指向前一版', () => {
  const a = B.freezeBaseline(PKG, [mkItem()], SETTINGS, { confirmedBy: 'X' }).baseline;
  const b = B.freezeBaseline(PKG, [mkItem()], SETTINGS, { confirmedBy: 'X', previous: a, existing: [a] }).baseline;
  assert.equal(b.rev, 2);
  assert.equal(b.supersedes, a.id);
  assert.equal(a.code, 'BL-PKG-001-01');
  assert.equal(b.code, 'BL-PKG-001-02');
});

/* ── 變更對照 ── */

test('變更對照：沒動過就是乾淨的', () => {
  const items = [mkItem()];
  const { baseline } = B.freezeBaseline(PKG, items, SETTINGS, { confirmedBy: 'X' });
  const d = B.diffAgainstBaseline(items, baseline, SETTINGS);
  assert.equal(d.dirty, false);
  assert.equal(d.changed.length, 0);
  assert.equal(d.costDelta, 0);
});

test('變更對照：數量改動要抓出欄位與差額', () => {
  const { baseline } = B.freezeBaseline(PKG, [mkItem()], SETTINGS, { confirmedBy: 'X' });
  const after = [mkItem({ qty: { drawing: 1710, boq: 1650, manual: 1760 } })];
  const d = B.diffAgainstBaseline(after, baseline, SETTINGS);
  assert.equal(d.dirty, true);
  const ch = d.changed[0];
  const base = ch.fields.find((f) => f.key === 'basisValue');
  assert.equal(base.before, 1700);
  assert.equal(base.after, 1760);
  assert.equal(base.delta, 60);
  const sug = ch.fields.find((f) => f.key === 'suggestQty');
  assert.equal(sug.after, 1812.8);
  assert.ok(d.costDelta > 0);
});

test('變更對照：規格與單價改動也會被抓', () => {
  const { baseline } = B.freezeBaseline(PKG, [mkItem()], SETTINGS, { confirmedBy: 'X' });
  const d = B.diffAgainstBaseline([mkItem({ spec: '改成 SUS316', unitPrice: 900 })], baseline, SETTINGS);
  const keys = d.changed[0].fields.map((f) => f.key).sort();
  assert.ok(keys.includes('spec') && keys.includes('unitPrice') && keys.includes('cost'), keys.join(','));
});

test('變更對照：新增與移除工項', () => {
  const { baseline } = B.freezeBaseline(PKG, [mkItem()], SETTINGS, { confirmedBy: 'X' });
  const d = B.diffAgainstBaseline([mkItem({ code: '999.99' })], baseline, SETTINGS);
  assert.equal(d.added.length, 1);
  assert.equal(d.removed.length, 1);
  assert.equal(d.removed[0].code, '321.01');
});

test('變更對照：浮點雜訊不得被當成變更', () => {
  const { baseline } = B.freezeBaseline(PKG, [mkItem()], SETTINGS, { confirmedBy: 'X' });
  baseline.items[0].suggestQty = 1751.0000000000002;
  const d = B.diffAgainstBaseline([mkItem()], baseline, SETTINGS);
  assert.equal(d.dirty, false);
});

/* ── PR 與 ERP ── */

test('PR：缺料號或缺單價會先擋下來，不到 ERP 才退件', () => {
  const bl = B.freezeBaseline(PKG, [mkItem({ erpCode: '' }), mkItem({ code: 'x', unitPrice: null })], SETTINGS, { confirmedBy: 'X' }).baseline;
  const r = B.prReadiness(bl);
  assert.equal(r.ok, false);
  assert.equal(r.missingCode.length, 1);
  assert.equal(r.missingPrice.length, 1);
  assert.equal(B.prReadiness(bl, { requireErpCode: false }).missingCode.length, 0);
});

test('PR：必須有請購人', () => {
  const bl = B.freezeBaseline(PKG, [mkItem()], SETTINGS, { confirmedBy: 'X' }).baseline;
  assert.match(B.createPr(bl, {}).error, /請購人/);
});

test('PR：表頭金額與稅額', () => {
  const bl = B.freezeBaseline(PKG, [mkItem()], SETTINGS, { confirmedBy: 'X' }).baseline;
  const { pr } = B.createPr(bl, { requester: '採購 陳小姐', date: '2026-09-13T00:00:00', needDate: '2026-11-01' }, []);
  assert.equal(pr.no, 'PR-202609130001');
  assert.equal(pr.lines.length, 1);
  assert.equal(pr.subtotal, 1751 * 780);
  assert.equal(pr.tax, Math.round(1751 * 780 * 0.05 * 100) / 100);
  assert.equal(pr.total, pr.subtotal + pr.tax);
  assert.equal(pr.lines[0].erpCode, 'CB-38-001');
});

test('PR：單價要換算到訂購單位，6M/支不能算成 1/6 價', () => {
  const pipe = mkItem({
    code: '410.01', name: '不鏽鋼給水管', unit: 'M', unitPrice: 1180,
    qty: { drawing: 620, boq: 600 }, manual: undefined,
    order: { unit: '支', unitFactor: 6, packMultiple: 1, moq: 10 }, wasteRate: 0.05,
  });
  delete pipe.qty.manual;
  const bl = B.freezeBaseline(PKG, [pipe], SETTINGS, { confirmedBy: 'X' }).baseline;
  const { pr } = B.createPr(bl, { requester: 'X' }, []);
  const l = pr.lines[0];
  assert.equal(l.unit, '支');
  assert.equal(l.qty, 109);                 // ceil(620×1.05 / 6)
  assert.equal(l.unitPrice, 1180 * 6);      // 每支 = 每公尺 × 6
  assert.equal(l.amount, 109 * 1180 * 6);
});

test('ERP 匯出：兩檔式表頭＋明細', () => {
  const bl = B.freezeBaseline(PKG, [mkItem()], SETTINGS, { confirmedBy: 'X' }).baseline;
  const { pr } = B.createPr(bl, { requester: 'X', date: '2026-09-13T00:00:00' }, []);
  const { files } = B.toErpTables(pr, 'generic');
  assert.equal(files.length, 2);
  assert.match(files[0].name, /-header\.csv$/);
  assert.equal(files[0].rows[0][0], 'PR 單號');
  assert.equal(files[0].rows[1][0], 'PR-202609130001');
  assert.equal(files[1].rows[0][1], '項次');
  assert.equal(files[1].rows[1][0], 'PR-202609130001', '明細要帶單號才能對回表頭');
});

test('ERP 匯出：單檔式把表頭攤進每一列', () => {
  const bl = B.freezeBaseline(PKG, [mkItem(), mkItem({ code: 'y' })], SETTINGS, { confirmedBy: 'X' }).baseline;
  const { pr } = B.createPr(bl, { requester: 'X' }, []);
  const { files } = B.toErpTables(pr, 'flat');
  assert.equal(files.length, 1);
  assert.equal(files[0].rows.length, 3);
  assert.equal(files[0].rows[1][0], pr.no);
  assert.equal(files[0].rows[2][0], pr.no);
});

test('ERP 匯出：欄位名稱可對映成對方 ERP 的欄名', () => {
  const bl = B.freezeBaseline(PKG, [mkItem()], SETTINGS, { confirmedBy: 'X' }).baseline;
  const { pr } = B.createPr(bl, { requester: 'X' }, []);
  const { files } = B.toErpTables(pr, 'generic', {
    header: { no: 'PURCH_NO', requester: 'APPLY_USER' },
    line: { erpCode: 'ITEM_NO', qty: 'QTY' },
  });
  assert.equal(files[0].rows[0][0], 'PURCH_NO');
  assert.equal(files[0].rows[0][2], 'APPLY_USER');
  assert.ok(files[1].rows[0].includes('ITEM_NO') && files[1].rows[0].includes('QTY'));
});
