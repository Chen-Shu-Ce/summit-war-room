/**
 * 廠商主檔與建議廠商的測試。
 *
 * 重點跟 layermatch 一樣，不在「排得準」，在**排不準的時候會說出來**，
 * 以及那些排名本身講不出來、但採購一定要知道的事：
 * 資格不符是否決不是扣分、集中度、關係人疑慮。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as V from '../public/js/takeoff/vendors.js';

const base = {
  code: 'V1', name: '甲電材', taxId: '11111111', status: 'active',
  categories: ['321', '323'], leadDays: 30, capacity: 5000000,
  onTimeRate: 0.95, defectRate: 0.005, priceIndex: 0.98, paymentDays: 60, orders: 12,
  certExpiry: '2099-12-31',
};
const V2 = { ...base, code: 'V2', name: '乙電材', taxId: '22222222', onTimeRate: 0.7, priceIndex: 1.1, orders: 3 };
const PKG = { code: 'PKG-E', categories: ['321', '323'], amount: 2000000, needDate: '2099-01-01' };

/* ── 正規化 ── */

test('缺的欄位就是 null，不補預設值 —— 缺資料本身是資訊', () => {
  const v = V.normalize({ name: '丙' });
  assert.equal(v.onTimeRate, null);
  assert.equal(v.defectRate, null);
  assert.equal(v.capacity, null);
  assert.equal(v.orders, 0);
  assert.equal(v.status, 'active');
});

test('沒有 code 時用統編、再退回名稱當識別', () => {
  assert.equal(V.normalize({ taxId: '12345678', name: 'X' }).code, '12345678');
  assert.equal(V.normalize({ name: 'X' }).code, 'X');
});

test('未知狀態退回 active，不會讓廠商因為打錯字變成停權', () => {
  assert.equal(V.normalize({ name: 'X', status: '亂打' }).status, 'active');
});

/* ── 資格：否決不是扣分 ── */

test('停權與黑名單一律否決', () => {
  assert.ok(V.eligibility(V.normalize({ ...base, status: 'suspended' })).length);
  assert.ok(V.eligibility(V.normalize({ ...base, status: 'blacklisted' })).length);
  assert.equal(V.eligibility(V.normalize(base)).length, 0);
});

test('證照過期是否決', () => {
  const v = V.normalize({ ...base, certExpiry: '2020-01-01' });
  const e = V.eligibility(v, { at: '2026-09-15' });
  assert.equal(e.length, 1);
  assert.match(e[0], /2020-01-01/);
});

test('證照當天到期仍算有效 —— 到期日是包含的', () => {
  const v = V.normalize({ ...base, certExpiry: '2026-09-15' });
  assert.equal(V.eligibility(v, { at: '2026-09-15T10:00:00' }).length, 0);
});

test('前置期趕不上需求到貨日是否決，不是扣分', () => {
  const v = V.normalize({ ...base, leadDays: 90 });
  const e = V.eligibility(v, { at: '2026-09-15', needDate: '2026-10-01' });
  assert.equal(e.length, 1);
  assert.match(e[0], /趕不上/);
});

test('前置期來得及就不是問題', () => {
  const v = V.normalize({ ...base, leadDays: 10 });
  assert.equal(V.eligibility(v, { at: '2026-09-15', needDate: '2026-12-01' }).length, 0);
});

/* ── 評分 ── */

test('不承作本包品類直接否決，分數歸零', () => {
  const r = V.scoreVendor(V.normalize({ ...base, categories: ['600'] }), PKG);
  assert.equal(r.blocked, true);
  assert.equal(r.score, 0);
  assert.match(r.blockers[0], /不承作/);
});

test('品類只涵蓋一半，分數要打折並說出缺哪一個', () => {
  const full = V.scoreVendor(V.normalize(base), PKG).score;
  const half = V.scoreVendor(V.normalize({ ...base, categories: ['321'] }), PKG).score;
  assert.ok(half < full, `${half} 應小於 ${full}`);
  assert.match(V.scoreVendor(V.normalize({ ...base, categories: ['321'] }), PKG).reasons.join(), /缺 323/);
});

test('交期達成率越高分數越高', () => {
  const a = V.scoreVendor(V.normalize({ ...base, onTimeRate: 0.99 }), PKG).score;
  const b = V.scoreVendor(V.normalize({ ...base, onTimeRate: 0.60 }), PKG).score;
  assert.ok(a > b, `${a} 應大於 ${b}`);
});

