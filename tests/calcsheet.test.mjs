/** 圖面計算式解析與驗算的回歸測試。基準案例是使用者提供的真實計算式表。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as CS from '../public/js/takeoff/calcsheet.js';
import * as DXF from '../public/js/takeoff/dxf.js';

async function realSheet() {
  const raw = await readFile(new URL('./fixture-calcsheet.dxf', import.meta.url), 'utf8');
  const texts = DXF.flatten(DXF.parseDxf(raw))
    .filter((e) => e.type === 'TEXT')
    .map((e) => ({ text: e.text, x: e.pt.x, y: e.pt.y, height: e.h }));
  return { texts, sheet: CS.parseSheet(texts) };
}

/* ── 安全：絕不用 eval ── */

test('算式求值不碰 eval —— 任何非算術字元一律拒絕', () => {
  for (const evil of [
    'constructor', 'process.exit(1)', '1;alert(1)', 'require("fs")',
    '(()=>1)()', '__proto__', '1**2', 'globalThis',
  ]) {
    const r = CS.evaluate(evil);
    assert.ok(r.error, `「${evil}」必須被拒絕，實際回傳 ${JSON.stringify(r)}`);
  }
});

test('括號不全、除以零、多餘內容都會被抓出來而不是靜默算錯', () => {
  assert.match(CS.evaluate('(1+2').error, /括號/);
  assert.match(CS.evaluate('1/0').error, /除以零/);
  assert.match(CS.evaluate('1+2 3').error, /多餘/);
  assert.match(CS.evaluate('1..2+3').error, /數字格式/);
  assert.match(CS.evaluate('').error, /沒有可計算/);
});

test('正確的算式照四則運算優先順序求值', () => {
  assert.equal(CS.evaluate('1+2*3').value, 7);
  assert.equal(CS.evaluate('(1+2)*3').value, 9);
  assert.equal(CS.evaluate('-2*3').value, -6);
  assert.equal(CS.evaluate('10-2-3').value, 5);
  assert.equal(CS.evaluate('24.565*20.80-62.33-40.39-11.22').value.toFixed(3), '397.012');
});

/* ── 字元正規化 ── */

test('全形運算子、各種減號與乘號都要正規化', () => {
  assert.equal(CS.normalize('１．４５×３．５２５＋１．８×２．６０'), '1.45*3.525+1.8*2.60');
  assert.equal(CS.evaluate('2.60×3.90').value.toFixed(2), '10.14');
  for (const dash of ['-', '−', '–', '—', '－']) {
    assert.equal(CS.evaluate(`10${dash}3`).value, 7, `減號 ${dash} 沒被正規化`);
  }
});

test('單位正規化', () => {
  assert.equal(CS.normUnit('m2'), 'M2');
  assert.equal(CS.normUnit('㎡'), 'M2');
  assert.equal(CS.normUnit('平方公尺'), 'M2');
  assert.equal(CS.normUnit('m3'), 'M3');
  assert.equal(CS.normUnit(''), null);
});

/* ── 圈號 ── */

test('圈號轉成穩定的鍵', () => {
  assert.equal(CS.markKey('ⓐ'), 'a');
  assert.equal(CS.markKey('ⓚ'), 'k');
  assert.equal(CS.markKey('Ⓑ'), 'B');
  assert.equal(CS.markKey('③'), '3');
  assert.equal(CS.markKey('x'), null);
  assert.deepEqual(CS.marksIn('ⓗ ⓘ ⓙ'), ['h', 'i', 'j']);
  assert.deepEqual(CS.marksIn('(a) (3)'), ['a', '3']);
});

/* ── 單列解析 ── */

test('三種寫法都吃得下：純算式、帶標籤、只宣告數值', () => {
  const plain = CS.parseExpression('1.45*3.525+1.8*2.60=9.79m2');
  assert.equal(plain.expr, '1.45*3.525+1.8*2.60');
  assert.equal(plain.stated, 9.79);
  assert.equal(plain.unit, 'M2');
  assert.equal(plain.decimals, 2);
  assert.equal(plain.declared, false);

  // 標籤是亂碼的中文，且標籤本身帶 =
  const labelled = CS.parseExpression('???????=720.96+788.08=1509.04m2');
  assert.equal(labelled.expr, '720.96+788.08');
  assert.equal(labelled.stated, 1509.04);
  assert.equal(labelled.prefix, '???????=');

  const decl = CS.parseExpression('??????????=1509.04m2');
  assert.equal(decl.declared, true);
  assert.equal(decl.stated, 1509.04);
  assert.equal(decl.computed, null);

  assert.equal(CS.parseExpression('一般文字沒有等號'), null);
});

