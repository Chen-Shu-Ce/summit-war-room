/** DXF 文字編碼偵測、MTEXT 控制碼、單位換算的回歸測試。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as ENC from '../public/js/takeoff/encoding.js';
import * as U from '../public/js/takeoff/units.js';
import * as DXF from '../public/js/takeoff/dxf.js';
import * as CS from '../public/js/takeoff/calcsheet.js';

const fx = (name) => readFile(new URL(`./fixture-${name}.dxf`, import.meta.url));

/* ────────── 這就是那一整排 ???? 的真正成因 ────────── */

test('把 Big5 的 DXF 當 UTF-8 解，每個中文字都會變成 U+FFFD', async () => {
  const buf = await fx('big5');
  const wrong = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  assert.ok((wrong.match(/�/g) || []).length > 50, '這正是畫面上那一整排問號的來源');
  assert.ok(!wrong.includes('走廊'), '中文已經毀掉，不是顯示不出來而是不存在了');

  const right = ENC.decodeDxf(buf);
  assert.equal(right.encoding, 'big5');
  assert.equal(right.bad, 0);
  assert.ok(right.text.includes('走廊') && right.text.includes('無障礙廁所'));
});

test('依 $DWGCODEPAGE 解碼：ANSI_950 → Big5、ANSI_936 → GBK', async () => {
  const b = ENC.decodeDxf(await fx('big5'));
  assert.equal(b.codepage, 'ANSI_950');
  assert.equal(b.encoding, 'big5');
  assert.equal(b.from, 'codepage');
  assert.equal(b.confident, true);

  const g = ENC.decodeDxf(await fx('gbk'));
  assert.equal(g.codepage, 'ANSI_936');
  assert.equal(g.encoding, 'gbk');
  assert.ok(g.text.includes('走廊'));           // 走廊（簡體同形）
});

test('R2007 以後一律 UTF-8，檔頭宣告的 codepage 不作數', async () => {
  const r = ENC.decodeDxf(await fx('utf8'));
  assert.equal(r.acadver, 'AC1021');
  assert.equal(r.codepage, 'ANSI_950', '檔頭確實寫著 ANSI_950');
  assert.equal(r.encoding, 'utf-8', '但 R2007 以後要忽略它');
  assert.equal(r.from, 'acadver');
  assert.ok(r.text.includes('走廊'));
});

test('檔頭說謊時要推翻它 —— 零個替代字元不等於解對了', async () => {
  const r = ENC.decodeDxf(await fx('badcp'));
  assert.equal(r.codepage, 'ANSI_1252', '檔頭謊稱 Latin-1');
  assert.equal(r.encoding, 'big5', '但內容是 Big5，必須推翻');
  assert.equal(r.from, 'guess-after-bad-codepage');
  assert.equal(r.confident, false, '推翻檔頭是推測，不能宣稱有把握');
  assert.ok(r.text.includes('走廊'));
  // windows-1252 把 Big5 解成 ¤¤¤å：一個 U+FFFD 都沒有，但完全是垃圾
  const latin = r.tried.find((t) => t.encoding === 'windows-1252');
  assert.equal(latin.bad, 0, '單位元組編碼不會產生替代字元');
  assert.ok(latin.latin > 20, '但會產生大量高位拉丁字元連串 —— 那才是指紋');
  assert.ok(latin.score < 0);
});

test('全 ASCII 的檔案不該跳編碼警告 —— 每種候選解出來都一樣', async () => {
  const r = ENC.decodeDxf(Buffer.from('0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n', 'ascii'));
  assert.equal(r.from, 'ascii');
  assert.equal(r.confident, true);
  assert.equal(r.pureAscii, true);
  assert.deepEqual(r.tried, []);
});

test('評分：獎勵連續漢字而非漢字總數，否則 Shift-JIS 會靠半形片假名勝出', async () => {
  const buf = await fx('big5');
  const r = ENC.decodeDxf(buf);
  const byEnc = Object.fromEntries(r.tried.map((t) => [t.encoding, t]));
  assert.ok(byEnc.big5.score > byEnc.shift_jis.score, 'Big5 必須贏過 Shift-JIS');
  assert.ok(byEnc.shift_jis.kana > 0, 'Shift-JIS 誤解的指紋是半形片假名');
  assert.ok(byEnc.big5.runIdeo > 40, '正確解碼會出現大量連續漢字');
});

