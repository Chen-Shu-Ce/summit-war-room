/**
 * 發包單（PO）的測試。
 *
 * 最重要的一組是**超發**：兩張 PO 各自看都合理，加起來才超過請購量。
 * 這是採購最容易出事、也最難事後查的一種錯，必須在開單當下擋。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as PO from '../public/js/takeoff/po.js';
import * as B from '../public/js/takeoff/baseline.js';

/*
 * PR 用**真的** createPr 產生，不自己捏一個。
 *
 * 一開始我捏了一個 `{ code, qty, unitPrice }` 的假 PR，測試全過 ——
 * 但真實的 PR 明細欄位叫 `itemCode` 不是 `code`。結果所有列的鍵都是
 * undefined，Map 只剩一筆，每一列都拿到最後一列的資料，超發檢查完全失效，
 * 而畫面上還是會生出一張看起來正常的發包單。
 *
 * 假造上游資料的測試只能證明「我的假設自洽」，不能證明「接得起來」。
 */
const ITEMS = [
  { code: '321.01', wbs: '321', name: '電纜 38mm²', spec: '600V', unit: 'M',
    qty: { manual: 1000 }, manualBy: '技師', manualNote: '複核', unitPrice: 780, leadTimeDays: 45,
    order: { unit: 'M', unitFactor: 1, packMultiple: 1, moq: 0 }, wasteRate: 0, measureType: 'length' },
  { code: '323.01', wbs: '323', name: '電纜架', spec: '600W', unit: 'M',
    qty: { manual: 400 }, manualBy: '技師', manualNote: '複核', unitPrice: 2450, leadTimeDays: 30,
    order: { unit: 'M', unitFactor: 1, packMultiple: 1, moq: 0 }, wasteRate: 0, measureType: 'length' },
];
const SET = { defaultWasteRate: 0, gateBand: 'D', taxRate: 0.05, stochastic: false };
const PKG = { code: 'PKG-E', name: '電氣', itemCodes: ['321.01', '323.01'], vendor: '', needDate: '2026-12-01' };

const fz = B.freezeBaseline(PKG, ITEMS, SET, { confirmedBy: '技師', by: '技師' });
if (fz.error) throw new Error('測試前置失敗：' + fz.error);
const made = B.createPr(fz.baseline, { requester: '採購', needDate: '2026-12-01', taxRate: 0.05, dept: '採購部' }, []);
if (made.error) throw new Error('測試前置失敗：' + made.error);
const PR = made.pr;

test('前置檢查：PR 明細用的是 itemCode 欄位，而且數量與單價如預期', () => {
  assert.equal(PR.lines.length, 2);
  assert.ok(PR.lines.every((l) => l.itemCode), '真實 PR 用 itemCode');
  assert.ok(PR.lines.every((l) => l.code === undefined), '真實 PR 沒有 code 欄位 —— 這就是當初的坑');
  assert.equal(PR.lines.find((l) => l.itemCode === '321.01').qty, 1000);
  assert.equal(PR.lines.find((l) => l.itemCode === '321.01').unitPrice, 780);
});
const VENDOR = { code: 'V1', name: '甲電材', taxId: '11111111', paymentDays: 60 };
const OK = { by: '採購 王小明', lines: [{ code: '321.01', qty: 1000, unitPrice: 760 }] };

/* ── 單號 ── */

test('單號依樣板遞增，只看同字首的既有單號', () => {
  const d = new Date('2026-09-15T00:00:00Z');
  assert.equal(PO.nextPoNo([], PO.DEFAULT_PO_TEMPLATE, d), 'PO-202609-001');
  assert.equal(PO.nextPoNo(['PO-202609-001', 'PO-202609-007'], PO.DEFAULT_PO_TEMPLATE, d), 'PO-202609-008');
  // 別的月份不影響本月流水號
  assert.equal(PO.nextPoNo(['PO-202608-099'], PO.DEFAULT_PO_TEMPLATE, d), 'PO-202609-001');
});

/* ── 開單的必要條件 ── */

test('沒有廠商不可以開 —— 發包單是對外契約，沒有對手方就不是發包單', () => {
  assert.match(PO.createPo(PR, {}, OK).error, /廠商/);
  assert.match(PO.createPo(PR, { name: '  ' }, OK).error, /廠商/);
});

test('沒有發包人不可以開', () => {
  assert.match(PO.createPo(PR, VENDOR, { lines: OK.lines }).error, /發包人/);
});

test('沒有來源請購單不可以開', () => {
  assert.match(PO.createPo(null, VENDOR, OK).error, /請購單/);
});

