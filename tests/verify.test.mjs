/**
 * 驗算中心的測試。
 *
 * 核心是那組「標註 vs 幾何」的比對 —— 圖面自己帶著答案：
 * DIMENSION 同時存了 CAD 量到的值（group 42）與圖上印的字（group 1），
 * 兩者不一致只有兩種可能，而兩種都必須被看見。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as VF from '../public/js/takeoff/verify.js';

const dim = (measured, text = '', layer = 'DIM') => ({ type: 'DIMENSION', layer, measured, text, pt: { x: 0, y: 0 } });

/* ── 標註文字解析 ── */

test('空字串與 <> 代表沒有覆寫', () => {
  assert.equal(VF.parseDimText('').kind, 'none');
  assert.equal(VF.parseDimText('   ').kind, 'none');
  assert.equal(VF.parseDimText('<>').kind, 'none');
  assert.equal(VF.parseDimText(' <> ').kind, 'none');
});

test('<>+50 是在量到的值上運算，不是覆寫 —— 不可以當成純數字比', () => {
  assert.equal(VF.parseDimText('<>+50').kind, 'derived');
  assert.equal(VF.parseDimText('(<>)').kind, 'derived');
});

test('取出明確數字，並吃得下 AutoCAD 的控制碼與後綴', () => {
  assert.equal(VF.parseDimText('600').value, 600);
  assert.equal(VF.parseDimText('%%c600').value, 600, '直徑符號');
  assert.equal(VF.parseDimText('600 (TYP)').value, 600);
  assert.equal(VF.parseDimText('R50').value, 50);
  assert.equal(VF.parseDimText('1234.56').value, 1234.56);
  assert.equal(VF.parseDimText('\\A1;300').value, 300, '格式碼要先剝掉');
});

test('純文字標註標成 text，不硬湊一個數字', () => {
  assert.equal(VF.parseDimText('SEE DETAIL').kind, 'text');
  assert.equal(VF.parseDimText('依現場').kind, 'text');
});

/* ── 量級判定 ── */

test('比值落在 1000 倍附近就是差一個量級', () => {
  assert.equal(VF.nearestMagnitude(1000), 1000);
  assert.equal(VF.nearestMagnitude(999.9), 1000);
  assert.equal(VF.nearestMagnitude(0.001), 0.001);
  assert.equal(VF.nearestMagnitude(10.02), 10);
});

test('不成量級的比值回 null —— 那是覆寫不是單位錯', () => {
  assert.equal(VF.nearestMagnitude(1.07), null);
  assert.equal(VF.nearestMagnitude(3.5), null);
  assert.equal(VF.nearestMagnitude(0), null);
  assert.equal(VF.nearestMagnitude(-5), null);
});

/* ── 標註 vs 幾何：這一組是重點 ── */

test('標註與幾何一致 → match，圖檔單位可信', () => {
  const r = VF.checkDimensions([dim(600, '600'), dim(1200, '1200')]);
  assert.equal(r.match, 2);
  assert.equal(r.scale, 0);
  assert.equal(r.override, 0);
});

test('0.5% 內的捨位差異仍算一致', () => {
  const r = VF.checkDimensions([dim(599.8, '600')]);
  assert.equal(r.match, 1);
});

test('圖上寫 600、幾何只有 0.6 → 差 1000 倍，是單位錯不是標註錯', () => {
  const r = VF.checkDimensions([dim(0.6, '600')]);
  assert.equal(r.scale, 1);
  assert.equal(r.override, 0);
  assert.equal(r.rows[0].magnitude, 1000);
});

test('整張圖多數標註差同一個量級 → 判定為圖檔單位錯誤，不是個別失誤', () => {
  const r = VF.checkDimensions([dim(0.6, '600'), dim(1.2, '1200'), dim(3.0, '3000'), dim(0.45, '450')]);
  assert.ok(r.dominant, JSON.stringify(r));
  assert.equal(r.dominant.magnitude, 1000);
  assert.equal(r.dominant.count, 4);
});

test('只有一兩個標註差量級，不該判成整張圖的單位錯（可能只是局部大樣）', () => {
  const rows = [dim(0.6, '600')];
  for (let i = 0; i < 9; i++) rows.push(dim(1000 + i, String(1000 + i)));
  const r = VF.checkDimensions(rows);
  assert.equal(r.scale, 1);
  assert.equal(r.match, 9);
  assert.equal(r.dominant, null, '10 筆裡只有 1 筆，不到六成，不可判定整張圖');
});

test('比值不成量級 → 標註被手動覆寫，這是最危險的一種', () => {
  const r = VF.checkDimensions([dim(560, '600')]);
  assert.equal(r.override, 1);
  assert.equal(r.scale, 0);
  assert.equal(r.rows[0].verdict, 'override');
});