test('分數以連續漢字為主，孤字不足以取勝', () => {
  const real = ENC.scoreText('走廊面積 儲藏室 會議室 無障礙廁所');
  const noise = ENC.scoreText('中ｱｲ文ｳｴ測ｵｶ');
  assert.ok(real.runIdeo > 0 && real.isolated === 0);
  assert.ok(real.score > noise.score);
  assert.ok(noise.kana > 0);
});

/* ────────── MTEXT 控制碼 ────────── */

test('MTEXT 的字型、字高、群組括號都要剝掉', () => {
  assert.equal(ENC.decodeMText('{\\fMSungGBK|b0|i0|c136|p2;\\H1.2x;鋼筋混凝土}'), '鋼筋混凝土');
  assert.equal(ENC.decodeMText('\\W0.8;\\A1;走廊'), '走廊');
  assert.equal(ENC.decodeMText('第一行\\P第二行'), '第一行\n第二行');
  assert.equal(ENC.decodeMText('\\U+4E2D\\U+6587'), '中文');
  assert.equal(ENC.decodeMText('%%c100 %%d45 %%p5'), 'Ø100 °45 ±5');
  assert.equal(ENC.decodeMText('純文字'), '純文字');
  assert.equal(ENC.decodeMText(''), '');
});

test('跳脫過的括號要保留，不能當成群組括號吃掉', () => {
  assert.equal(ENC.decodeMText('A\\{B\\}C'), 'A{B}C');
  assert.equal(ENC.decodeMText('{A}'), 'A');
});

test('解碼錯誤與缺字型是兩種不同的現象，各有各的偵測', () => {
  assert.ok(ENC.looksMisdecoded('����走廊'), 'U+FFFD 是解碼錯誤');
  assert.ok(!ENC.looksMisdecoded('走廊面積'));
  assert.ok(CS.isMojibake('?????'), '問號是缺字型');
  assert.ok(!ENC.looksMisdecoded('?????'), '缺字型不會被誤判成解碼錯誤');
});

/* ────────── 解碼修好之後，計算式表才真的可用 ────────── */

test('四種編碼的同一張表，都解出 14 式全對、總計 1509.04', async () => {
  for (const name of ['big5', 'gbk', 'badcp', 'utf8']) {
    const dec = ENC.decodeDxf(await fx(name));
    const texts = DXF.flatten(DXF.parseDxf(dec.text))
      .filter((e) => e.type === 'TEXT')
      .map((e) => ({ text: e.text, x: e.pt.x, y: e.pt.y, height: e.h }));
    const sheet = CS.parseSheet(texts);
    const v = CS.verify(sheet);
    assert.equal(v.counts.rows, 14, `${name}: 應有 14 式`);
    assert.equal(v.counts.failed, 0, `${name}: 不得有算錯`);
    assert.equal(v.counts.bad, 0, `${name}: ${v.issues.map((i) => i.msg).join(' / ')}`);
    assert.equal(CS.grandTotal(sheet).stated, 1509.04, `${name}: 總計`);
  }
});

test('Big5 字集沒有圈號字元，所以列號寫成全形括號也要認得', async () => {
  const dec = ENC.decodeDxf(await fx('big5'));
  const texts = DXF.flatten(DXF.parseDxf(dec.text)).filter((e) => e.type === 'TEXT')
    .map((e) => ({ text: e.text, x: e.pt.x, y: e.pt.y, height: e.h }));
  const sheet = CS.parseSheet(texts);
  const marks = sheet.rows.map((r) => r.mark).filter(Boolean);
  assert.ok(marks.includes('k') && marks.includes('l'), marks.join(','));
  const k = sheet.rows.find((r) => r.mark === 'k');
  assert.deepEqual(k.refs, ['h', 'i', 'j'], '全形括號的交叉參照也要追得到');
  assert.equal(k.name, '大廳', '中文名稱要讀得出來');
});