test('不在請購單裡的工項會被拒絕，並說出原因', () => {
  const r = PO.createPo(PR, VENDOR, { by: 'A', lines: [{ code: '999.99', qty: 5 }] });
  assert.ok(r.error);
  assert.match(r.rejected[0].why, /不在來源請購單/);
});

/* ── 超發：這一組才是重點 ── */

test('單張 PO 不可以超過請購量', () => {
  const r = PO.createPo(PR, VENDOR, { by: 'A', lines: [{ code: '321.01', qty: 1200 }] });
  assert.ok(r.error);
  assert.match(r.rejected[0].why, /超發/);
  assert.match(r.rejected[0].why, /200/);
});

test('兩張 PO 各自合理，加起來超過就要擋 —— 這才是真正會出事的情形', () => {
  const first = PO.createPo(PR, VENDOR, { by: 'A', lines: [{ code: '321.01', qty: 700 }] }).po;
  assert.equal(first.lines[0].qty, 700);
  // 第二張只開 400，單看沒問題；但 700 + 400 = 1100 > 1000
  const second = PO.createPo(PR, { ...VENDOR, code: 'V2', name: '乙電材' },
    { by: 'A', lines: [{ code: '321.01', qty: 400 }] }, [first]);
  assert.ok(second.error, JSON.stringify(second.po && second.po.lines));
  assert.match(second.rejected[0].why, /已開 700/);
});

test('剛好開滿是允許的 —— 邊界不可以因為浮點誤差而擋掉', () => {
  const first = PO.createPo(PR, VENDOR, { by: 'A', lines: [{ code: '321.01', qty: 700 }] }).po;
  const second = PO.createPo(PR, VENDOR, { by: 'A', lines: [{ code: '321.01', qty: 300 }] }, [first]);
  assert.ok(second.po, JSON.stringify(second.rejected));
  assert.equal(second.po.lines[0].qty, 300);
});

test('已取消的 PO 不佔額度', () => {
  const first = PO.createPo(PR, VENDOR, { by: 'A', lines: [{ code: '321.01', qty: 1000 }] }).po;
  const cancelled = { ...first, status: 'cancelled' };
  const again = PO.createPo(PR, VENDOR, { by: 'A', lines: [{ code: '321.01', qty: 1000 }] }, [cancelled]);
  assert.ok(again.po, JSON.stringify(again.rejected));
});

test('數量必須大於 0', () => {
  const r = PO.createPo(PR, VENDOR, { by: 'A', lines: [{ code: '321.01', qty: 0 }] });
  assert.match(r.rejected[0].why, /大於 0/);
});

/* ── 一對多、多對一 ── */

test('一張 PR 可以拆給兩家廠商', () => {
  const a = PO.createPo(PR, VENDOR, { by: 'A', lines: [{ code: '321.01', qty: 600 }] }).po;
  const b = PO.createPo(PR, { code: 'V2', name: '乙電材' },
    { by: 'A', lines: [{ code: '321.01', qty: 400 }] }, [a]).po;
  assert.equal(a.vendor, '甲電材');
  assert.equal(b.vendor, '乙電材');
  assert.equal(a.lines[0].qty + b.lines[0].qty, 1000);
});

test('每一列都記得自己來自哪一張 PR —— 多張 PR 合成一張 PO 時才追得回去', () => {
  const po = PO.createPo(PR, VENDOR, OK).po;
  assert.equal(po.lines[0].prNo, PR.no);
  assert.deepEqual(po.prNos, [PR.no]);
});

/* ── 議價差額：不可以覆蓋估價 ── */

test('議定價與估價分開存 —— 覆蓋估價等於刪掉「我估得準不準」這個資訊', () => {
  const po = PO.createPo(PR, VENDOR, OK).po;
  assert.equal(po.lines[0].estUnitPrice, 780, '估價必須留著');
  assert.equal(po.lines[0].unitPrice, 760, '議定價');
  assert.equal(po.lines[0].estAmount, 780000);
  assert.equal(po.lines[0].amount, 760000);
});

test('議價差額算在最上層：負數 = 談下來了', () => {
  const po = PO.createPo(PR, VENDOR, OK).po;
  assert.equal(po.variance, -20000);
  assert.ok(Math.abs(po.variancePct + 0.025641) < 1e-5, String(po.variancePct));
});

test('沒有議定價時沿用估價，差額為 0', () => {
  const po = PO.createPo(PR, VENDOR, { by: 'A', lines: [{ code: '321.01', qty: 1000 }] }).po;
  assert.equal(po.lines[0].unitPrice, 780);
  assert.equal(po.variance, 0);
});