test('沒有覆寫的標註不參與比對，但要算進去讓人知道有多少', () => {
  const r = VF.checkDimensions([dim(600, ''), dim(1200, '<>'), dim(800, '800')]);
  assert.equal(r.noOverride, 2);
  assert.equal(r.checked, 1);
  assert.equal(r.match, 1);
});

test('無法解析的標註文字單獨計數，不當成錯也不當成對', () => {
  const r = VF.checkDimensions([dim(600, 'SEE DETAIL'), dim(700, '<>+50')]);
  assert.equal(r.unparsed, 2);
  assert.equal(r.checked, 0);
});

test('measured 缺值或為 0 的標註直接跳過 —— 除以 0 會產生假的量級', () => {
  const r = VF.checkDimensions([dim(null, '600'), dim(0, '600'), dim(600, '600')]);
  assert.equal(r.total, 1);
  assert.equal(r.match, 1);
});

test('沒有任何標註時回 0，不報錯', () => {
  const r = VF.checkDimensions([{ type: 'LINE', pts: [] }]);
  assert.equal(r.total, 0);
  assert.equal(r.checked, 0);
});

test('每一筆都保留座標與圖層，看得到是哪一個標註出問題', () => {
  const r = VF.checkDimensions([{ ...dim(0.6, '600'), pt: { x: 123, y: 456 }, layer: 'A-DIM' }]);
  assert.equal(r.rows[0].at.x, 123);
  assert.equal(r.rows[0].layer, 'A-DIM');
});

/* ── 閉合 ── */

test('面積工項取自未閉合多段線要報出來', () => {
  const bad = VF.checkClosure([
    { code: 'A', name: '地坪', measureType: 'area', qty: { drawing: 100 }, drawingSource: 'auto', closed: false },
    { code: 'B', name: '天花', measureType: 'area', qty: { drawing: 80 }, drawingSource: 'auto', closed: true },
  ]);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].code, 'A');
  assert.match(bad[0].why, /shoelace/);
});

test('長度與計數工項不做閉合檢查', () => {
  assert.equal(VF.checkClosure([
    { code: 'L', measureType: 'length', qty: { drawing: 100 }, drawingSource: 'auto', closed: false },
    { code: 'C', measureType: 'count', qty: { drawing: 5 }, drawingSource: 'auto', closed: false },
  ]).length, 0);
});

test('沒有圖面量的工項不檢查', () => {
  assert.equal(VF.checkClosure([
    { code: 'A', measureType: 'area', qty: {}, drawingSource: 'auto', closed: false },
  ]).length, 0);
});

/* ── 量級合理性 ── */

test('抓出小到不可能的量', () => {
  const r = VF.checkMagnitude([{ code: 'A', name: '幹線', measureType: 'length', qty: { drawing: 0.2 } }]);
  assert.equal(r.length, 1);
  assert.match(r[0].why, /少乘了一個量級/);
});

test('抓出大到不可能的量', () => {
  const r = VF.checkMagnitude([{ code: 'A', name: '電纜', measureType: 'length', qty: { drawing: 5000000 } }]);
  assert.equal(r.length, 1);
  assert.match(r[0].why, /多乘了一個量級|重複描繪/);
});

test('正常的量不報 —— 誤報會讓人學會忽略警告', () => {
  assert.equal(VF.checkMagnitude([
    { code: 'A', measureType: 'length', qty: { drawing: 1710 } },
    { code: 'B', measureType: 'area', qty: { drawing: 1509 } },
    { code: 'C', measureType: 'count', qty: { drawing: 214 } },
  ]).length, 0);
});

test('沒有量或沒有 measureType 的不檢查', () => {
  assert.equal(VF.checkMagnitude([
    { code: 'A', measureType: 'length', qty: {} },
    { code: 'B', measureType: 'lumpsum', qty: { drawing: 1 } },
  ]).length, 0);
});

/* ── 多來源 ── */

test('只有一條來源不叫驗算 —— 那只是「沒有人反對」', () => {
  const r = VF.crossSources([{ code: 'A', name: 'x', qty: { drawing: 100 } }]);
  assert.equal(r[0].sources, 1);
  assert.equal(r[0].level, 'warn');
  assert.match(r[0].why, /沒有第二條/);
});

test('完全沒有數量是 bad', () => {
  const r = VF.crossSources([{ code: 'A', name: 'x', qty: {} }]);
  assert.equal(r[0].level, 'bad');
});

test('兩條來源接近 → ok', () => {
  const r = VF.crossSources([{ code: 'A', name: 'x', qty: { drawing: 100, boq: 102 } }]);
  assert.equal(r[0].sources, 2);
  assert.equal(r[0].level, 'ok');
});

test('來源差異超過門檻 → bad，並算出差幾成', () => {
  const r = VF.crossSources([{ code: 'A', name: 'x', qty: { drawing: 100, boq: 150 } }]);
  assert.equal(r[0].level, 'bad');
  assert.ok(Math.abs(r[0].spread - 0.3333) < 1e-3, String(r[0].spread));
});