test('圈圈畫成幾何、圈裡只放裸字母時，也要認得列號', () => {
  const rows = CS.parseSheet([
    { text: 'a', x: 0, y: 10, height: 2 },
    { text: '走廊', x: 5, y: 10, height: 2 },
    { text: '2.0*3.0=6.00m2', x: 20, y: 10, height: 2 },
  ]);
  assert.equal(rows.rows[0].mark, 'a');
  assert.equal(rows.rows[0].name, '走廊');
});

test('註記裡的 t=15cm 不是數量宣告，不得拿去對總面積', async () => {
  const dec = ENC.decodeDxf(await fx('big5'));
  assert.ok(dec.text.includes('t=15cm'), '這張圖確實有這行註記');
  const texts = DXF.flatten(DXF.parseDxf(dec.text)).filter((e) => e.type === 'TEXT')
    .map((e) => ({ text: e.text, x: e.pt.x, y: e.pt.y, height: e.h }));
  const v = CS.verify(CS.parseSheet(texts));
  assert.equal(v.counts.bad, 0);
  assert.ok(!v.issues.some((i) => /15/.test(i.msg)), '版厚註記不該產生宣告值警告');
});

/* ────────── 四捨五入：完全相等，不再另給容差 ────────── */

test('四捨五入到圖上位數後要求完全相等', () => {
  assert.equal(CS.roundHalfUp(13.454999999999998, 2), 13.46, '二進位表示誤差要先修掉');
  assert.equal(CS.roundHalfUp(9.79125, 2), 9.79);
  assert.equal(CS.roundHalfUp(60.22685, 2), 60.23);
  assert.equal(CS.roundHalfUp(2.5, 0), 3, '半進位，不是四捨六入五成雙');
  assert.equal(CS.roundHalfUp(-2.5, 0), -3);

  assert.ok(CS.equalAt(9.79125, 9.79, 2), '進位後相等 → 通過');
  assert.ok(CS.equalAt(3.45 * 3.90, 13.46, 2), '13.455 進位成 13.46');
  assert.ok(!CS.equalAt(9.795, 9.79, 2), '進位成 9.80，與 9.79 不相等 → 不通過');
  assert.ok(!CS.equalAt(9.80, 9.79, 2));
});

test('進位後只差一個最小位就算錯，不給任何額外容差', () => {
  const sheet = { rows: [CS.parseExpression('8.58*7.265=62.34m2')], declared: [] };
  sheet.rows[0].refs = [];
  const v = CS.verify(sheet);
  assert.equal(v.rows[0].ok, false, '重算是 62.33，圖上寫 62.34 → 不相等');
  assert.equal(v.counts.bad, 1);
  assert.match(v.issues[0].msg, /62\.33/);
  assert.match(v.issues[0].msg, /62\.34/);
  assert.match(v.issues[0].msg, /未進位前/);
});

/* ────────── 單位換算 ────────── */

test('同維度自動換算', () => {
  assert.equal(U.convert(1, 'M2', 'M2').value, 1);
  assert.equal(Math.round(U.convert(456.5, '坪', 'M2').value * 100) / 100, 1509.09);
  assert.equal(Math.round(U.convert(3.3057851, 'M2', '坪').value * 1e6) / 1e6, 1);
  assert.equal(U.convert(150, 'CM', 'M').value, 1.5);
  assert.equal(U.convert(2.5, 'T', 'KG').value, 2500);
  assert.equal(U.convert(1000, 'L', 'M3').value, 1);
  assert.equal(Math.round(U.convert(1, '台尺', 'M').value * 1e6) / 1e6, 0.30303);
});

test('㎡ ㎥ 平方公尺 坪 等寫法都要正規化到同一個鍵', () => {
  for (const u of ['m2', 'M2', 'm²', '㎡', '平方公尺', 'sqm']) {
    assert.equal(U.normalize(u), 'M2', u);
  }
  for (const u of ['m3', '㎥', '立方公尺', 'CUM']) assert.equal(U.normalize(u), 'M3', u);
  assert.equal(U.normalize('公噸'), 'T');
  assert.equal(U.normalize('吋'), 'IN');
  assert.equal(U.normalize('不存在的單位'), null, '認不得就回 null，不亂猜');
});

