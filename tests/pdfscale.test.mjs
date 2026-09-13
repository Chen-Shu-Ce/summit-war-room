/**
 * PDF 圖框比例判讀的回歸測試。
 *
 * 案例來自一張真實施工圖（φ60cm 基樁詳圖，A1，凃秀瑋建築師事務所）。
 * 那張圖同時證明了這個功能有用、也證明了它很危險：
 *   圖框寫「A1圖:1:100」，但 SECTION A-A 的 600mm 尺寸線在紙上是 59.97mm ——
 *   實際是 1:10。整張套圖框比例，大樣的量測會整批錯 10 倍。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../public/js/takeoff/pdfscale.js';

// 真實圖的實測值
const REAL = { wPt: 2384, hPt: 1684, texts: [
  '芎林鄉新設資源回收貯存場新建工程', 'A3圖:1:200', 'A1圖:1:100', '比例', '凃秀瑋建築師事務所',
] };

/* ── 紙張 ── */

test('由頁面尺寸判定紙張規格與方向', () => {
  const a1 = P.detectPaper(2384, 1684);
  assert.equal(a1.name, 'A1');
  assert.equal(a1.orientation, 'landscape');
  assert.ok(a1.slack < 0.1, `吻合誤差 ${a1.slack} mm`);

  // 注意單位是 pt 不是 mm：841.89 × 1190.55 pt = 297 × 420 mm = A3 直式
  assert.equal(P.detectPaper(841.89, 1190.55).name, 'A3');
  assert.equal(P.detectPaper(841.89, 1190.55).orientation, 'portrait');
  assert.equal(P.detectPaper(595, 842).name, 'A4');
  assert.equal(P.detectPaper(3370, 2384).name, 'A0', 'A0 橫式 = 1189 × 841 mm');
  assert.equal(P.detectPaper(100, 100), null, '不吻合任何規格就回 null');
  assert.equal(P.detectPaper(0, 0), null);
  assert.equal(P.detectPaper(NaN, 100), null);
});

test('紙張吻合的精確度就是「有沒有被縮放過」的證據', () => {
  const exact = P.detectPaper(2384, 1684);
  assert.ok(exact.slack <= P.EXACT_MM, '原尺寸輸出，誤差在 0.5mm 內');
  // 縮到 96% 的 A1（列印「符合頁面大小」的典型結果）
  const shrunk = P.detectPaper(2384 * 0.96, 1684 * 0.96);
  assert.ok(!shrunk || shrunk.slack > P.EXACT_MM, '被縮放過就不該算「精確吻合」');
});

/* ── 比例文字 ── */

test('認得各種比例寫法', () => {
  const one = (s) => P.findScales(s).filter((x) => !x.nts);
  assert.equal(one('1:100')[0].ratio, 100);
  assert.equal(one('1/50')[0].ratio, 50);
  assert.equal(one('1：200')[0].ratio, 200, '全形冒號');
  assert.equal(one('SCALE 1:20')[0].ratio, 20);
  assert.equal(one('比例 1/30')[0].ratio, 30);
  assert.equal(one('S:1/200')[0].ratio, 200);

  const withPaper = one('A1圖:1:100')[0];
  assert.equal(withPaper.paper, 'A1');
  assert.equal(withPaper.ratio, 100);
  assert.equal(one('A3圖:1:200')[0].paper, 'A3');
});

test('「不按比例」要被認出來 —— 那種圖不能量', () => {
  assert.ok(P.findScales('NTS').some((x) => x.nts));
  assert.ok(P.findScales('N.T.S.').some((x) => x.nts));
  assert.ok(P.findScales('不按比例').some((x) => x.nts));
  assert.ok(!P.findScales('1:100').some((x) => x.nts));
});

test('不把無關的數字當成比例', () => {
  assert.deepEqual(P.findScales('f\'c=280kg/cm2').filter((x) => !x.nts), []);
  assert.deepEqual(P.findScales('#3@150').filter((x) => !x.nts), []);
  assert.deepEqual(P.findScales('28-7φ').filter((x) => !x.nts), []);
  assert.deepEqual(P.findScales('fpu=155kg/mm2').filter((x) => !x.nts), []);
});

/* ── 挑比例：挑錯就差一倍 ── */