test('金額合計與稅：760,000 × 1.05 = 798,000', () => {
  const po = PO.createPo(PR, VENDOR, OK).po;
  assert.equal(po.subtotal, 760000);
  assert.equal(po.tax, 38000);
  assert.equal(po.total, 798000);
});

test('稅率沿用 PR，可被 payload 覆寫', () => {
  assert.equal(PO.createPo(PR, VENDOR, OK).po.taxRate, 0.05);
  assert.equal(PO.createPo(PR, VENDOR, { ...OK, taxRate: 0 }).po.taxRate, 0);
  assert.equal(PO.createPo(PR, VENDOR, { ...OK, taxRate: 0 }).po.total, 760000);
});

test('付款條件沒填時，用廠商主檔的帳期帶出來', () => {
  assert.equal(PO.createPo(PR, VENDOR, OK).po.paymentTerms, '月結 60 天');
  assert.equal(PO.createPo(PR, VENDOR, { ...OK, paymentTerms: '驗收後 30 天' }).po.paymentTerms, '驗收後 30 天');
});

/* ── 開單前檢查 ── */

test('沒有議定單價的列不可發出', () => {
  const po = PO.createPo(PR, VENDOR, OK).po;
  po.lines[0].unitPrice = null;
  const is = PO.poReadiness(po);
  assert.ok(is.some((x) => x.level === 'bad' && /不可發出/.test(x.msg)), JSON.stringify(is));
});

test('缺交貨日期與付款條件要提醒', () => {
  // 廠商主檔沒有帳期，payload 也沒填 —— 這時候才是真的沒有付款條件。
  // 廠商主檔有帳期時會自動帶出來，那是對的，不該提醒。
  const noTerms = { code: 'V9', name: '無帳期廠商' };
  const po = PO.createPo(PR, noTerms, OK).po;
  po.deliveryDate = '';
  const msgs = PO.poReadiness(po).map((x) => x.msg).join('|');
  assert.match(msgs, /交貨日期/);
  assert.match(msgs, /付款條件/);
});

test('廠商主檔有帳期時自動帶出，不再提醒缺付款條件', () => {
  const po = PO.createPo(PR, VENDOR, OK).po;
  assert.equal(po.paymentTerms, '月結 60 天');
  assert.ok(!PO.poReadiness(po).some((x) => /付款條件/.test(x.msg)));
});

test('報價比估價低太多要警示 —— 過低報價是最常見的糾紛起點', () => {
  const po = PO.createPo(PR, VENDOR, { by: 'A', lines: [{ code: '321.01', qty: 1000, unitPrice: 500 }] }).po;
  assert.ok(PO.poReadiness(po).some((x) => /過低的報價/.test(x.msg)), JSON.stringify(po.variancePct));
});

test('報價比估價高很多也要警示', () => {
  const po = PO.createPo(PR, VENDOR, { by: 'A', lines: [{ code: '321.01', qty: 1000, unitPrice: 900 }] }).po;
  assert.ok(PO.poReadiness(po).some((x) => /比估價高/.test(x.msg)));
});

test('議價差額在正常範圍時不亂警示', () => {
  const po = PO.createPo(PR, VENDOR, OK).po;
  assert.ok(!PO.poReadiness(po).some((x) => /比估價/.test(x.msg)));
});

test('關係人疑慮與集中度會併進開單前檢查', () => {
  const po = PO.createPo(PR, VENDOR, OK).po;
  const is = PO.poReadiness(po, { relatedParties: [{ label: '匯款帳戶' }], share: 0.65 });
  assert.ok(is.some((x) => /共用識別資訊/.test(x.msg)));
  assert.ok(is.some((x) => /65%/.test(x.msg)));
});

/* ── 狀態 ── */

test('狀態只能往前走，不能倒退 —— 已發出的契約文件不能偷偷改', () => {
  const po = PO.createPo(PR, VENDOR, OK).po;
  const issued = PO.setStatus(po, 'issued', '王').po;
  assert.equal(issued.status, 'issued');
  assert.match(PO.setStatus(issued, 'draft').error, /不可從/);
  assert.equal(PO.setStatus(issued, 'acked').po.status, 'acked');
});

test('任何狀態都可以取消', () => {
  const po = PO.createPo(PR, VENDOR, OK).po;
  const issued = PO.setStatus(po, 'issued').po;
  assert.equal(PO.setStatus(issued, 'cancelled').po.status, 'cancelled');
});

