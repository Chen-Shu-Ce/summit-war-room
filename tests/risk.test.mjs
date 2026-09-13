/** 損耗率機率化與蒙地卡羅的回歸測試。數學正確性逐條對照已知值。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../public/js/takeoff/risk.js';

const near = (a, b, tol, m = '') => assert.ok(Math.abs(a - b) <= tol, `${m} 期待 ${b} 實得 ${a}`);

/* ── 數學基礎 ── */

test('PRNG：同種子必得同序列（採購數字不能每按一次就變）', () => {
  const a = Array.from({ length: 5 }, mkGen(42));
  const b = Array.from({ length: 5 }, mkGen(42));
  const c = Array.from({ length: 5 }, mkGen(43));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  function mkGen(seed) { const g = R.mulberry32(seed); return () => g(); }
});

test('PRNG：均勻性與範圍', () => {
  const g = R.mulberry32(1);
  let sum = 0, n = 50000, min = 1, max = 0;
  for (let i = 0; i < n; i++) { const v = g(); sum += v; min = Math.min(min, v); max = Math.max(max, v); }
  near(sum / n, 0.5, 0.01, '平均應接近 0.5');
  assert.ok(min >= 0 && max < 1);
});

test('normalInv：對照標準常態分位點', () => {
  near(R.normalInv(0.5), 0, 1e-9);
  near(R.normalInv(0.975), 1.959964, 1e-5);
  near(R.normalInv(0.8), 0.8416212, 1e-5);
  near(R.normalInv(0.05), -1.644854, 1e-5);
});

test('normalCdf 與 normalInv 互為反函數', () => {
  for (const p of [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99]) {
    near(R.normalCdf(R.normalInv(p)), p, 1e-6, `p=${p}`);
  }
});

test('betaInc：對照已知值', () => {
  near(R.betaInc(0.5, 1, 1), 0.5, 1e-9, 'I_x(1,1)=x');
  near(R.betaInc(0.3, 1, 1), 0.3, 1e-9);
  near(R.betaInc(0.5, 2, 2), 0.5, 1e-9, '對稱');
  near(R.betaInc(0.5, 2, 5), 0.890625, 1e-6);
  assert.equal(R.betaInc(0, 2, 3), 0);
  assert.equal(R.betaInc(1, 2, 3), 1);
});

test('betaInv 為 betaInc 的反函數', () => {
  for (const p of [0.05, 0.5, 0.8, 0.95]) {
    near(R.betaInc(R.betaInv(p, 2, 5), 2, 5), p, 1e-8, `p=${p}`);
  }
});

/* ── 分布 ── */

test('三角分布：反函數在 min/mode/max 的邊界正確', () => {
  const d = { min: 0.02, mode: 0.05, max: 0.12 };
  near(R.DISTS.triangular.inv(0, d), 0.02, 1e-9);
  near(R.DISTS.triangular.inv(1, d), 0.12, 1e-9);
  const c = (d.mode - d.min) / (d.max - d.min);
  near(R.DISTS.triangular.inv(c, d), d.mode, 1e-9, '累積機率等於 c 時應剛好是眾數');
});

test('三角分布：反函數單調遞增', () => {
  const d = { min: 0.02, mode: 0.05, max: 0.12 };
  let prev = -1;
  for (let p = 0; p <= 1; p += 0.01) {
    const v = R.DISTS.triangular.inv(p, d);
    assert.ok(v >= prev, `p=${p}`);
    prev = v;
  }
});

test('PERT：比三角分布更集中在眾數（尾部較保守）', () => {
  const d = { min: 0.02, mode: 0.05, max: 0.20 };
  const t95 = R.DISTS.triangular.inv(0.95, d);
  const p95 = R.DISTS.pert.inv(0.95, d);
  assert.ok(p95 < t95, `PERT P95 ${p95} 應小於三角 P95 ${t95}`);
  near(R.DISTS.pert.inv(0.5, d), 0.0667, 0.01);
});

test('查表內插與直接反函數一致', () => {
  const d = { min: 0.02, mode: 0.05, max: 0.12 };
  const t = R.makeQuantileTable('pert', d, 1024);
  for (const p of [0.1, 0.5, 0.8, 0.95]) {
    near(R.lookup(t, p), R.DISTS.pert.inv(p, d), 1e-4, `p=${p}`);
  }
});

/* ── 適用範圍 ── */

