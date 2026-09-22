/**
 * PCCES 標單解析的測試。
 *
 * 這裡的測試資料是**合成的**，照真實 PCCES 檔案的結構寫出來，
 * 但不含任何真實專案的工程名稱、機關、地點或金額 ——
 * 標單是機密文件，不該進版控。
 *
 * 結構依據（真實檔案觀察到的）：
 *   - 表頭前面有機關名稱、工程名稱、日期等好幾列
 *   - 表頭是「項 次」「項  目  及  說  明」（字中間有空白）
 *   - 項次是點分階層，最多 5 層
 *   - 名稱會跨列，續列的項次是空的、但其他欄可能有 0 或旗標
 *   - 編碼欄是「細目碼,旗標」，碼長 10–15 都有
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../public/js/takeoff/pcces.js';

const DETAIL = [
  ['某某公所', '', '', '', '', '', '', '', ''],
  ['詳細價目表[標單]', '', '', '', '', '', '', '', ''],
  ['', '', '', '', '', '46097', '', '', ''],
  ['工程名稱', '測試工程', '', '', '會計科目', '', '', '', ''],
  ['施工地點', '測試地點', '', '', '工程編號', 'TEST001', '', '', ''],
  ['', '', '', '', '', '', '', '', ''],
  ['', '', '', '', '', '', '', '', ''],
  ['項 次', '項  目  及  說  明', '單 位', '數 量', '單 價', '複 價', '', '編碼(備註)', '權重比%'],
  ['壹', '發包工程費', '', '', '', '', '', '', '1000000'],
  ['壹.一', '建築工程', '', '', '', '', '', '', ''],
  ['壹.一.甲', '假設工程', '', '', '', '', '', '', ''],
  ['壹.一.甲.1', '施工圍籬，安全圍籬,甲種', 'M', '100', '1600', '160000', '', '015640000102a,#', ''],
  ['', '(H=240cm含止水墩)', '', '', '', '0', '', ',*', ''],          // 續列：有 0 有旗標
  ['壹.一.甲.2', '臨時設施', '式', '1', '40000', '40000', '', '0151000004C1,#', ''],
  ['壹.一.乙', '結構工程', '', '', '', '', '', '', ''],
  ['壹.一.乙.1', '鋼筋，SD420W', 'T', '10', '30000', '300000', '', '0322000001S1,#,*', ''],
  ['壹.一.乙.2', '未詢價項目', '式', '1', '', '', '', '', ''],
];

/* ── 表頭定位 ── */

test('表頭不在第一列，要靠欄名找 —— 而且欄名中間有空白', () => {
  const h = P.findHeader(DETAIL);
  assert.equal(h.row, 7);
  assert.equal(h.map.no, 0);
  assert.equal(h.map.qty, 3);
  assert.equal(h.map.code, 7);
});

test('找不到表頭時回錯誤，不會硬解出一堆垃圾', () => {
  const r = P.parseDetail([['隨便'], ['的資料']]);
  assert.ok(r.error);
  assert.match(r.error, /表頭/);
});

/* ── 數字 ── */

test('千分位要吃得下，空白回 null 而不是 0', () => {
  assert.equal(P.num('1,234.5'), 1234.5);
  assert.equal(P.num(' 12 '), 12);
  assert.equal(P.num(''), null, '空白是「沒有」，不是 0 —— 0 會被加進總價');
  assert.equal(P.num('待詢價'), null);
});

/* ── 解析 ── */

const R = P.parseDetail(DETAIL);

test('解析出全部有項次的列（續列不算一筆）', () => {
  assert.equal(R.items.length, 8, R.items.map((x) => x.no).join(','));
});

test('名稱跨列時會接起來', () => {
  const x = R.items.find((i) => i.no === '壹.一.甲.1');
  assert.equal(x.name, '施工圍籬，安全圍籬,甲種(H=240cm含止水墩)');
});

test('續列有數字也不會被當成一筆工項', () => {
  // 續列的複價是 0。若誤判成工項，項數會變 9、而且多一筆 0 元的工項
  assert.ok(!R.items.some((x) => x.no === ''), '續列不該產生工項');
});

test('階層由項次的點數決定', () => {
  assert.equal(R.items.find((x) => x.no === '壹').level, 1);
  assert.equal(R.items.find((x) => x.no === '壹.一.甲.1').level, 4);
  assert.equal(R.items.find((x) => x.no === '壹.一.甲.1').parent, '壹.一.甲');
});

test('編碼與旗標分開，但原字串不改寫', () => {
  const x = R.items.find((i) => i.no === '壹.一.乙.1');
  assert.equal(x.code, '0322000001S1');
  assert.deepEqual(x.flags, ['#', '*']);
});

test('碼長不做驗證 —— 真實檔案 10 到 15 碼都有，拿猜的規則去擋只會擋錯', () => {
  const x = R.items.find((i) => i.no === '壹.一.甲.1');
  assert.equal(x.code, '015640000102a', '13 碼，含小寫字母，照收');
});

/* ── 細項 vs 標題層 ── */

test('只有沒有子項、且有數量的才是細項', () => {
  const lv = P.leaves(R.items).map((x) => x.no);
  assert.deepEqual(lv, ['壹.一.甲.1', '壹.一.甲.2', '壹.一.乙.1', '壹.一.乙.2']);
});