test('缺交期紀錄不給分，也不給平均值 —— 沒紀錄不該白拿 90%', () => {
  const known = V.scoreVendor(V.normalize({ ...base, onTimeRate: 0.9 }), PKG);
  const unknown = V.scoreVendor(V.normalize({ ...base, onTimeRate: null }), PKG);
  assert.ok(unknown.score < known.score, `${unknown.score} 應小於 ${known.score}`);
  assert.ok(unknown.missing.includes('交期達成率'));
});

test('資料完整度要回報 —— 90 分而資料只有三成，跟 90 分而資料齊全不是同一件事', () => {
  const full = V.scoreVendor(V.normalize(base), PKG);
  const thin = V.scoreVendor(V.normalize({ code: 'T', name: '丁', categories: ['321', '323'] }), PKG);
  assert.equal(full.coverage, 1);
  assert.ok(thin.coverage < 0.5, String(thin.coverage));
});

test('不良率越低分數越高；超過 5% 拿不到品質分', () => {
  const good = V.scoreVendor(V.normalize({ ...base, defectRate: 0 }), PKG).score;
  const bad = V.scoreVendor(V.normalize({ ...base, defectRate: 0.06 }), PKG).score;
  assert.ok(good > bad);
});

test('報價指數 1.2 以上拿不到價格分，0.8 以下拿滿分', () => {
  const cheap = V.scoreVendor(V.normalize({ ...base, priceIndex: 0.75 }), PKG).score;
  const mid = V.scoreVendor(V.normalize({ ...base, priceIndex: 1.0 }), PKG).score;
  const dear = V.scoreVendor(V.normalize({ ...base, priceIndex: 1.3 }), PKG).score;
  assert.ok(cheap > mid && mid > dear, `${cheap} / ${mid} / ${dear}`);
});

test('產能不足不是否決，但要講出來讓人決定要不要分批', () => {
  const r = V.scoreVendor(V.normalize({ ...base, capacity: 100000 }), PKG);
  assert.equal(r.blocked, false);
  assert.match(r.reasons.join(), /低於本包金額/);
});

test('沒有合作紀錄要提醒先小額試單', () => {
  assert.match(V.scoreVendor(V.normalize({ ...base, orders: 0 }), PKG).reasons.join(), /小額試單/);
});

test('觀察中的廠商扣分但不否決', () => {
  const r = V.scoreVendor(V.normalize({ ...base, status: 'probation' }), PKG);
  assert.equal(r.blocked, false);
  assert.ok(r.score < V.scoreVendor(V.normalize(base), PKG).score);
});

test('每一分都附理由 —— 事後被問「為什麼給這家」要答得出來', () => {
  const r = V.scoreVendor(V.normalize(base), PKG);
  assert.ok(r.reasons.length >= 5, r.reasons.join('|'));
  assert.ok(r.reasons.some((x) => x.includes('交期達成率')));
  assert.ok(r.reasons.some((x) => x.includes('報價指數')));
});

/* ── 建議：分不出來就說分不出來 ── */

test('分數明顯較高時給出建議', () => {
  const r = V.suggest([base, V2], PKG);
  assert.equal(r.best, 'V1', JSON.stringify(r.ranked.map((x) => [x.code, x.score])));
  assert.equal(r.ambiguous.length, 0);
});

test('兩家幾乎一樣時不指定第一名 —— 差 3 分說某家較好是拿雜訊當訊號', () => {
  const twin = { ...base, code: 'V9', name: '甲電材二廠', taxId: '99999999' };
  const r = V.suggest([base, twin], PKG);
  assert.equal(r.best, null);
  assert.ok(r.ambiguous.includes('V1') && r.ambiguous.includes('V9'), r.ambiguous.join());
  assert.match(r.why, /分數相近|人工比較/);
});

test('被否決的廠商不參與排名，但要列出來連同理由', () => {
  const r = V.suggest([base, { ...V2, status: 'suspended' }], PKG);
  assert.equal(r.ranked.length, 1);
  assert.equal(r.blocked.length, 1);
  assert.match(r.blocked[0].blockers.join(), /停權/);
});

test('全部不合格時要明說，不可以硬推一家', () => {
  const r = V.suggest([{ ...base, status: 'suspended' }], PKG);
  assert.equal(r.best, null);
  assert.equal(r.ranked.length, 0);
  assert.match(r.why, /不符資格/);
});