test('每次狀態變更都留紀錄（誰、什麼時候、從哪到哪）', () => {
  const po = PO.createPo(PR, VENDOR, OK).po;
  const h = PO.setStatus(PO.setStatus(po, 'issued', '王').po, 'acked', '李').po.history;
  assert.equal(h.length, 2);
  assert.equal(h[0].from, 'draft');
  assert.equal(h[0].to, 'issued');
  assert.equal(h[1].by, '李');
});

test('未知狀態要報錯', () => {
  assert.ok(PO.setStatus(PO.createPo(PR, VENDOR, OK).po, '亂打').error);
});

/* ── 可開單明細與達成狀況 ── */

test('已開滿的工項不再列出來 —— 列出來只會讓人不小心再開一次', () => {
  const first = PO.createPo(PR, VENDOR, { by: 'A', lines: [{ code: '321.01', qty: 1000 }] }).po;
  const open = PO.openLines(PR, [first]);
  assert.equal(open.length, 1);
  assert.equal(open[0].code, '323.01');
});

test('部分開單時列出剩餘量', () => {
  const first = PO.createPo(PR, VENDOR, { by: 'A', lines: [{ code: '321.01', qty: 600 }] }).po;
  const open = PO.openLines(PR, [first]);
  const ln = open.find((x) => x.code === '321.01');
  assert.equal(ln.already, 600);
  assert.equal(ln.remaining, 400);
});

test('PR 達成狀況：開了幾張 PO、還剩幾項沒開完', () => {
  const a = PO.createPo(PR, VENDOR, { by: 'A', lines: [{ code: '321.01', qty: 1000 }] }).po;
  const f = PO.prFulfilment(PR, [a]);
  assert.equal(f.poCount, 1);
  assert.deepEqual(f.poNos, [a.no]);
  assert.equal(f.complete, false);
  assert.equal(f.open, 1);
  assert.equal(f.rows.find((r) => r.code === '321.01').full, true);
  assert.equal(f.rows.find((r) => r.code === '323.01').remaining, 400);
});

test('全部開完就是 complete', () => {
  const a = PO.createPo(PR, VENDOR, { by: 'A', lines: [{ code: '321.01', qty: 1000 }, { code: '323.01', qty: 400 }] }).po;
  assert.equal(PO.prFulfilment(PR, [a]).complete, true);
});

test('沒有任何 PO 時，達成狀況是零而不是報錯', () => {
  const f = PO.prFulfilment(PR, []);
  assert.equal(f.poCount, 0);
  assert.equal(f.complete, false);
  assert.equal(f.rows.length, 2);
});

test('明細沒有工項代碼時要明確拒絕 —— 讓它落進 undefined 鍵就是當初那個 bug', () => {
  const r = PO.createPo(PR, VENDOR, { by: 'A', lines: [{ qty: 10, unitPrice: 5 }] });
  assert.ok(r.error);
  assert.match(r.rejected[0].why, /沒有工項代碼/);
});

test('來源 PR 的明細全都沒有代碼時，整張拒絕而不是硬生一張出來', () => {
  const broken = { ...PR, lines: PR.lines.map(({ itemCode, ...rest }) => rest) };
  const r = PO.createPo(broken, VENDOR, { by: 'A', lines: [{ code: '321.01', qty: 1 }] });
  assert.match(r.error, /沒有工項代碼/);
});

test('兩個不同工項不會互相污染額度（Map 鍵正確才會成立）', () => {
  const a = PO.createPo(PR, VENDOR, { by: 'A', lines: [{ code: '321.01', qty: 1000 }] }).po;
  // 321.01 已開滿，但 323.01 應該還開得出來
  const b = PO.createPo(PR, VENDOR, { by: 'A', lines: [{ code: '323.01', qty: 400 }] }, [a]);
  assert.ok(b.po, JSON.stringify(b.rejected));
  assert.equal(b.po.lines[0].code, '323.01');
  assert.equal(b.po.lines[0].qty, 400);
});

test('每一列拿到的是自己的資料，不是最後一列的', () => {
  const po = PO.createPo(PR, VENDOR, { by: 'A',
    lines: [{ code: '321.01', qty: 100 }, { code: '323.01', qty: 50 }] }).po;
  const a = po.lines.find((l) => l.code === '321.01');
  const c = po.lines.find((l) => l.code === '323.01');
  assert.equal(a.name, '電纜 38mm²');
  assert.equal(c.name, '電纜架');
  assert.equal(a.estUnitPrice, 780);
  assert.equal(c.estUnitPrice, 2450);
});