test('三條來源時取最大最小的差', () => {
  const r = VF.crossSources([{ code: 'A', name: 'x', qty: { drawing: 100, boq: 105, manual: 103 } }]);
  assert.equal(r[0].sources, 3);
  assert.ok(r[0].spread < 0.05);
});

/* ── 報告 ── */

test('八項全是「沒得驗」時，不可以說通過', () => {
  const r = VF.report({});
  assert.equal(r.passed, false);
  assert.equal(r.verdict, 'none');
  assert.match(r.note, /不是「沒有錯誤」，是「沒有檢查」/);
});

test('「已驗過」與「沒得驗」要分開 —— 這兩件事意義相反', () => {
  const r = VF.report({ dimensions: { total: 0 } });
  const d = r.checks.find((c) => c.key === 'dim');
  assert.equal(d.status, 'none');
  assert.match(d.msg, /無法用圖面自己的標註/);
});

test('標註全部相符時該項通過，並說明單位與比例可信', () => {
  const r = VF.report({ dimensions: VF.checkDimensions([dim(600, '600'), dim(900, '900')]) });
  const d = r.checks.find((c) => c.key === 'dim');
  assert.equal(d.status, 'ok');
  assert.match(d.msg, /單位與比例可信/);
});

test('整張圖差一個量級是 bad，訊息要指向單位或比例設定', () => {
  const dims = VF.checkDimensions([dim(0.6, '600'), dim(1.2, '1200'), dim(0.9, '900')]);
  const r = VF.report({ dimensions: dims });
  const d = r.checks.find((c) => c.key === 'dim');
  assert.equal(d.status, 'bad');
  assert.match(d.msg, /1000 倍/);
  assert.equal(r.passed, false);
});

test('標註被覆寫的訊息要講清楚為什麼兩邊永遠對不起來', () => {
  const r = VF.report({ dimensions: VF.checkDimensions([dim(560, '600')]) });
  const d = r.checks.find((c) => c.key === 'dim');
  assert.equal(d.status, 'bad');
  assert.match(d.msg, /人看圖相信文字，程式量測相信幾何/);
});

test('有一項 bad 就不算通過', () => {
  const r = VF.report({
    dimensions: VF.checkDimensions([dim(600, '600')]),
    dupe: { clean: false, totals: { ratio: 0.4, duplicated: 100, dupInserts: 0 } },
  });
  assert.equal(r.passed, false);
  assert.equal(r.verdict, 'bad');
  assert.match(r.note, /不可直接用於發包/);
});

test('全部 ok 且至少驗過一項才算通過', () => {
  const r = VF.report({
    dimensions: VF.checkDimensions([dim(600, '600')]),
    dupe: { clean: true, totals: {} },
    items: [{ code: 'A', measureType: 'length', qty: { drawing: 100, boq: 101 } }],
    closure: [], magnitude: [],
    cross: VF.crossSources([{ code: 'A', name: 'x', qty: { drawing: 100, boq: 101 } }]),
  });
  assert.equal(r.passed, true);
  assert.equal(r.verdict, 'ok');
});

test('不按比例的圖直接判 bad —— 任何量測都不可作為數量依據', () => {
  const r = VF.report({ pdfScale: { nts: true } });
  const s = r.checks.find((c) => c.key === 'scale');
  assert.equal(s.status, 'bad');
  assert.match(s.msg, /不可作為數量依據/);
});

test('每一項檢查都有 key、標題、狀態與訊息', () => {
  const r = VF.report({});
  assert.equal(r.checks.length, 8);
  for (const c of r.checks) {
    assert.ok(c.key && c.label && c.status && c.msg, JSON.stringify(c));
    assert.ok(['ok', 'warn', 'bad', 'none'].includes(c.status));
  }
});

test('人工量測的面積不做閉合檢查 —— 那個 closed 旗標講的是別的事', () => {
  // 範本裡 150.01 就長這樣：drawingSource='measure'、無 provenance、closed=false。
  // 原本的條件因為 && 短路而放行，把它誤判成「多段線未閉合」。
  const bad = VF.checkClosure([
    { code: '150.01', name: '普通模板', measureType: 'area', qty: { drawing: 1200 },
      drawingSource: 'measure', provenance: null, closed: false },
  ]);
  assert.equal(bad.length, 0, JSON.stringify(bad));
});

test('圖層彙總來的未閉合面積仍然要抓 —— 修誤報不可以順手把真報也關掉', () => {
  assert.equal(VF.checkClosure([
    { code: 'A', measureType: 'area', qty: { drawing: 100 }, drawingSource: 'auto', closed: false },
  ]).length, 1);
  assert.equal(VF.checkClosure([
    { code: 'B', measureType: 'area', qty: { drawing: 100 }, drawingSource: 'measure',
      provenance: { kind: 'dxf-layer', layer: 'X' }, closed: false },
  ]).length, 1);
});
