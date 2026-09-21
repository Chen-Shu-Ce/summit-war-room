/**
 * 造價層的測試。
 *
 * 這裡每一個期望值都是手算的，不是把程式跑出來的數字貼回來。
 * 重點在三件事：
 *   1. C 類（信心 <50）**絕對不可以**出現在總價裡
 *   2. 損耗不可以被算兩次
 *   3. 計價數量不是採購數量
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../public/js/takeoff/costing.js';

/* ── 分級 ── */

test('信心分數依造價作業規則分成四級', () => {
  assert.equal(C.classify(95).band, 'A');
  assert.equal(C.classify(90).band, 'A', '90 是 A 的下界，含');
  assert.equal(C.classify(89).band, 'B');
  assert.equal(C.classify(75).band, 'B');
  assert.equal(C.classify(74).band, 'C');
  assert.equal(C.classify(50).band, 'C');
  assert.equal(C.classify(49).band, 'D');
  assert.equal(C.classify(0).band, 'D');
});

test('四級再收斂成 A／B／C 三類', () => {
  assert.equal(C.classify(95).cls, 'A');
  assert.equal(C.classify(80).cls, 'B');
  assert.equal(C.classify(60).cls, 'B', '可初估也算 B —— 暫估但要人確認');
  assert.equal(C.classify(30).cls, 'C');
});

test('只有 C 類不計入總價，A 與 B 都計入', () => {
  assert.equal(C.classify(95).inTotal, true);
  assert.equal(C.classify(60).inTotal, true);
  assert.equal(C.classify(30).inTotal, false);
});

test('A 類不需人工確認，B 與 C 都要', () => {
  assert.equal(C.classify(95).needCheck, false);
  assert.equal(C.classify(80).needCheck, true);
  assert.equal(C.classify(30).needCheck, true);
});

test('沒有分數視同 0 分，落在 C 類 —— 不是預設通過', () => {
  assert.equal(C.classify(undefined).cls, 'C');
  assert.equal(C.classify(null).inTotal, false);
});

/* ── 計價數量 ── */

test('計價數量 = 圖面淨量 ×(1+損耗) + 施工預留', () => {
  // 1000 × 1.08 = 1080，+ 預留 20 = 1100
  const bq = C.billQty({ qty: { drawing: 1000 }, wasteRate: 0.08, reserveQty: 20 }, {});
  assert.equal(bq.net, 1000);
  assert.equal(bq.qty, 1100);
});

test('沒填損耗率時用設定的預設值', () => {
  // 200 × 1.05 = 210
  const bq = C.billQty({ qty: { drawing: 200 } }, { defaultWasteRate: 0.05 });
  assert.equal(bq.qty, 210);
});

test('單價分析已含損耗時不再乘一次 —— 否則 8% 會被算兩遍', () => {
  const item = { qty: { drawing: 1000 }, wasteRate: 0.08 };
  const normal = C.billQty(item, {});
  const dedup = C.billQty(item, { wasteInUnitPrice: true });
  assert.equal(normal.qty, 1080);
  assert.equal(dedup.qty, 1000, '定額單價已含損耗，數量就是淨量');
  assert.equal(dedup.wasteSkipped, true);
});

test('沒有圖面量時退回人工確認量，並記錄是哪一種來源', () => {
  const bq = C.billQty({ qty: { drawing: null, manual: 500 }, wasteRate: 0 }, {});
  assert.equal(bq.qty, 500);
  assert.equal(bq.src, 'manual');
});

test('完全沒有數量時回 null，不回 0 —— 0 會被加進總價', () => {
  const bq = C.billQty({ qty: {} }, {});
  assert.equal(bq.qty, null);
  assert.equal(bq.src, null);
});

/* ── 單價 ── */

test('未拆分的舊單價不會被硬拆成材料／人工', () => {
  const p = C.priceOf({ unitPrice: 300 });
  assert.equal(p.kind, 'all-in');
  assert.equal(p.total, 300);
  assert.equal(p.mat, null, '不可以把全包價當成材料價 —— 之後填人工會憑空多一截');
  assert.equal(p.lab, null);
});

test('已拆分時材料＋人工＋機具相加', () => {
  const p = C.priceOf({ priceKind: 'split', matPrice: 200, labPrice: 80, eqpPrice: 20 });
  assert.equal(p.total, 300);
  assert.deepEqual(p.missing, []);
});