test('只有材料類才跑分布，計數類與統包項不模擬', () => {
  assert.equal(R.isStochastic({ measureType: 'length' }), true);
  assert.equal(R.isStochastic({ measureType: 'area' }), true);
  assert.equal(R.isStochastic({ measureType: 'count' }), false, '6 台配電盤沒有損耗分布');
  assert.equal(R.isStochastic({ measureType: 'lumpsum' }), false);
});

test('沒有區間資料時退回窄區間並標明來源，不假裝有資料', () => {
  const d = R.wasteDistOf({ wasteRate: 0.05, measureType: 'length' });
  assert.equal(d.source, 'fallback');
  assert.equal(d.mode, 0.05);
  assert.ok(d.min < 0.05 && d.max > 0.05);
  const d2 = R.wasteDistOf({ wasteDist: { min: 0.03, mode: 0.06, max: 0.15 } });
  assert.equal(d2.source, 'item');
  assert.equal(d2.mode, 0.06);
});

test('服務水準建議依缺料代價而定', () => {
  assert.equal(R.suggestServiceLevel({ leadTimeDays: 14 }).p, 0.8);
  assert.equal(R.suggestServiceLevel({ leadTimeDays: 45 }).p, 0.85);
  assert.equal(R.suggestServiceLevel({ leadTimeDays: 120 }).p, 0.9);
  assert.equal(R.suggestServiceLevel({ leadTimeDays: 180, special: true }).p, 0.95);
  assert.match(R.suggestServiceLevel({ leadTimeDays: 200 }).why, /停工|來不及/);
});

/* ── 單項模擬 ── */

const ITEM = {
  code: '321.01', name: '電纜', unit: 'M', measureType: 'length',
  qty: { drawing: 1710, boq: 1650, manual: 1700 },
  wasteDist: { min: 0.02, mode: 0.03, max: 0.08 },
  order: { unit: 'M', unitFactor: 1, packMultiple: 1, moq: 0 }, unitPrice: 780, leadTimeDays: 45,
};

test('單項模擬：P50 < P80 < P90 < P95，且都大於基準量', () => {
  const r = R.simulateItem(ITEM, { defaultWasteRate: 0.03 });
  assert.equal(r.base, 1700);
  assert.ok(r.qty.p50 < r.qty.p80 && r.qty.p80 < r.qty.p90 && r.qty.p90 < r.qty.p95, JSON.stringify(r.qty));
  assert.ok(r.qty.p50 > 1700, '損耗恆正，P50 必大於基準量');
  near(r.qty.p50 / 1700 - 1, R.DISTS.pert.inv(0.5, ITEM.wasteDist), 0.003, 'P50 損耗率應接近理論值');
});

test('單項模擬：可重現', () => {
  const a = R.simulateItem(ITEM, {}, { iterations: 3000 });
  const b = R.simulateItem(ITEM, {}, { iterations: 3000 });
  assert.deepEqual(a.qty, b.qty);
});

test('單項模擬：計數類回傳確定值而非假分布', () => {
  const r = R.simulateItem({ ...ITEM, measureType: 'count' }, {});
  assert.equal(r.deterministic, true);
  assert.equal(r.qty.p50, r.qty.p95, '計數類不該有分散度');
});

test('withServiceLevel：把分位數換成等效損耗率供既有計算使用', () => {
  const p50 = R.withServiceLevel(ITEM, {}, 0.5);
  const p80 = R.withServiceLevel(ITEM, {}, 0.8);
  assert.ok(p80.wasteRate > p50.wasteRate);
  assert.equal(p80._serviceLevel, 0.8);
  near(p80.wasteRate, R.DISTS.pert.inv(0.8, ITEM.wasteDist), 1e-6);
  assert.equal(R.withServiceLevel({ ...ITEM, measureType: 'count' }, {}).wasteRate, undefined, '計數類不動');
});

/* ── 整包模擬：三個陷阱 ── */

const PORT = Array.from({ length: 12 }, (_, i) => ({
  ...ITEM, code: `I${i}`, name: `材料${i}`,
  qty: { manual: 1000 }, unitPrice: 100,
}));

test('整包模擬：相關性越高，整包分散度越大（陷阱：全當獨立會低估風險）', () => {
  const indep = R.simulatePortfolio(PORT, {}, { correlation: 0, iterations: 8000 });
  const corr = R.simulatePortfolio(PORT, {}, { correlation: 0.6, iterations: 8000 });
  assert.ok(corr.cost.sd > indep.cost.sd * 1.5,
    `相關 sd ${corr.cost.sd} 應明顯大於獨立 sd ${indep.cost.sd}`);
  assert.ok(corr.cost.p80 > indep.cost.p80, '整包 P80 也應較高');
});