test('四捨五入不是錯誤：9.79125 寫成 9.79 要判定為正確', () => {
  const sheet = { rows: [CS.parseExpression('1.45*3.525+1.8*2.60=9.79m2')], declared: [] };
  sheet.rows[0].refs = [];
  const v = CS.verify(sheet);
  assert.equal(v.counts.failed, 0);
  assert.equal(v.rows[0].ok, true);
  assert.ok(Math.abs(v.rows[0].computed - 9.79125) < 1e-9, '原值仍保留完整精度');
});

/* ── 真實基準案例：一個誤報都不能有 ── */

test('使用者提供的真實計算式表：14 式全部驗算通過，零誤報', async () => {
  const { sheet } = await realSheet();
  const v = CS.verify(sheet);
  assert.equal(v.counts.rows, 14, '應解析出 14 個計算式');
  assert.equal(v.counts.failed, 0, '不得有任何算錯');
  assert.equal(v.counts.bad, 0, `不得有任何嚴重問題：${v.issues.filter((i) => i.level === 'bad').map((i) => i.msg).join(' / ')}`);
  assert.equal(v.ok, true);
});

test('大面積扣除法不得被誤判為重複計算', async () => {
  const { sheet } = await realSheet();
  const v = CS.verify(sheet);
  // ⓚ 扣掉 ⓗⓘⓙ，合計又把 ⓗⓘⓙ 各自加回 —— 這是正確做法
  const k = v.rows.find((r) => r.mark === 'k');
  assert.ok(k && k.ok);
  assert.deepEqual(k.refs, ['h', 'i', 'j']);
  const sum = v.rows.find((r) => r.isTotal && Math.abs(r.stated - 720.96) < 0.01);
  assert.ok(sum, '應找到 720.96 的合計列');
  assert.ok(sum.ok);
  assert.ok(!v.issues.some((i) => /重複/.test(i.msg)));
});

test('階層合計（總計加小計）不得被誤判為孤項', async () => {
  const { sheet } = await realSheet();
  const v = CS.verify(sheet);
  const grand = CS.grandTotal(sheet);
  assert.equal(grand.stated, 1509.04);
  // 720.96 與 788.08 都要對得到來源
  assert.ok(!v.issues.some((i) => i.kind === 'sumItem' && Math.abs(i.value - 720.96) < 0.01));
  assert.ok(!v.issues.some((i) => i.kind === 'sumItem' && Math.abs(i.value - 788.08) < 0.01));
});

test('被裁掉的 ⓐ 會以「參照不存在」與「合計有孤項」如實回報，而不是安靜略過', async () => {
  const { sheet } = await realSheet();
  const v = CS.verify(sheet);
  assert.ok(v.issues.some((i) => i.kind === 'refMiss' && /a/.test(i.msg)), '應指出參照的 a 列不存在');
  assert.ok(v.issues.some((i) => i.kind === 'sumItem' && Math.abs(i.value - 46.53) < 0.01), '應指出 46.53 沒有出處');
  assert.ok(v.issues.every((i) => i.level !== 'bad'), '缺一列是警告不是致命錯誤');
});

test('圖上宣告的總面積由另外兩處佐證', async () => {
  const { sheet } = await realSheet();
  const v = CS.verify(sheet);
  assert.equal(v.declared.length, 1);
  assert.equal(v.declared[0].stated, 1509.04);
  assert.equal(v.declared[0].confirmedBy, 2);
});

/* ── 真的抓得到錯 ── */

test('算錯抓得出來，而且兩個數字都列出來不代為修正', async () => {
  const { texts } = await realSheet();
  const broken = texts.map((t) => (t.text.startsWith('8.58*7.265')
    ? { ...t, text: '8.58*7.265=62.53m2' } : t));          // 62.33 → 62.53
  const v = CS.verify(CS.parseSheet(broken));
  const hit = v.issues.find((i) => i.kind === 'arith');
  assert.ok(hit, '必須抓到算錯');
  assert.equal(hit.level, 'bad');
  assert.ok(/62\.33/.test(hit.msg) && /62\.53/.test(hit.msg), '重算值與圖上值都要出現：' + hit.msg);
  assert.equal(v.ok, false);
});