test('拆分但缺人工單價 → 標出來，不當成 0', () => {
  const p = C.priceOf({ priceKind: 'split', matPrice: 200 });
  assert.equal(p.total, 200);
  assert.deepEqual(p.missing, ['人工']);
});

test('完全沒單價 → 待詢價', () => {
  const p = C.priceOf({});
  assert.equal(p.total, null);
  assert.deepEqual(p.missing, ['單價']);
  assert.equal(p.quoted, false);
});

/* ── 價格敏感材料 ── */

test('指名的敏感材料會被標出來', () => {
  assert.deepEqual(C.sensitivityOf({ name: '低壓電力電纜 XLPE', spec: '600V 3C×38mm² CU/XLPE' }),
    ['銅', '電纜']);
  assert.deepEqual(C.sensitivityOf({ name: '厚金屬管 (RSC)', spec: 'φ50mm 熱浸鍍鋅' }), []);
});

test('比不到就不是敏感項 —— 不憑「看起來像金屬」猜', () => {
  assert.deepEqual(C.sensitivityOf({ name: '接線盒', spec: '4"×4"' }), []);
});

test('短的英文代號要卡邊界：CIRCUIT 裡的 CU 不是銅', () => {
  assert.deepEqual(C.sensitivityOf({ name: 'BRANCH CIRCUIT', spec: '' }), [],
    'CIRCUIT 含 CU，直接比子字串會把迴路標成銅材');
  assert.deepEqual(C.sensitivityOf({ name: 'VALVE', spec: '' }), [], 'VALVE 含 AL');
  assert.deepEqual(C.sensitivityOf({ name: 'BUSBAR', spec: 'CU 100A' }), ['銅'],
    '獨立的 CU 仍然要認得出來');
});

/* ── 一列 BOM ── */

const ROW = (item, ctx) => {
  const r = C.costRow(item, ctx);
  return Object.fromEntries(C.COST_HEAD.map((h, i) => [h, r[i]]));
};

test('22 欄，順序固定', () => {
  assert.equal(C.COST_HEAD.length, 22);
  assert.equal(C.COST_HEAD[0], '序號');
  assert.equal(C.COST_HEAD[21], '備註');
});

test('A 類：數量、複價、計算式都齊全', () => {
  // 1000 × 1.08 = 1080；1080 × 300 = 324,000
  // 刻意用非價格敏感的材料，才驗得到「低風險」那一格
  const r = ROW({ name: '可撓金屬管', spec: 'φ50mm', unit: 'M', qty: { drawing: 1000 }, wasteRate: 0.08, unitPrice: 300 },
    { seq: 1, score: 95, system: '電氣', sheetNo: 'E-01' });
  assert.equal(r['計價數量'], 1080);
  assert.equal(r['複價'], 324000);
  assert.equal(r['是否需人工確認'], '否');
  assert.equal(r['風險等級'], '低');
  assert.match(r['計算式'], /1,000\.00 M × \(1 \+ 8\.00%\) = 1,080\.00 M/);
});

test('C 類不給複價 —— 給了就會有人把它加進總價', () => {
  const r = ROW({ name: '不明管件', unit: '式', qty: { drawing: 10 }, unitPrice: 5000 },
    { seq: 2, score: 30, system: '給排水' });
  assert.equal(r['複價'], '', `C 類不可以有金額，卻給了 ${r['複價']}`);
  assert.equal(r['風險等級'], '高');
  assert.match(r['備註'], /不計入正式總價/);
});

test('樓層與區域沒填時寫「未指定」，不留白 —— 留白會在彙總表裡消失', () => {
  const r = ROW({ name: 'X', unit: '只', qty: { drawing: 1 } }, { seq: 3, score: 95 });
  assert.equal(r['樓層'], '未指定');
  assert.equal(r['區域'], '未指定');
});

test('未拆分人材機時，人工單價欄寫「未拆分」而不是 0', () => {
  const r = ROW({ name: 'X', unit: 'M', qty: { drawing: 1 }, unitPrice: 100 }, { seq: 4, score: 95 });
  assert.equal(r['人工單價'], '未拆分');
  assert.match(r['備註'], /單價未拆分人材機/);
});

test('沒有單價 → 待詢價，複價留白', () => {
  const r = ROW({ name: 'X', unit: 'M', qty: { drawing: 10 } }, { seq: 5, score: 95 });
  assert.equal(r['複價'], '');
  assert.match(r['備註'], /待詢價/);
});

