/**
 * 投標價組成的測試。
 *
 * 這一支的重點只有一個：**數字要對得到帳**。
 * 每一個期望值都是手算出來的，不是跑一次程式抄回來的 ——
 * 抄回來的期望值只能證明「程式沒變」，不能證明「程式是對的」。
 *
 * 參數來自使用者自述的實際作法：
 *   管理費 10%、利潤 10%（一口價、逐層疊加）
 *   規費／保險／履約保證 佔合約價 1%
 *   營業稅 5%、逾期罰款每日千分之一
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as BD from '../public/js/takeoff/bid.js';

const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;
const amtOf = (r, key) => (r.lines.find((x) => x.key === key) || {}).amount;

/* ── 最要命的一件事：加成 vs 佔標價 ── */

test('佔標價 1% 的規費必須用除的，不是乘的', () => {
  // 只有規費一層，基數 1,000,000
  const r = BD.buildUp(1000000, { markups: [{ key: 'fees', label: '規費', rate: 0.01, basis: 'price' }], taxRate: 0 });
  // 正解：P = 1,000,000 / 0.99 = 1,010,101.01，規費 = 1% × P = 10,101.01
  assert.ok(near(r.preTax, 1010101.01), `標價 ${r.preTax}`);
  assert.ok(near(amtOf(r, 'fees'), 10101.01), `規費 ${amtOf(r, 'fees')}`);
  // 用乘的會得到 10,000 —— 少算 101.01，在 10 億的案子上就是少算約 100 萬
  assert.ok(amtOf(r, 'fees') > 10000, '用乘法算會少算');
});

test('規費金額 ÷ 標價 剛好等於費率 —— 這是「佔標價」的定義', () => {
  const r = BD.buildUp(8000000, { markups: [{ key: 'fees', rate: 0.01, basis: 'price', label: '規費' }], taxRate: 0 });
  assert.ok(near(amtOf(r, 'fees') / r.preTax, 0.01, 1e-9));
});

test('成本加成則是單純相乘', () => {
  const r = BD.buildUp(1000000, { markups: [{ key: 'oh', label: '管理費', rate: 0.10, basis: 'cost' }], taxRate: 0 });
  assert.ok(near(amtOf(r, 'oh'), 100000));
  assert.ok(near(r.preTax, 1100000));
});

/* ── 逐層疊加 ── */

test('利潤算在「成本＋管理費」上，不是只算在成本上', () => {
  const r = BD.buildUp(1000000, { taxRate: 0 });
  assert.ok(near(amtOf(r, 'overhead'), 100000), `管理費 ${amtOf(r, 'overhead')}`);
  // 利潤 10% × 1,100,000 = 110,000（不是 100,000）
  assert.ok(near(amtOf(r, 'profit'), 110000), `利潤 ${amtOf(r, 'profit')}`);
});

test('每一層都回報自己的計算基數 —— 事後不會為了「這 10% 算在誰身上」吵架', () => {
  const r = BD.buildUp(1000000, { taxRate: 0 });
  assert.ok(near(r.lines.find((x) => x.key === 'overhead').base, 1000000));
  assert.ok(near(r.lines.find((x) => x.key === 'profit').base, 1100000));
});

test('使用者的實際組合：100 萬直接成本 → 手算全程對得上', () => {
  const r = BD.buildUp(1000000);
  // 管理費 10%：1,000,000 → +100,000 = 1,100,000
  // 利潤   10%：1,100,000 → +110,000 = 1,210,000  （= K）
  // 規費 佔標價 1%：P = 1,210,000 / 0.99 = 1,222,222.22
  // 稅 5%：1,222,222.22 × 0.05 = 61,111.11
  // 總價 = 1,283,333.33
  assert.ok(near(r.preTax, 1222222.22), `未稅 ${r.preTax}`);
  assert.ok(near(amtOf(r, 'fees'), 12222.22), `規費 ${amtOf(r, 'fees')}`);
  assert.ok(near(r.tax, 61111.11), `稅 ${r.tax}`);
  assert.ok(near(r.total, 1283333.33), `總價 ${r.total}`);
  // 加成倍率：1,222,222.22 / 1,000,000 − 1 = 22.22%
  assert.ok(near(r.markupOnDirect, 0.2222, 1e-4), String(r.markupOnDirect));
});