test('同時標 A1 與 A3 兩種比例時，依實際紙張挑', () => {
  const c = P.collectScales(REAL.texts);
  assert.equal(c.scales.length, 2);
  const a1 = P.pickScale(c, P.detectPaper(2384, 1684));
  assert.equal(a1.pick.ratio, 100, 'A1 紙張要挑 1:100');
  assert.equal(a1.reason, 'paper-match');
  // 同一份文字若印在 A3 上
  const a3 = P.pickScale(c, P.detectPaper(1191, 842));
  assert.equal(a3.pick.ratio, 200, 'A3 紙張要挑 1:200');
});

test('紙張規格對不上圖框標的，就不挑 —— 那代表輸出紙張被換過', () => {
  const c = P.collectScales(['A1圖:1:100', 'A3圖:1:200']);
  const r = P.pickScale(c, P.detectPaper(1684, 1191));    // A2
  assert.equal(r.pick, null);
  assert.equal(r.reason, 'paper-mismatch');
  assert.match(r.msg, /兩點校正/);
});

test('同一紙張標了兩個不同比例 → 不猜', () => {
  const c = P.collectScales(['A1圖:1:100', 'A1圖:1:50']);
  const r = P.pickScale(c, P.detectPaper(2384, 1684));
  assert.equal(r.pick, null);
  assert.equal(r.reason, 'conflict');
});

test('沒有紙張前綴且有多個比例 → 不猜', () => {
  const r = P.pickScale(P.collectScales(['1:100', '1:20']), P.detectPaper(2384, 1684));
  assert.equal(r.pick, null);
  assert.equal(r.reason, 'ambiguous');
});

test('找不到比例就說找不到', () => {
  const r = P.pickScale(P.collectScales(['某某建築師事務所']), P.detectPaper(2384, 1684));
  assert.equal(r.pick, null);
  assert.equal(r.reason, 'none');
});

/* ── 換算 ── */

test('1:N 之下 1pt 等於幾公尺', () => {
  assert.ok(Math.abs(P.metersPerPoint(100) - 0.0352778) < 1e-6);
  assert.ok(Math.abs(P.metersPerPoint(10) - 0.00352778) < 1e-7);
  assert.equal(P.metersPerPoint(0), null);
  assert.equal(P.metersPerPoint(-5), null);
});

/* ── 真實圖 ── */

test('真實施工圖：A1 精確吻合、挑中 1:100', () => {
  const r = P.analyze(REAL.wPt, REAL.hPt, REAL.texts);
  assert.equal(r.paper.name, 'A1');
  assert.equal(r.exact, true);
  assert.equal(r.ratio, 100);
  assert.equal(r.usable, true);
  assert.ok(Math.abs(r.metersPerPoint - 0.0352778) < 1e-6);
  assert.ok(r.evidence.some((e) => /沒有被縮放過/.test(e.msg)));
});

test('被縮放過的 PDF：找得到比例但不可直接套用', () => {
  const r = P.analyze(REAL.wPt * 0.96, REAL.hPt * 0.96, REAL.texts);
  assert.equal(r.exact, false);
  assert.equal(r.usable, false, '不精確就不能直接用');
  assert.ok(r.evidence.some((e) => e.level === 'warn' && /縮放/.test(e.msg)));
});

test('NTS 圖不可量測', () => {
  const r = P.analyze(REAL.wPt, REAL.hPt, ['A1圖:1:100', 'DETAIL NTS']);
  assert.equal(r.collected.nts, true);
  assert.equal(r.usable, false);
  assert.ok(r.evidence.some((e) => e.level === 'bad'));
});

/* ── 這個功能為什麼危險：一張圖有多個比例 ── */

test('圖框比例只適用主要視圖 —— 大樣有自己的比例', () => {
  // 真實圖實測：SECTION A-A 的 600mm 尺寸線在紙上 59.97mm
  const paperMm = 59.97;
  const localRatio = 600 / paperMm;
  assert.ok(Math.abs(localRatio - 10) < 0.05, `實際 1:${localRatio.toFixed(2)}`);

  // 若誤用圖框的 1:100 去量那條線
  const wrong = (paperMm / 25.4 * 72) * P.metersPerPoint(100);
  assert.ok(Math.abs(wrong - 5.997) < 0.01, `會得到 ${wrong.toFixed(3)} M`);
  assert.ok(wrong / 0.6 > 9.9, '錯 10 倍');
});

/* ────────── NO SCALE：真實標單圖上最常見的寫法 ────────── */

