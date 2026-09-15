/**
 * 圖號解析的測試。
 *
 * 這個模組的重點不是「猜得準」，是**猜不到就留白**。
 * 硬湊一個錯的圖號寫進請購單、發包單、驗收單，比留白嚴重得多 ——
 * 留白看得出來要補，錯的圖號看起來是對的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as SH from '../public/js/takeoff/sheet.js';

/* ── 切詞 ── */

test('去掉副檔名並依常見分隔符切開', () => {
  assert.deepEqual(SH.tokensOf('A0-1_電氣平面圖.dwg'), ['A0-1', '電氣平面圖']);
  assert.deepEqual(SH.tokensOf('E-01 三樓配電.pdf'), ['E-01', '三樓配電']);
  assert.deepEqual(SH.tokensOf('A0-1（最終版）.dxf'), ['A0-1', '最終版']);
});

test('沒有副檔名也切得動', () => {
  assert.deepEqual(SH.tokensOf('A0-1'), ['A0-1']);
});

/* ── 看得懂的圖號 ── */

test('英文專業別 + 數字：最常見的形式', () => {
  assert.equal(SH.parseSheetNo('A0-1.dwg').no, 'A0-1');
  assert.equal(SH.parseSheetNo('E-01_電氣平面.dwg').no, 'E01');
  assert.equal(SH.parseSheetNo('S201.dxf').no, 'S201');
  assert.equal(SH.parseSheetNo('M-3 空調.pdf').no, 'M3');
});

test('中文專業別也認得', () => {
  assert.equal(SH.parseSheetNo('電-01_三樓配電.dwg').no, '電01');
  assert.equal(SH.parseSheetNo('結05.dwg').no, '結05');
});

test('字母一律轉大寫，讓同一張圖不會因為大小寫變成兩張', () => {
  assert.equal(SH.parseSheetNo('a0-1.dwg').no, 'A0-1');
  assert.equal(SH.parseSheetNo('e-01.dwg').no, 'E01');
});

test('圖號在檔名開頭時最可信，並說明是怎麼推的', () => {
  const r = SH.parseSheetNo('A0-1_電氣平面圖.dwg');
  assert.equal(r.no, 'A0-1');
  assert.match(r.how, /檔名開頭/);
  assert.equal(r.token, 'A0-1');
});

test('圖號不在開頭時仍抓得到，但要是唯一的一個', () => {
  const r = SH.parseSheetNo('涌全工程_E-12_三樓電氣.dwg');
  assert.equal(r.no, 'E12');
  assert.match(r.how, /檔名中的一段/);
});

/* ── 猜不到就留白：這一組才是重點 ── */

test('檔名裡沒有像圖號的字樣 → 留白，並說明為什麼', () => {
  const r = SH.parseSheetNo('電氣平面圖.dwg');
  assert.equal(r.no, null);
  assert.match(r.why, /找不到/);
});

test('兩段都像圖號時寧可留白 —— 判斷不了就不要猜', () => {
  const r = SH.parseSheetNo('專案X_E-01_與_M-02_合併.dwg');
  assert.equal(r.no, null, `不該選任何一個，卻選了 ${r.no}`);
  assert.match(r.why, /都像圖號/);
});

test('純數字不是圖號 —— 那是序號', () => {
  assert.equal(SH.parseSheetNo('01.dwg').no, null);
  assert.equal(SH.parseSheetNo('001_平面圖.dwg').no, null);
});

test('四位數開頭是年份或日期，不是圖號', () => {
  assert.equal(SH.parseSheetNo('2024-01_電氣.dwg').no, null);
  assert.equal(SH.parseSheetNo('20260915_平面.dwg').no, null);
});

test('版本與狀態字樣不會被當成圖號', () => {
  for (const n of ['rev2.dwg', 'ver3_平面.dwg', 'final1.dwg', '最終版1.dwg']) {
    assert.equal(SH.parseSheetNo(n).no, null, n);
  }
});