test('跨維度不自動換算，而是說出缺哪一個量', () => {
  const r = U.convert(1509.04, 'M2', 'M');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'need-bridge');
  assert.equal(r.bridge.need, '寬度');
  assert.equal(r.bridge.unit, 'M');
  assert.match(r.msg, /面積除以寬度才是長度/);
});

test('補上寬度後才換算，並記下怎麼換的', () => {
  const r = U.convert(1509.04, 'M2', 'M', { bridge: 0.5 });
  assert.equal(r.ok, true);
  assert.equal(Math.round(r.value * 100) / 100, 3018.08);
  assert.match(r.how, /除以寬度 0\.5/);

  const v = U.convert(100, 'M2', 'M3', { bridge: 0.15 });
  assert.equal(Math.round(v.value * 100) / 100, 15, '面積乘厚度才是體積');
});

test('計數單位不與任何東西互換', () => {
  const a = U.convert(5, '只', '組');
  assert.equal(a.ok, false);
  assert.equal(a.reason, 'count');
  assert.match(a.msg, /規格問題/);

  const b = U.convert(10, 'M2', '樘');
  assert.equal(b.ok, false);
  assert.equal(b.reason, 'count');
  assert.match(b.msg, /計數單位/);
  assert.match(b.msg, /面積單位/);
});

test('質量與長度之間沒有通用換算（單位重隨材質而異）', () => {
  const r = U.convert(100, 'KG', 'M');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'incompatible');
  assert.match(r.msg, /質量.*長度|長度.*質量/);
});

test('換算係數採法定值', () => {
  assert.equal(U.dimOf('坪'), 'A');
  assert.equal(U.dimOf('台尺'), 'L');
  assert.ok(Math.abs(U.UNITS['坪'].toBase - 3.3057851) < 1e-6, '1 坪 = (60/33)² ㎡');
  assert.ok(Math.abs(U.UNITS['台尺'].toBase - 10 / 33) < 1e-12, '1 台尺 = 10/33 公尺');
});

/* ────────── 名稱比對（編碼修好之後才做得到） ────────── */

test('名稱對得上才建議，對不上就說對不上', async () => {
  const wbs = JSON.parse(await readFile(new URL('../public/data/wbs-template.json', import.meta.url), 'utf8'));
  const rows = [
    { name: '抛光石英磚', unit: 'M2', stated: 1509.04, decimals: 2 },
    { name: '礦纖天花板', unit: '坪', stated: 456.5, decimals: 1 },
    { name: '完全無關的東西', unit: 'M2', stated: 10, decimals: 0 },
  ];
  const ms = CS.matchItems(rows, wbs.items);
  assert.equal(ms[0].match.code, '230.01');
  assert.equal(ms[0].score, 1);
  assert.equal(ms[1].match.code, '210.01');
  assert.equal(Math.round(ms[1].convert.value * 100) / 100, 1509.09, '坪自動換成 M2');
  assert.equal(ms[2].match, null, '對不上就不要硬湊');
});

test('計算式表列的是空間、BOM 列的是材料，對不上是正常的', async () => {
  const wbs = JSON.parse(await readFile(new URL('../public/data/wbs-template.json', import.meta.url), 'utf8'));
  const dec = ENC.decodeDxf(await fx('big5'));
  const texts = DXF.flatten(DXF.parseDxf(dec.text)).filter((e) => e.type === 'TEXT')
    .map((e) => ({ text: e.text, x: e.pt.x, y: e.pt.y, height: e.h }));
  const sheet = CS.parseSheet(texts);
  const ms = CS.matchItems(sheet.rows.filter((r) => r.name && !r.isTotal), wbs.items);
  assert.ok(ms.length > 0, '有名稱可比對');
  assert.equal(ms.filter((m) => m.match).length, 0,
    '玄關、會議室是空間，不是 BOM 材料 —— 一個都不該硬配');
});