test('認得各種「不按比例」寫法，NO SCALE 尤其不能漏', () => {
  const nts = (s) => P.findScales(s).some((x) => x.nts);
  // 這一組是真實標單圖上會出現的（空軍那份七張全部寫 NO SCALE）
  assert.ok(nts('NO SCALE'), 'NO SCALE 是最常見的寫法，第一版漏掉了');
  assert.ok(nts('NOSCALE'));
  assert.ok(nts('NO-SCALE'));
  assert.ok(nts('比例尺 NO SCALE'));
  assert.ok(nts('SCALE: NONE'));
  assert.ok(nts('SCALE:N/A'));
  assert.ok(nts('NTS'));
  assert.ok(nts('N.T.S.'));
  assert.ok(nts('不按比例'));
  assert.ok(nts('不依比例'));
  assert.ok(nts('非按比例'));
  assert.ok(nts('無比例尺'));
});

test('不把正常比例誤判成「不按比例」', () => {
  const nts = (s) => P.findScales(s).some((x) => x.nts);
  for (const s of ['1:100', 'A1圖:1:100', 'SCALE 1:50', '比例 1/30', "f'c=280kg/cm2", '#3@150', 'SCALE BAR']) {
    assert.ok(!nts(s), `${s} 不該被判成不按比例`);
  }
});

test('圖框寫 NO SCALE → 整份判定不可用', () => {
  const r = P.analyze(1191, 842, ['SCALE', 'NO SCALE', 'UNIT CM']);
  assert.equal(r.paper.name, 'A3');
  assert.equal(r.nts, true);
  assert.equal(r.usable, false, '不按比例的圖不能量');
  assert.ok(r.evidence.some((e) => e.level === 'bad'));
});

/* ────────── 掃描圖：讀不到 ≠ 沒有 ────────── */

test('純掃描頁判定：零文字、零向量、只有一張影像', () => {
  // 這組繪圖指令是真實標單圖七頁每一頁的實際內容
  const r = P.classifyPage({
    textCount: 0,
    ops: { transform: 2, save: 1, dependency: 1, paintImageXObject: 1, restore: 1 },
    imageWidth: 4960, widthPt: 1191,
  });
  assert.equal(r.kind, 'scan');
  assert.equal(r.measurable, false);
  assert.equal(Math.round(r.dpi), 300, '影像像素 ÷ 紙張英吋 = 掃描解析度');
  assert.equal(r.reasons[0].level, 'bad');
  assert.match(r.reasons[0].msg, /純掃描圖/);
  assert.match(r.reasons[0].msg, /300 dpi/);
});

test('向量頁不得被誤判為掃描', () => {
  const r = P.classifyPage({ textCount: 5, ops: { constructPath: 800, stroke: 600, transform: 40 } });
  assert.equal(r.kind, 'vector');
  assert.equal(r.measurable, true);
  assert.deepEqual(r.reasons, []);
});

test('掃描底圖上疊向量標註 → mixed，且要提醒底圖未必按比例', () => {
  const r = P.classifyPage({ textCount: 12, ops: { paintImageXObject: 1, constructPath: 40, stroke: 30 } });
  assert.equal(r.kind, 'mixed');
  assert.equal(r.measurable, true);
  assert.match(r.reasons[0].msg, /不代表底圖是按比例/);
});

test('空白頁回 empty，不假裝是別的', () => {
  assert.equal(P.classifyPage({ textCount: 0, ops: {} }).kind, 'empty');
  assert.equal(P.classifyPage({}).kind, 'empty');
});

test('掃描圖：「讀不到比例」與「沒有比例」要分開講', () => {
  const r = P.analyze(1191, 842, [], {
    textCount: 0, ops: { transform: 2, save: 1, paintImageXObject: 1, restore: 1 },
  });
  assert.equal(r.scan, true);
  assert.equal(r.usable, false);
  assert.equal(r.nts, false, '沒讀到 NTS 不等於不是 NTS');
  const hint = r.evidence.find((e) => e.kind === 'scan-noscale');
  assert.ok(hint, '必須明說「讀不到文字所以判斷不了，請人眼確認」');
  assert.match(hint.msg, /NO SCALE/);
  assert.match(hint.msg, /人眼確認/);
});

test('掃描圖的紙張規格仍判得出來 —— 那跟讀不讀得到文字無關', () => {
  const r = P.analyze(1191, 842, [], { textCount: 0, ops: { paintImageXObject: 1 } });
  assert.equal(r.paper.name, 'A3');
  assert.equal(r.exact, true);
  assert.ok(r.evidence.some((e) => e.kind === 'paper' && e.level === 'ok'));
});
