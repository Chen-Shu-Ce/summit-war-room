/**
 * 座標合理性與測量座標系偵測的回歸測試。
 *
 * 這些案例全部來自一張真實的地籍圖（AutoCAD 2018 DWG，經 LibreDWG 轉 DXF）。
 * 測試用的是重現同樣條件的合成檔 —— 真實圖含地號與產權資訊，不應進版控。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as SV from '../public/js/takeoff/survey.js';
import * as DXF from '../public/js/takeoff/dxf.js';
import * as ENC from '../public/js/takeoff/encoding.js';

async function load(name) {
  const buf = await readFile(new URL(`./fixture-${name}.dxf`, import.meta.url));
  const doc = DXF.parseDxf(ENC.decodeDxf(buf).text);
  return { doc, flat: DXF.flatten(doc) };
}

/* ────────── 一維分群 ────────── */

test('分群：把相距很遠的兩群座標切開，依點數排序', () => {
  const v = [];
  for (let i = 0; i < 100; i++) v.push(260400 + i);       // 大群
  for (let i = 0; i < 10; i++) v.push(-30 + i);           // 小群
  const c = SV.cluster1d(v);
  assert.equal(c.length, 2);
  assert.equal(c[0].count, 100, '點數多的排前面');
  assert.ok(c[0].min >= 260400);
  assert.equal(c[1].count, 10);
});

test('分群：均勻分布的座標不該被切開', () => {
  const v = [];
  for (let i = 0; i < 200; i++) v.push(i * 1.3);
  assert.equal(SV.cluster1d(v).length, 1);
});

test('分群：邊界情形不爆炸', () => {
  assert.deepEqual(SV.cluster1d([]), []);
  assert.equal(SV.cluster1d([5])[0].count, 1);
  assert.equal(SV.cluster1d([1, 1, 1]).length, 1);
  assert.equal(SV.cluster1d([NaN, 1, 2, Infinity]).length, 1, '非有限值要濾掉');
});

/* ────────── 內容範圍 ────────── */

test('內容範圍取點數最多的那一群，並回報排除了幾點', async () => {
  const { flat } = await load('tm2');
  const b = SV.contentBounds(flat);
  assert.ok(Math.abs(b.width - 220) < 1, `寬 ${b.width}`);
  assert.ok(Math.abs(b.height - 208) < 1, `高 ${b.height}`);
  assert.equal(b.split, true, '應偵測到座標分成多群');
  assert.ok(b.excluded > 0, '離群的圖例點要被排除且回報');
  assert.ok(b.used > b.excluded);
  // 對全部實體取外框會得到 26 萬的跨距 —— 那正是要避免的
  const raw = DXF.bounds({ entities: flat, blocks: {} });
  assert.ok((raw.maxX - raw.minX) > 100000, '原始外框確實是壞的');
});

test('沒有離群點時不聲稱有分群', () => {
  const flat = [];
  for (let i = 0; i < 50; i++) flat.push({ type: 'LINE', layer: '0', pts: [{ x: i, y: 0 }, { x: i, y: 10 }] });
  const b = SV.contentBounds(flat);
  assert.equal(b.split, false);
  assert.equal(b.excluded, 0);
});

test('空圖回 null，不回一個假的範圍', () => {
  assert.equal(SV.contentBounds([]), null);
  assert.equal(SV.contentBounds(null), null);
});

/* ────────── TWD97 TM2 ────────── */

test('辨識 TWD97 TM2 座標範圍', () => {
  assert.ok(SV.looksLikeTM2({ minX: 260384, maxX: 260602, minY: 2737396, maxY: 2737603 }));
  assert.ok(!SV.looksLikeTM2({ minX: 0, maxX: 100, minY: 0, maxY: 100 }), '一般圖面座標不是 TM2');
  assert.ok(!SV.looksLikeTM2({ minX: 260384, maxX: 260602, minY: 0, maxY: 100 }), 'Y 不在範圍就不算');
  assert.ok(!SV.looksLikeTM2(null));
});

/* ────────── 單位合理性：這是會讓數量錯一千倍的那道檢查 ────────── */

test('宣告公厘但座標是 TM2 公尺 → 判定不合理並建議公尺', async () => {
  const { doc, flat } = await load('tm2');
  const chk = SV.checkUnits(doc, flat);
  assert.equal(chk.declared.name, '公厘');
  assert.equal(chk.tm2, true);
  assert.equal(chk.crs, SV.TM2.label);
  assert.equal(chk.ok, false);
  assert.deepEqual(chk.suggest, { name: '公尺', toM: 1 });
  const bad = chk.reasons.find((r) => r.level === 'bad');
  assert.ok(bad, '必須有一則嚴重警告');
  assert.match(bad.msg, /1,000 倍/);
  assert.match(bad.msg, /0\.2200 公尺/, '要把「照宣告會變成多小」直接算給人看');
});

test('宣告正確時不誤報單位問題', async () => {
  const { doc, flat } = await load('tm2-ok');
  const chk = SV.checkUnits(doc, flat);
  assert.equal(chk.declared.name, '公尺');
  assert.equal(chk.ok, true);
  assert.equal(chk.suggest, null);
  assert.equal(chk.reasons.filter((r) => r.level === 'bad').length, 0);
  // 但座標分群仍要照實回報 —— 那跟單位是兩回事
  assert.ok(chk.reasons.some((r) => r.kind === 'split'));
  assert.ok(chk.reasons.some((r) => r.kind === 'crs'));
});