test('廠商主檔是空的要明說', () => {
  const r = V.suggest([], PKG);
  assert.equal(r.best, null);
  assert.match(r.why, /空的/);
});

/* ── 集中度：排名越準越會踩的坑 ── */

test('單一廠商超過門檻要警示', () => {
  const c = V.concentration([{ vendor: '甲', amount: 8000000 }, { vendor: '乙', amount: 2000000 }]);
  assert.equal(c.rows[0].share, 0.8);
  assert.equal(c.over.length, 1);
  assert.match(c.note, /單一廠商出事/);
});

test('分散良好時不亂警示', () => {
  const c = V.concentration([
    { vendor: '甲', amount: 3000000 }, { vendor: '乙', amount: 3000000 },
    { vendor: '丙', amount: 2000000 }, { vendor: '丁', amount: 2000000 },
  ]);
  assert.equal(c.over.length, 0);
  assert.ok(c.hhi < 0.3, String(c.hhi));
});

test('HHI：全部給同一家 = 1', () => {
  assert.equal(V.concentration([{ vendor: '甲', amount: 100 }]).hhi, 1);
});

test('同一家的多筆發包要合併計算', () => {
  const c = V.concentration([
    { vendor: '甲', amount: 300 }, { vendor: '甲', amount: 500 }, { vendor: '乙', amount: 200 },
  ]);
  assert.equal(c.rows[0].vendor, '甲');
  assert.equal(c.rows[0].amount, 800);
});

test('金額為 0 或負的不計入', () => {
  const c = V.concentration([{ vendor: '甲', amount: 0 }, { vendor: '乙', amount: -5 }, { vendor: '丙', amount: 100 }]);
  assert.equal(c.total, 100);
  assert.equal(c.rows.length, 1);
});

/* ── 關係人疑慮 ── */

test('兩家共用同一支電話會被標出來，且列出是哪兩家', () => {
  const f = V.relatedParties([
    base,                                                        // 沒填電話，不該被牽連
    { ...V2, phone: '02-1234-5678' },
    { ...base, code: 'V3', name: '丙', taxId: '33333333', phone: '0212345678' },
  ]);
  const phone = f.filter((x) => x.field === 'phone');
  assert.equal(phone.length, 1, JSON.stringify(f));
  assert.equal(phone[0].vendors.length, 2, '沒填電話的那一家不該被算進去');
  assert.deepEqual(phone[0].vendors.map((x) => x.code).sort(), ['V2', 'V3']);
});

test('電話格式不同但實際相同，要視為同一組', () => {
  const f = V.relatedParties([
    { ...base, code: 'A', name: '甲', phone: '02-1234-5678' },
    { ...base, code: 'B', name: '乙', taxId: '2', phone: '（02）12345678' },
  ]);
  assert.equal(f.filter((x) => x.field === 'phone').length, 1, JSON.stringify(f));
});

test('共用負責人與匯款帳戶都要抓', () => {
  const f = V.relatedParties([
    { ...base, code: 'A', name: '甲', owner: '王大明', bankAccount: '008-123456' },
    { ...base, code: 'B', name: '乙', taxId: '2', owner: '王大明', bankAccount: '008-123456' },
  ]);
  assert.ok(f.some((x) => x.field === 'owner'));
  assert.ok(f.some((x) => x.field === 'bankAccount'));
});

test('空欄位不算共用 —— 三家都沒填地址不是關係人', () => {
  const f = V.relatedParties([
    { ...base, code: 'A', name: '甲', address: '' },
    { ...base, code: 'B', name: '乙', taxId: '2', address: '' },
    { ...base, code: 'C', name: '丙', taxId: '3', address: '   ' },
  ]);
  assert.equal(f.filter((x) => x.field === 'address').length, 0);
});

test('各自獨立的廠商不會被誤標', () => {
  const f = V.relatedParties([
    { ...base, code: 'A', name: '甲', taxId: '1', phone: '021111', owner: '甲君', address: '台北市A路' },
    { ...base, code: 'B', name: '乙', taxId: '2', phone: '022222', owner: '乙君', address: '台北市B路' },
  ]);
  assert.equal(f.length, 0, JSON.stringify(f));
});

/* ── 品類 ── */

test('從工項推出這一包在買什麼', () => {
  const cats = V.categoriesOf([{ wbs: '321' }, { wbs: '321' }, { wbs: '323' }, { wbs: '' }]);
  assert.deepEqual(cats.sort(), ['321', '323']);
});