test('交叉參照過期抓得出來（改了 ⓗ 但 ⓚ 沒同步）', async () => {
  const { texts } = await realSheet();
  // ⓗ 改成 70.00，但 ⓚ 仍扣 62.33
  const broken = texts.map((t) => (t.text.startsWith('8.58*7.265')
    ? { ...t, text: '9.63*7.265=69.96m2' } : t));
  const v = CS.verify(CS.parseSheet(broken));
  const hit = v.issues.find((i) => i.kind === 'ref' && i.ref === 'h');
  assert.ok(hit, '必須抓到 ⓚ 參照 ⓗ 已過期');
  assert.equal(hit.level, 'bad');
  assert.equal(hit.expected, 69.96);
});

test('合計漏加一項抓得出來', async () => {
  const { texts } = await realSheet();
  const broken = texts.map((t) => (t.text.startsWith('46.53+9.79')
    ? { ...t, text: '46.53+9.79+9.63+10.14+13.46+60.23+60.23+62.33+40.39+11.22=323.95m2' } : t));
  const v = CS.verify(CS.parseSheet(broken));
  // 合計本身算對（323.95 確實等於那些數字相加），但少了 ⓚ 的 397.01
  const sum = v.rows.find((r) => Math.abs(r.stated - 323.95) < 0.01);
  assert.ok(sum && sum.ok, '算式本身沒錯');
  assert.ok(sum.coverage.matched < 11, '涵蓋率應反映漏項');
});

test('圖上宣告的總數與算出來的總計不符時判為嚴重問題', async () => {
  const { texts } = await realSheet();
  const broken = texts.map((t) => (t.text.includes('??????????=1509.04')
    ? { ...t, text: '??????????=1520.00m2' } : t));
  const v = CS.verify(CS.parseSheet(broken));
  const hit = v.issues.find((i) => i.kind === 'declared');
  assert.ok(hit, '必須抓到宣告值不符');
  assert.equal(hit.level, 'bad');
  assert.equal(hit.declaredValue, 1520);
  assert.equal(hit.computedTotal, 1509.04);
});

test('看不懂的算式標為「看不懂」而不是當成 0', async () => {
  const { texts } = await realSheet();
  const broken = texts.map((t) => (t.text.startsWith('2.60*3.90')
    ? { ...t, text: '2.60*(3.90=10.14m2' } : t));
  const v = CS.verify(CS.parseSheet(broken));
  const hit = v.issues.find((i) => i.kind === 'parse');
  assert.ok(hit, '必須回報無法解析');
  assert.equal(hit.level, 'warn');
});

/* ── 亂碼 ── */

test('缺 SHX 字型造成的中文亂碼要偵測並回報，不能假裝讀懂了', async () => {
  const { sheet } = await realSheet();
  assert.ok(sheet.mojibake.ratio > 0.3, `亂碼比例 ${sheet.mojibake.ratio}`);
  assert.ok(CS.isMojibake('?????'));
  assert.ok(CS.isMojibake('A???'));
  assert.ok(!CS.isMojibake('走廊面積'));
  assert.ok(!CS.isMojibake('1.45*3.525=9.79m2'));
  assert.ok(!CS.isMojibake('?'), '單一問號可能是真的問號，不算亂碼');
});

test('中文亂碼不影響算式解析 —— 數字與運算子不受字型影響', async () => {
  const { sheet } = await realSheet();
  const v = CS.verify(sheet);
  assert.equal(v.counts.failed, 0);
  assert.ok(sheet.rows.every((r) => r.expr && r.stated > 0));
});

/* ── 分列 ── */

test('依 Y 座標分列，同列依 X 排序', () => {
  const rows = CS.groupRows([
    { text: 'B', x: 20, y: 100, height: 2 },
    { text: 'A', x: 5, y: 100.3, height: 2 },
    { text: 'C', x: 5, y: 95, height: 2 },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].cells.map((c) => c.text).join(''), 'AB');
  assert.equal(rows[1].cells[0].text, 'C');
});

/* ── 與幾何量交叉比對 ── */

test('計算式與幾何量相符／不符都要有明確結論', () => {
  const agree = CS.crossCheck(1509.04, 1500, 0.05);
  assert.equal(agree.agree, true);
  assert.match(agree.verdict, /相符/);

  const clash = CS.crossCheck(1509.04, 1200, 0.05);
  assert.equal(clash.agree, false);
  assert.match(clash.verdict, /必有一錯/);
  assert.ok(clash.rate > 0.25);

  assert.equal(CS.crossCheck(100, 0), null, '除以零要回 null 不是 Infinity');
  assert.equal(CS.crossCheck(null, 100), null);
});