test('直接成本為 0 時不會除以零', () => {
  const r = BD.buildUp(0);
  assert.equal(r.markupOnDirect, null);
  assert.equal(r.total, 0);
});

test('沒有直接成本要明確報錯，不可以回傳 0 假裝算過', () => {
  assert.ok(BD.buildUp(null).error);
  assert.ok(BD.buildUp(undefined).error);
});

test('佔標價的費率合計 ≥ 100% 是無解，要報錯', () => {
  const r = BD.buildUp(1000000, { markups: [{ key: 'x', rate: 1.0, basis: 'price', label: 'x' }] });
  assert.ok(r.error, JSON.stringify(r));
});

test('沒有加成層時，未稅價就是直接成本', () => {
  const r = BD.buildUp(500000, { markups: [], taxRate: 0 });
  assert.equal(r.preTax, 500000);
});

/* ── 漏項保留與風險準備金的擺放位置 ── */

test('漏項保留併進基數，所以會被後面每一層加成', () => {
  const a = BD.buildUp(1000000, { taxRate: 0 });
  const b = BD.buildUp(1000000, { shortfall: 100000, taxRate: 0 });
  // 基數 1,100,000 → 管理費 110,000 → 1,210,000 → 利潤 121,000 → 1,331,000
  assert.ok(near(amtOf(b, 'overhead'), 110000), `管理費 ${amtOf(b, 'overhead')}`);
  assert.ok(b.preTax > a.preTax * 1.09, '漏項保留應該被加成，不是平加上去');
});

test('風險準備金加在加成之後 —— 準備金不該再被乘利潤', () => {
  const r = BD.buildUp(1000000, { reserve: 100000, taxRate: 0 });
  // 管理費、利潤仍以 1,000,000 為起點：1,210,000；再加準備金 → K = 1,310,000
  assert.ok(near(amtOf(r, 'overhead'), 100000));
  assert.ok(near(amtOf(r, 'profit'), 110000), `利潤 ${amtOf(r, 'profit')} 不該因準備金而變大`);
  assert.ok(near(r.preTax, 1310000 / 0.99), `未稅 ${r.preTax}`);
});

test('漏項保留與風險準備金是兩件事，不可以互相取代', () => {
  const s = BD.buildUp(1000000, { shortfall: 100000, taxRate: 0 }).preTax;
  const v = BD.buildUp(1000000, { reserve: 100000, taxRate: 0 }).preTax;
  assert.ok(s > v, `同樣 10 萬，漏項保留(${s}) 應大於風險準備金(${v})，因為前者會被加成`);
});

/* ── 風險準備金推導 ── */

test('風險準備金 = 選定分位 − P50，不是 − 平均', () => {
  const sim = { cost: { p50: 1000000, p80: 1150000, p90: 1250000, p95: 1400000, mean: 1080000 } };
  assert.equal(BD.riskReserve(sim, 0.8).amount, 150000);
  assert.equal(BD.riskReserve(sim, 0.9).amount, 250000);
  assert.equal(BD.riskReserve(sim, 0.95).amount, 400000);
});

test('服務水準 P50 時準備金為 0 —— 這是定義，不是 bug', () => {
  const sim = { cost: { p50: 1000000, p80: 1150000 } };
  assert.equal(BD.riskReserve(sim, 0.5).amount, 0);
});

test('沒有模擬結果時明說，不要回傳 0 讓人以為沒有風險', () => {
  assert.ok(BD.riskReserve(null).error);
  assert.ok(BD.riskReserve({ cost: {} }, 0.8).error);
});

test('準備金不會是負的（分位數異常時）', () => {
  const sim = { cost: { p50: 1000000, p80: 900000 } };
  assert.equal(BD.riskReserve(sim, 0.8).amount, 0);
});