test('整包模擬：各項 P80 相加 ≠ 整包 P80（陷阱：加總謬誤）', () => {
  const r = R.simulatePortfolio(PORT, {}, { correlation: 0.3, iterations: 8000 });
  assert.ok(r.sumOfP80 > r.portfolioP80, `各項 P80 相加 ${r.sumOfP80} 應高於整包 P80 ${r.portfolioP80}`);
  assert.ok(r.diversification > 0, '分散效益應為正');
});

test('整包模擬：完全相關時兩者應趨於一致', () => {
  const r = R.simulatePortfolio(PORT, {}, { correlation: 1, iterations: 8000 });
  const gap = Math.abs(r.sumOfP80 - r.portfolioP80) / r.portfolioP80;
  assert.ok(gap < 0.01, `ρ=1 時差距應 <1%，實得 ${(gap * 100).toFixed(2)}%`);
});

test('整包模擬：回報收斂指標而非宣稱精確', () => {
  const few = R.simulatePortfolio(PORT, {}, { iterations: 300 });
  const many = R.simulatePortfolio(PORT, {}, { iterations: 20000 });
  assert.ok(many.convergence < few.convergence, `迭代多應更收斂：${many.convergence} vs ${few.convergence}`);
  assert.ok(many.convergence < 0.02, '兩萬次的前後半 P80 差應 <2%');
});

test('整包模擬：可重現且帶出參數', () => {
  const a = R.simulatePortfolio(PORT, {}, { iterations: 2000 });
  const b = R.simulatePortfolio(PORT, {}, { iterations: 2000 });
  assert.equal(a.cost.p80, b.cost.p80);
  assert.equal(a.correlation, 0.3);
  assert.equal(a.dist, 'pert');
  assert.equal(a.iterations, 2000);
});

test('整包模擬：混入計數類時只有材料類參與分散', () => {
  const mixed = [...PORT.slice(0, 3), { ...ITEM, code: 'CNT', measureType: 'count', qty: { manual: 6 }, unitPrice: 465000 }];
  const r = R.simulatePortfolio(mixed, {}, { iterations: 4000 });
  const cnt = r.items.find((x) => x.code === 'CNT');
  assert.equal(cnt.stochastic, false);
  assert.equal(cnt.qty.p50, cnt.qty.p95);
});

/* ── 由實績校準 ── */

test('校準：樣本太少時拒絕估計，不用 3 筆資料假裝有統計基礎', () => {
  const r = R.calibrateFromHistory([{ theoretical: 100, actual: 103 }, { theoretical: 100, actual: 105 }]);
  assert.match(r.error, /少於 5 筆/);
});

test('校準：由實績反算三點參數', () => {
  const rec = [2, 3, 3, 4, 4, 5, 5, 6, 7, 9].map((p) => ({ theoretical: 1000, actual: 1000 * (1 + p / 100) }));
  const r = R.calibrateFromHistory(rec);
  assert.equal(r.n, 10);
  assert.ok(r.min < r.mode && r.mode < r.max, JSON.stringify(r));
  near(r.mode, 0.045, 0.011);
  assert.ok(r.max >= 0.07);
});

test('單點值相當於第幾百分位 —— 機率化最有價值的一句話', () => {
  const d = { min: 0.02, mode: 0.03, max: 0.08 };
  const p = R.percentileOfWaste(0.03, d, 'pert');
  assert.ok(p > 0.3 && p < 0.45, `3% 的慣例值應落在 P30–P45，實得 P${Math.round(p * 100)}`);
  // 與反函數互為逆運算
  for (const q of [0.2, 0.5, 0.8, 0.95]) {
    near(R.percentileOfWaste(R.DISTS.pert.inv(q, d), d, 'pert'), q, 2e-3, `q=${q}`);
  }
  assert.equal(R.percentileOfWaste(0.01, d), 0, '低於下界為 0');
  assert.equal(R.percentileOfWaste(0.20, d), 1, '高於上界為 1');
});

test('單點百分位：三角分布也互為逆運算', () => {
  const d = { min: 0.03, mode: 0.05, max: 0.12 };
  for (const q of [0.15, 0.5, 0.8]) {
    near(R.percentileOfWaste(R.DISTS.triangular.inv(q, d), d, 'triangular'), q, 1e-6, `q=${q}`);
  }
});