test('擋版本字樣的代價：V-01（通風）也會被擋掉 —— 這是刻意選的方向', () => {
  // `v` 在版本字樣清單裡，所以 `V-01` 這種真圖號會被一起擋成留白。
  // 留白可以人工補，把版本號當成圖號寫進發包單沒人看得出來 —— 所以寧可錯殺。
  assert.equal(SH.parseSheetNo('V-01.dwg').no, null);
  // 人工填一律照收，所以這個代價有出口
  assert.equal(SH.sheetNoOf({ name: 'V-01.dwg', sheetNo: 'V-01' }), 'V-01');
});

test('數字太長不是圖號', () => {
  assert.equal(SH.parseSheetNo('E-12345.dwg').no, null);
});

test('空檔名不報錯', () => {
  assert.equal(SH.parseSheetNo('').no, null);
  assert.equal(SH.parseSheetNo(null).no, null);
  assert.equal(SH.parseSheetNo(undefined).no, null);
});

/* ── 人工填的優先 ── */

test('人工填的圖號永遠優先，不會被自動解析蓋掉', () => {
  assert.equal(SH.sheetNoOf({ name: 'A0-1_電氣.dwg', sheetNo: 'E-99' }), 'E-99');
  assert.equal(SH.sheetNoOf({ name: 'A0-1_電氣.dwg' }), 'A0-1');
});

test('人工填空白視同沒填，退回自動解析', () => {
  assert.equal(SH.sheetNoOf({ name: 'A0-1.dwg', sheetNo: '   ' }), 'A0-1');
});

test('人工填的不受解析規則限制 —— 使用者說是什麼就是什麼', () => {
  assert.equal(SH.sheetNoOf({ name: '平面圖.dwg', sheetNo: '第三冊-圖 12' }), '第三冊-圖 12');
});

test('沒有圖面時回 null', () => {
  assert.equal(SH.sheetNoOf(null), null);
});

/* ── 標籤 ── */

test('labelOf：有圖號用圖號，沒有退回檔名', () => {
  assert.equal(SH.labelOf({ name: 'A0-1_電氣.dwg' }), 'A0-1');
  assert.equal(SH.labelOf({ name: '電氣平面圖.dwg' }), '電氣平面圖.dwg');
  assert.equal(SH.labelOf(null), '');
});

/* ── 出處字串 ── */

test('出處同時給圖號與細節 —— 哪一張圖、那張圖上的哪裡', () => {
  const s = SH.provenanceLabel({ kind: 'dxf-layer', sheetNo: 'E-01', drawing: 'E-01_電氣.dwg', layer: 'E-CABLE' });
  assert.match(s, /E-01/);
  assert.match(s, /圖層 E-CABLE/);
});

test('圖號與檔名不同時，檔名放括號裡', () => {
  const s = SH.provenanceLabel({ kind: 'measure', sheetNo: 'A0-1', drawing: '建築平面.dwg', measurements: [1, 2] });
  assert.match(s, /A0-1（建築平面\.dwg）/);
  assert.match(s, /量測 2 筆/);
});

test('只有檔名沒有圖號時，就顯示檔名', () => {
  const s = SH.provenanceLabel({ kind: 'dxf-layer', drawing: '平面圖.dwg', layer: 'X' });
  assert.match(s, /平面圖\.dwg/);
});

test('PDF 量測會帶頁次', () => {
  const s = SH.provenanceLabel({ kind: 'measure', sheetNo: 'A0-1', drawing: 'a.pdf', page: 3, measurements: [1] });
  assert.match(s, /p\.3/);
});

test('沒有出處回空字串，不回 undefined', () => {
  assert.equal(SH.provenanceLabel(null), '');
  assert.equal(SH.provenanceLabel(undefined), '');
});

/* ── 匯出用的圖號欄 ── */

test('匯出的圖號欄只放圖號，不塞檔名充數', () => {
  assert.equal(SH.sheetCell({ sheetNo: 'A0-1', drawing: 'x.dwg' }), 'A0-1');
  assert.equal(SH.sheetCell({ drawing: '電氣平面圖.dwg' }), '', '推不出來就留白，不可以塞檔名');
});

test('舊資料沒記 sheetNo 時，退回用檔名推', () => {
  assert.equal(SH.sheetCell({ drawing: 'A0-1_電氣.dwg' }), 'A0-1');
});

test('沒有出處的工項，圖號欄是空的', () => {
  assert.equal(SH.sheetCell(null), '');
});