/* ── 漏項保留 ── */

const ITEMS = [
  { code: '321.01', wbs: '321', name: '電纜 38mm²', unit: 'M', unitPrice: 780 },
  { code: '321.02', wbs: '321', name: '電纜 22mm²', unit: 'M', unitPrice: 480 },
  { code: '323.01', wbs: '323', name: '電纜架', unit: 'M', unitPrice: 2450 },
  { code: '331.01', wbs: '331', name: 'LED 燈', unit: '只', unitPrice: null },
];

test('用「分不出來的那幾個候選」的均價 —— 這比同大類均價更貼近', () => {
  const r = BD.shortfallReserve(
    [{ layer: 'E-CABLE-PWR', level: 'bad', qty: 1000, unit: 'M', candidates: ['321.01', '321.02'], wbs: '321' }],
    ITEMS);
  // (780 + 480) / 2 = 630；630 × 1000 = 630,000
  assert.equal(r.amount, 630000, JSON.stringify(r.rows));
  assert.match(r.rows[0].why, /候選工項/);
});

test('沒有候選時退回同 WBS 大類均價', () => {
  const r = BD.shortfallReserve([{ layer: 'E-TRAY', level: 'bad', qty: 200, unit: 'M', wbs: '323' }], ITEMS);
  assert.equal(r.amount, 490000);   // 2450 × 200
  assert.match(r.rows[0].why, /同類 WBS/);
});

test('同類工項都沒單價時，明說估不出來而不是當成 0 元', () => {
  const r = BD.shortfallReserve([{ layer: 'E-LIGHT', level: 'bad', qty: 30, wbs: '331' }], ITEMS);
  assert.equal(r.amount, 0);
  assert.match(r.rows[0].why, /沒有單價/);
});

test('只估「擋下」的，未對映的註記層不估列', () => {
  const r = BD.shortfallReserve([
    { layer: 'A-NOTE', level: 'info', qty: 5000, wbs: '321' },
    { layer: 'A-GRID', level: 'warn', qty: 9000, wbs: '321' },
  ], ITEMS);
  assert.equal(r.amount, 0);
  assert.equal(r.rows.length, 0);
});

test('沒有幾何量的圖層估不出來，但仍要列出來讓人看見', () => {
  const r = BD.shortfallReserve([{ layer: 'X', level: 'bad', wbs: '321', candidates: ['321.01'] }], ITEMS);
  assert.equal(r.amount, 0);
  assert.equal(r.rows.length, 1);
  assert.match(r.rows[0].why, /無法取得/);
});

test('多個漏項會累加', () => {
  const r = BD.shortfallReserve([
    { layer: 'A', level: 'bad', qty: 1000, candidates: ['321.01'], wbs: '321' },
    { layer: 'B', level: 'bad', qty: 200, wbs: '323' },
  ], ITEMS);
  assert.equal(r.amount, 780000 + 490000);
  assert.equal(r.rows.length, 2);
});

test('空輸入回 0，不報錯', () => {
  assert.equal(BD.shortfallReserve([], ITEMS).amount, 0);
  assert.equal(BD.shortfallReserve().amount, 0);
});

/* ── 逾期罰款 ── */

test('每日千分之一：1000 萬合約延誤 30 天 = 30 萬', () => {
  const s = BD.delayScenarios(10000000, 1000000, 0.001, [30]);
  assert.equal(s[0].penalty, 300000);
  assert.equal(s[0].profitEaten, 0.3);
  assert.equal(s[0].wipesOutProfit, false);
});

test('罰款超過利潤時要標出來 —— 那已經不是少賺，是虧', () => {
  const s = BD.delayScenarios(10000000, 1000000, 0.001, [100, 120]);
  assert.equal(s[0].wipesOutProfit, true, '100 天 × 1 萬 = 100 萬，剛好吃光');
  assert.equal(s[1].wipesOutProfit, true);
});