test('標題層不算工項 —— 算進去金額會被重複計', () => {
  const g = P.groups(R.items).map((x) => x.no);
    assert.deepEqual(g, ['壹', '壹.一', '壹.一.甲', '壹.一.乙']);
});

/* ── 驗算 ── */

test('單價 × 數量 ≠ 複價 要抓出來', () => {
  const bad = P.parseDetail([
    DETAIL[7],
    ['壹.1', 'X', 'M', '10', '100', '950', '', '', ''],   // 應為 1000
  ]);
  const errs = P.checkLineMath(bad.items);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].calc, 1000);
  assert.equal(errs[0].declared, 950);
});

test('1 元以內的差視為四捨五入，不報警 —— PCCES 的複價本來就取整', () => {
  const p = P.parseDetail([DETAIL[7], ['壹.1', 'X', 'M', '3', '33.33', '100', '', '', '']]);
  assert.equal(P.checkLineMath(p.items).length, 0, '3 × 33.33 = 99.99，寫 100 是正常取整');
});

test('缺單價或缺複價的不算錯 —— 那是待詢價，不是算錯', () => {
  assert.equal(P.checkLineMath(P.leaves(R.items)).length, 0);
});

test('標題層金額與子項和對不上要抓出來', () => {
  const rows = [DETAIL[7],
    ['壹.一', '群組', '', '', '', '500', '', '', ''],
    ['壹.一.1', 'A', 'M', '1', '300', '300', '', '', ''],
    ['壹.一.2', 'B', 'M', '1', '400', '400', '', '', ''],
  ];
  const p = P.parseDetail(rows);
  const bad = P.checkRollup(p.items);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].declared, 500);
  assert.equal(bad[0].sum, 700);
  assert.equal(bad[0].diff, -200);
});

test('標題層沒填金額就不檢查 —— PCCES 多數標題層本來就空白', () => {
  assert.equal(P.checkRollup(R.items).length, 0);
});

/* ── 單價分析：人材機 ── */

const ANALYSIS = [
  ['某某公所', '', '', '', '', ''],
  ['單價分析表[預算]', '', '', '', '', ''],
  ['項次：', '工程編號：TEST001', '', '', '', ''],
  ['壹.一.甲.1', '工作項目：施工圍籬，安全圍籬', '', '單位：M', '', '計價代碼：01564000010'],
  ['', '工料名稱', '單位', '數量', '單價', '複價'],
  ['', '圍籬製作裝拆，堪用品', 'M', '1', '504', '504'],
  ['', '（含配件）', '', '', '', ''],
  ['', '模板工', '工', '0.5', '3200', '1600'],
  ['', '吊車台班', '台班', '0.1', '8000', '800'],
];

test('單價分析表解析出工作項目與工料明細', () => {
  const a = P.parseAnalysis(ANALYSIS);
  assert.equal(a.length, 1);
  assert.equal(a[0].code, '01564000010');
  assert.equal(a[0].lines.length, 3);
});

test('工料名稱跨列也會接起來', () => {
  const a = P.parseAnalysis(ANALYSIS);
  assert.equal(a[0].lines[0].name, '圍籬製作裝拆，堪用品（含配件）');
});

test('人材機分類：工資類歸人工、台班類歸機具', () => {
  assert.equal(P.resourceKind('模板工'), 'labor');
  assert.equal(P.resourceKind('吊車台班'), 'machine');
  assert.equal(P.resourceKind('鋼筋 SD420W'), 'material');
});

test('分不出來就是 unknown，不偷偷併進材料', () => {
  assert.equal(P.resourceKind(''), 'unknown');
});

test('單價拆成材／人／機，金額加總等於原單價', () => {
  const a = P.parseAnalysis(ANALYSIS)[0];
  const sp = P.splitUnitPrice(a);
  assert.equal(sp.material, 504);
  assert.equal(sp.labor, 1600);
  assert.equal(sp.machine, 800);
  assert.equal(sp.total, 2904, '504 + 1600 + 800');
  assert.equal(sp.complete, true);
});

/* ── 匯出回 PCCES ── */

test('匯出只換數量，項次／細目碼／名稱／單位一律照抄', () => {
  const rows = P.toDetailRows(R.items, new Map([['壹.一.甲.1', 250]]));
  const line = rows.find((r) => r[0] === '壹.一.甲.1');
  assert.equal(line[3], 250, '數量換成新的');
  assert.equal(line[4], 1600, '單價不動');
  assert.equal(line[5], 400000, '複價跟著重算：250 × 1600');
  assert.equal(line[7], '015640000102a,#', '細目碼與旗標原樣送回 —— 改了就對不上原標單');
});

test('沒有給新數量的項目，數量與複價都維持原值', () => {
  const rows = P.toDetailRows(R.items, new Map());
  const line = rows.find((r) => r[0] === '壹.一.乙.1');
  assert.equal(line[3], 10);
  assert.equal(line[5], 300000);
});

/* ── 摘要 ── */

test('摘要分得出有碼／無碼、有價／待詢價', () => {
  const sm = P.summary(R);
  assert.equal(sm.leaves, 4);
  assert.equal(sm.withCode, 3);
  assert.equal(sm.noCode, 1);
  assert.equal(sm.priced, 3);
  assert.equal(sm.unpriced, 1);
  assert.equal(sm.total, 500000, '160,000 + 40,000 + 300,000');
});