test('非 TM2 的圖：跨距不合理時找出讓它合理的單位', () => {
  const doc = { units: { name: '公厘', toM: 0.001 } };
  // 一張跨距 50,000 單位的圖：當公厘只有 50 M（合理），不該報警
  const okFlat = [{ type: 'LINE', layer: '0', pts: [{ x: 0, y: 0 }, { x: 50000, y: 30000 }] }];
  assert.equal(SV.checkUnits(doc, okFlat).ok, true);

  // 跨距 50 單位：當公厘只有 0.05 M —— 不可能是一張營建圖
  const tiny = [{ type: 'LINE', layer: '0', pts: [{ x: 0, y: 0 }, { x: 50, y: 30 }] }];
  const chk = SV.checkUnits(doc, tiny);
  assert.equal(chk.ok, false);
  assert.ok(chk.candidates.some((u) => u.name === '公尺'));
  assert.match(chk.reasons[0].msg, /不在營建圖面的合理範圍/);
});

test('圖檔沒宣告單位時明說要人工指定，並列出可行選項', () => {
  const doc = { units: { name: '未定義', toM: null } };
  const flat = [{ type: 'LINE', layer: '0', pts: [{ x: 0, y: 0 }, { x: 120, y: 80 }] }];
  const chk = SV.checkUnits(doc, flat);
  assert.equal(chk.ok, false);
  assert.equal(chk.reasons[0].kind, 'no-unit');
  assert.ok(chk.candidates.length > 0);
});

test('工具只回報不自動改 —— 改單位會改變每一筆數量', async () => {
  const { doc, flat } = await load('tm2');
  const before = JSON.stringify(doc.units);
  SV.checkUnits(doc, flat);
  assert.equal(JSON.stringify(doc.units), before, 'checkUnits 不得有副作用');
});

/* ────────── 錯一千倍長什麼樣子 ────────── */

test('這道檢查擋掉的具體錯誤：建築線 363 M 會變成 0.363 M', async () => {
  const { doc } = await load('tm2');
  const agg = DXF.aggregateByLayer(doc);
  const bl = agg.find((g) => g.layer === 'L - 建築線');
  const dj = agg.find((g) => g.layer === 'L - 地界線');
  assert.ok(bl && dj);
  assert.ok(Math.abs(bl.length - 363) < 0.5, `建築線 ${bl.length}`);
  assert.ok(Math.abs(dj.length - 400) < 0.5, `地界線 ${dj.length}`);
  // 照宣告的公厘算
  assert.ok(Math.abs(bl.length * doc.units.toM - 0.363) < 1e-3, '照宣告會得到 0.363 M');
  // 建議的公尺
  const chk = SV.checkUnits(doc, DXF.flatten(doc));
  assert.ok(Math.abs(bl.length * chk.suggest.toM - 363) < 0.5, '改公尺才是 363 M');
});

test('地籍圖的地號不會被誤判成算式（2-13、1006-2 不是減法）', async () => {
  const { flat } = await load('tm2');
  const CS = await import('../public/js/takeoff/calcsheet.js');
  const texts = flat.filter((e) => e.type === 'TEXT')
    .map((e) => ({ text: e.text, x: e.pt.x, y: e.pt.y, height: e.h }));
  assert.ok(texts.some((t) => t.text === '2-13'), '這張圖確實有這種地號');
  assert.ok(texts.some((t) => t.text === '1006-2'));
  const sheet = CS.parseSheet(texts);
  assert.equal(sheet.rows.length, 0, '沒有計算式就該是 0，不能把地號當算式');
  assert.equal(sheet.declared.length, 0);
});

test('summarize 把結論壓成一句話', async () => {
  const { doc, flat } = await load('tm2');
  const s = SV.summarize(SV.checkUnits(doc, flat));
  assert.match(s, /TWD97 TM2/);
  assert.match(s, /1,000 倍/);
  assert.equal(SV.summarize(null), '');
});

test('兩群勢均力敵時不排除任何一群，而是回報分不出主體', () => {
  const flat = [];
  for (let i = 0; i < 50; i++) flat.push({ type: 'LINE', layer: '0', pts: [{ x: i, y: i }, { x: i + 1, y: i }] });
  for (let i = 0; i < 50; i++) flat.push({ type: 'LINE', layer: '0', pts: [{ x: 900000 + i, y: i }, { x: 900001 + i, y: i }] });
  const b = SV.contentBounds(flat);
  assert.equal(b.split, false, '五五分不該排除任何一群');
  assert.equal(b.ambiguous, true, '但要說出來');
  assert.equal(b.excluded, 0, '一個點都不能偷偷丟掉');
  assert.ok(b.width > 800000, '範圍照實回報，寧可太大也不少算');

  const chk = SV.checkUnits({ units: { name: '公尺', toM: 1 } }, flat);
  assert.ok(chk.reasons.some((r) => r.kind === 'ambiguous'));
  assert.ok(!chk.reasons.some((r) => r.kind === 'split'));
});

test('主群明顯佔多數且排除後大幅縮小，才排除離群點', () => {
  const flat = [];
  for (let i = 0; i < 200; i++) flat.push({ type: 'LINE', layer: '0', pts: [{ x: 260400 + i, y: 2737400 + i }, { x: 260401 + i, y: 2737400 + i }] });
  flat.push({ type: 'TEXT', layer: 'LEGEND', pt: { x: 0, y: 0 }, text: '北', h: 3 });
  const b = SV.contentBounds(flat);
  assert.equal(b.split, true);
  assert.ok(b.share > 0.9);
  assert.ok(b.shrink > 0.99);
  assert.equal(b.excluded, 1);
});