test('敏感材料標進備註，風險升為中', () => {
  const r = ROW({ name: '電力電纜', spec: 'CU/XLPE', unit: 'M', qty: { drawing: 10 }, unitPrice: 100 },
    { seq: 6, score: 95 });
  assert.match(r['備註'], /價格敏感/);
  assert.equal(r['風險等級'], '中');
});

test('損耗含在單價裡時，損耗率欄顯示 0 並在計算式講明原因', () => {
  const r = ROW({ name: 'X', unit: 'M', qty: { drawing: 100 }, wasteRate: 0.08, unitPrice: 10 },
    { seq: 7, score: 95, settings: { wasteInUnitPrice: true } });
  assert.equal(r['損耗率'], 0);
  assert.equal(r['計價數量'], 100);
  assert.match(r['計算式'], /損耗已含在單價分析內/);
});

/* ── 彙總 ── */

test('總價排除 C 類，並講明排除了幾項', () => {
  const rows = [
    C.costRow({ name: 'A 電纜', unit: 'M', qty: { drawing: 100 }, wasteRate: 0, unitPrice: 10 },
      { seq: 1, score: 95, system: '電氣' }),                      // 1,000
    C.costRow({ name: 'B 管', unit: 'M', qty: { drawing: 200 }, wasteRate: 0, unitPrice: 20 },
      { seq: 2, score: 80, system: '電氣' }),                      // 4,000
    C.costRow({ name: 'C 不明', unit: '式', qty: { drawing: 1 }, wasteRate: 0, unitPrice: 99999 },
      { seq: 3, score: 20, system: '給排水' }),                    // 不計
  ];
  const sm = C.summaries(rows);
  assert.equal(sm.total, 5000, `應為 1,000 + 4,000；C 類的 99,999 不可入帳，實得 ${sm.total}`);
  assert.equal(sm.counts.C, 1);
  assert.equal(sm.excluded.length, 1);
  assert.equal(sm.counts.A, 1);
  assert.equal(sm.counts.B, 1);
});

test('系統別彙總依金額排序，且不含被排除的項', () => {
  const rows = [
    C.costRow({ name: 'a', unit: 'M', qty: { drawing: 1 }, wasteRate: 0, unitPrice: 100 }, { seq: 1, score: 95, system: '電氣' }),
    C.costRow({ name: 'b', unit: 'M', qty: { drawing: 1 }, wasteRate: 0, unitPrice: 900 }, { seq: 2, score: 95, system: '空調' }),
  ];
  const sm = C.summaries(rows);
  assert.equal(sm.bySystem[0].key, '空調');
  assert.equal(sm.bySystem[0].amount, 900);
  assert.equal(sm.bySystem[1].amount, 100);
});

test('待詢價清單抓得到沒有單價的項', () => {
  const rows = [
    C.costRow({ name: 'a', unit: 'M', qty: { drawing: 1 } }, { seq: 1, score: 95 }),
    C.costRow({ name: 'b', unit: 'M', qty: { drawing: 1 }, unitPrice: 10 }, { seq: 2, score: 95 }),
  ];
  const sm = C.summaries(rows);
  assert.equal(sm.unpriced.length, 1);
  assert.equal(sm.counts.unpriced, 1);
});

test('高風險清單 = 所有 C 類（至少）', () => {
  const rows = [
    C.costRow({ name: 'a', unit: 'M', qty: { drawing: 1 }, unitPrice: 10 }, { seq: 1, score: 95 }),
    C.costRow({ name: 'b', unit: 'M', qty: { drawing: 1 }, unitPrice: 10 }, { seq: 2, score: 20 }),
  ];
  const sm = C.summaries(rows);
  assert.equal(sm.highRisk.length, 1);
  assert.equal(sm.highRisk[0][C.COST_HEAD.indexOf('工項名稱')], 'b');
});

test('樓層彙總會把「未指定」獨立成一列，不會被吃掉', () => {
  const rows = [
    C.costRow({ name: 'a', unit: 'M', qty: { drawing: 1 }, unitPrice: 10, floor: '3F' }, { seq: 1, score: 95 }),
    C.costRow({ name: 'b', unit: 'M', qty: { drawing: 1 }, unitPrice: 10 }, { seq: 2, score: 95 }),
  ];
  const sm = C.summaries(rows);
  assert.ok(sm.byFloor.some((g) => g.key === '未指定'), JSON.stringify(sm.byFloor));
  assert.ok(sm.byFloor.some((g) => g.key === '3F'));
});