test('吃光利潤的天數：利潤 ÷ 每日罰款，無條件進位', () => {
  assert.equal(BD.breakEvenDelayDays(10000000, 1000000, 0.001), 100);
  assert.equal(BD.breakEvenDelayDays(10000000, 1210000, 0.001), 121);
  // 不整除要進位 —— 少算一天就會誤判成還沒虧
  assert.equal(BD.breakEvenDelayDays(10000000, 1000001, 0.001), 101);
});

test('沒有利潤時算不出損益兩平天數，回 null 而不是 0 或 Infinity', () => {
  assert.equal(BD.breakEvenDelayDays(10000000, 0, 0.001), null);
  assert.equal(BD.breakEvenDelayDays(0, 1000000, 0.001), null);
  assert.equal(BD.breakEvenDelayDays(10000000, null, 0.001), null);
});

/* ── 反推 ── */

test('反推可負擔的直接成本：正推回去要回到原點', () => {
  const fwd = BD.buildUp(1000000);
  const back = BD.affordableDirect(fwd.total);
  assert.ok(near(back, 1000000, 1), `反推得 ${back}`);
});

test('反推時漏項保留與風險準備金會吃掉直接成本的空間', () => {
  const fwd = BD.buildUp(1000000, { reserve: 50000, shortfall: 30000 });
  const back = BD.affordableDirect(fwd.total, { reserve: 50000, shortfall: 30000 });
  assert.ok(near(back, 1000000, 1), `反推得 ${back}`);
  // 同樣的目標總價，準備金越多、能花在直接成本上的越少
  const tight = BD.affordableDirect(fwd.total, { reserve: 200000 });
  assert.ok(tight < back, `${tight} 應小於 ${back}`);
});

test('目標總價無效時回 null', () => {
  assert.equal(BD.affordableDirect(0), null);
  assert.equal(BD.affordableDirect(-5), null);
  assert.equal(BD.affordableDirect(null), null);
});

/* ── 整體一致性 ── */

test('每一層金額加總 = 未稅價（沒有數字憑空出現或消失）', () => {
  const r = BD.buildUp(4722583, { reserve: 180000, shortfall: 96000 });
  const sum = r.lines.reduce((a, x) => a + x.amount, 0);
  assert.ok(near(sum, r.preTax, 0.05), `逐層加總 ${sum} vs 未稅 ${r.preTax}`);
});

test('未稅 + 稅 = 總價', () => {
  const r = BD.buildUp(4722583, { reserve: 180000 });
  assert.ok(near(r.preTax + r.tax, r.total, 0.02));
});

test('費率全部歸零時，未稅價 = 直接成本', () => {
  const zero = BD.DEFAULT_MARKUPS.map((m) => ({ ...m, rate: 0 }));
  const r = BD.buildUp(1234567, { markups: zero, taxRate: 0 });
  assert.equal(r.preTax, 1234567);
});

test('預設值確實是使用者自述的組合（10% / 10% / 佔標價 1%）', () => {
  const m = Object.fromEntries(BD.DEFAULT_MARKUPS.map((x) => [x.key, x]));
  assert.equal(m.overhead.rate, 0.10);
  assert.equal(m.overhead.basis, 'cost');
  assert.equal(m.profit.rate, 0.10);
  assert.equal(m.profit.basis, 'cost');
  assert.equal(m.fees.rate, 0.01);
  assert.equal(m.fees.basis, 'price', '規費是「佔合約價」，必須是 price 基礎');
  assert.equal(BD.DEFAULT_TAX, 0.05);
});

test('連候選工項都沒有時，說清楚原因而不是印出「候選工項（）」', () => {
  const r = BD.shortfallReserve([{ layer: 'E-LIGHT-HB', level: 'bad', qty: 30 }], ITEMS);
  assert.equal(r.amount, 0);
  assert.equal(r.rows.length, 1);
  assert.doesNotMatch(r.rows[0].why, /（）/, r.rows[0].why);
  assert.match(r.rows[0].why, /沒有任何候選工項/);
});
