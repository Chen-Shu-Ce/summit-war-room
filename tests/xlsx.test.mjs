/**
 * .xlsx 產生器的回歸測試。
 *
 * 起因是使用者按了匯出，畫面跳出「此物品不提供文件下載」—— 匯出等於是壞的。
 * 修法不是把 CSV 修好，是換成 .xlsx，理由寫在 xlsx.js 的檔頭：
 * CSV 沒有編碼欄位，繁體中文 Windows 的 Excel 會拿 Big5 去猜 UTF-8 的中文，
 * 中文就整片變亂碼；加 BOM 有時有效、有時被當成資料。.xlsx 內部是 UTF-8 的 XML，
 * 編碼寫在檔案裡，沒有猜測的餘地。
 *
 * 這裡測的是「產出的位元組真的是一個合法的活頁簿」，不是「函式有回傳東西」。
 * 所以測試自己解 ZIP、自己解 XML 結構，不靠任何套件。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as XL from '../public/js/takeoff/xlsx.js';
import { unzip } from './lib-zip.mjs';

/** 解開活頁簿，並用 xlsx.js 自己的 crc32 交叉驗證每個部件的內容。 */
const readZip = (bytes) => new Map(
  [...unzip(bytes, { crc32: XL.crc32 })].map(([k, v]) => [k, v.toString('utf8')]));

/** 粗略但夠用的 XML 良構檢查：標籤要成對。 */
function assertWellFormed(xml, label) {
  const stack = [];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[1]) assert.equal(stack.pop(), m[2], `${label}: </${m[2]}> 沒有對應的開始標籤`);
    else if (!m[4]) stack.push(m[2]);
  }
  assert.equal(stack.length, 0, `${label}: 未關閉的標籤 ${stack.join(',')}`);
}

const CJK = ['低壓電力電纜 XLPE', '600V 3C×38mm² CU/XLPE/PVC'];

/* ── CRC-32 ── */

test('crc32 對得上已知值', () => {
  const enc = new TextEncoder();
  // CRC-32/ISO-HDLC 的標準測試向量
  assert.equal(XL.crc32(enc.encode('')), 0x00000000);
  assert.equal(XL.crc32(enc.encode('123456789')), 0xcbf43926);
  assert.equal(XL.crc32(enc.encode('The quick brown fox jumps over the lazy dog')), 0x414fa339);
});

test('crc32 是 unsigned —— 不可以出現負數', () => {
  // 最高位是 1 的情況若用有號數寫進 ZIP 檔頭，整個壓縮檔就壞了
  for (const s of ['a', 'abc', '低壓電力電纜', 'x'.repeat(1000)]) {
    const v = XL.crc32(new TextEncoder().encode(s));
    assert.ok(v >= 0 && v <= 0xffffffff, `${s} 的 CRC ${v} 超出範圍`);
  }
});

/* ── 欄名 ── */

test('colName 在 Z→AA 的進位處正確', () => {
  assert.equal(XL.colName(0), 'A');
  assert.equal(XL.colName(25), 'Z');
  assert.equal(XL.colName(26), 'AA');
  assert.equal(XL.colName(51), 'AZ');
  assert.equal(XL.colName(52), 'BA');
  assert.equal(XL.colName(701), 'ZZ');
  assert.equal(XL.colName(702), 'AAA');
});

/* ── 工作表名稱 ── */

test('safeSheetName 砍到 31 字並去掉 Excel 不收的字元', () => {
  const n = XL.safeSheetName('採購包/電氣[主]', new Set());
  assert.ok(!/[:\\/?*[\]]/.test(n), `還有非法字元：${n}`);
  assert.equal(XL.safeSheetName('工'.repeat(50), new Set()).length, 31);
});

test('safeSheetName 重名會加序號 —— 否則活頁簿開不起來', () => {
  const used = new Set();
  const a = XL.safeSheetName('詢價單', used);
  const b = XL.safeSheetName('詢價單', used);
  const c = XL.safeSheetName('詢價單', used);
  assert.equal(a, '詢價單');
  assert.notEqual(b, a);
  assert.notEqual(c, a);
  assert.notEqual(c, b);
  assert.ok(b.length <= 31 && c.length <= 31);
});

test('safeSheetName 對空字串要給得出名字', () => {
  const n = XL.safeSheetName('', new Set());
  assert.ok(n.length > 0 && n.length <= 31);
});

/* ── 活頁簿結構 ── */

const SHEET = {
  name: '工程量清單',
  rows: [
    ['工項代碼', '名稱', '數量', '單價', '備註'],
    ['321.01', CJK[0], 1710, 168.5, CJK[1]],
    ['321.02', '接地銅barrel & <管>', 0, -3.25, '引號"測試"'],
  ],
};

test('build 產出的是一個合法 ZIP，且必要部件都在', () => {
  const files = readZip(XL.build([SHEET]));
  for (const need of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) {
    assert.ok(files.has(need), `缺少 ${need}`);
  }
});

test('每一個部件都是良構 XML 且宣告 UTF-8', () => {
  const files = readZip(XL.build([SHEET, { name: '第二張', rows: [['a'], ['b']] }]));
  for (const [name, xml] of files) {
    assert.ok(xml.startsWith('<?xml'), `${name} 少了 XML 宣告`);
    assert.ok(xml.includes('UTF-8'), `${name} 沒有宣告 UTF-8 —— 那就退回 CSV 的老問題了`);
    assertWellFormed(xml, name);
  }
});

test('中文原樣保留，不經任何碼頁轉換', () => {
  const files = readZip(XL.build([SHEET]));
  const s1 = files.get('xl/worksheets/sheet1.xml');
  for (const t of CJK) assert.ok(s1.includes(t), `工作表裡找不到「${t}」`);
  assert.ok(files.get('xl/workbook.xml').includes('工程量清單'));
});

test('數字存成數字、文字存成 inlineStr —— 存錯型別 Excel 就不能加總', () => {
  const s1 = readZip(XL.build([SHEET])).get('xl/worksheets/sheet1.xml');
  assert.match(s1, /<c r="C2"[^>]*><v>1710<\/v><\/c>/, '1710 應該是數值儲存格');
  assert.match(s1, /<c r="D2"[^>]*><v>168\.5<\/v><\/c>/);
  assert.match(s1, /<c r="D3"[^>]*><v>-3\.25<\/v><\/c>/, '負數要保留負號');
  assert.match(s1, /<c r="C3"[^>]*><v>0<\/v><\/c>/, '0 不可以被當成空值丟掉');
  assert.match(s1, /<c r="A2"[^>]*t="inlineStr"/, '「321.01」是代碼，留成文字才不會變成 321.01 這個數');
});

test('XML 特殊字元有跳脫，且跳脫後仍解得回原字串', () => {
  const s1 = readZip(XL.build([SHEET])).get('xl/worksheets/sheet1.xml');
  assert.ok(s1.includes('&amp;') && s1.includes('&lt;') && s1.includes('&gt;'));
  const m = s1.match(/<t[^>]*>([^<]*barrel[^<]*)<\/t>/);
  assert.ok(m, '找不到那一格');
  const back = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  assert.equal(back, '接地銅barrel & <管>');
});

test('控制字元被剝掉 —— 一個 0x07 就能讓 Excel 整份拒開', () => {
  const dirty = 'a' + String.fromCharCode(7) + 'b' + String.fromCharCode(0) + 'c';
  const keep = '保留' + String.fromCharCode(9) + '這個';
  const s1 = readZip(XL.build([{ name: 'x', rows: [['h'], [dirty], [keep]] }])).get('xl/worksheets/sheet1.xml');
  assert.ok(s1.includes('abc'), '非法控制字元應被移除而不是保留');
  for (let i = 0; i < 0x20; i++) {
    if (i === 0x09 || i === 0x0a || i === 0x0d) continue;
    assert.ok(!s1.includes(String.fromCharCode(i)), `XML 裡還有 0x${i.toString(16)}`);
  }
  assert.ok(s1.includes(String.fromCharCode(9)) && s1.includes('保留'), 'Tab 是 XML 合法字元，不該被剝掉');
});

test('第一列凍結、表頭套粗體樣式', () => {
  const files = readZip(XL.build([SHEET]));
  const s1 = files.get('xl/worksheets/sheet1.xml');
  assert.match(s1, /<pane[^>]*ySplit="1"/, '沒有凍結首列 —— 三百列的清單捲下去就不知道哪欄是哪欄');
  assert.match(s1, /<c r="A1"[^>]*s="1"/, '表頭沒有套樣式');
  assert.match(files.get('xl/styles.xml'), /<b\/>/, '樣式表裡沒有粗體字型');
});

test('多張工作表：編號、關聯、名稱三處要對得起來', () => {
  const sheets = [SHEET, { name: '採購包A', rows: [['x'], ['1']] }, { name: '採購包B', rows: [['y'], ['2']] }];
  const files = readZip(XL.build(sheets));
  const wb = files.get('xl/workbook.xml');
  const rels = files.get('xl/_rels/workbook.xml.rels');
  for (let i = 1; i <= 3; i++) {
    assert.ok(files.has(`xl/worksheets/sheet${i}.xml`), `缺 sheet${i}.xml`);
    assert.ok(wb.includes(`r:id="rId${i}"`), `workbook 少了 rId${i}`);
    assert.ok(rels.includes(`Id="rId${i}"`) && rels.includes(`worksheets/sheet${i}.xml`), `關聯少了 rId${i}`);
  }
  for (const s of sheets) assert.ok(wb.includes(s.name), `workbook 沒有 ${s.name}`);
  assert.ok(files.get('[Content_Types].xml').includes('/xl/worksheets/sheet3.xml'));
});

test('工作表名稱重複時 build 不會產生壞掉的活頁簿', () => {
  const files = readZip(XL.build([
    { name: '詢價單', rows: [['a'], ['1']] },
    { name: '詢價單', rows: [['b'], ['2']] },
  ]));
  const names = [...files.get('xl/workbook.xml').matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1]);
  assert.equal(names.length, 2);
  assert.equal(new Set(names).size, names.length, `工作表名稱重複：${names.join(',')}`);
});

test('不等長的列：短列不可以讓後面的欄位錯格', () => {
  const s1 = readZip(XL.build([{ name: 'x', rows: [['a', 'b', 'c'], ['1'], ['1', '2', '3', '4']] }]))
    .get('xl/worksheets/sheet1.xml');
  assert.match(s1, /<c r="D3"/, '最後一列有四格，第 4 欄應該存在');
  assert.ok(!/<c r="B2"/.test(s1), '第 2 列只有一格，不該憑空長出 B2');
});

test('空字串與 null 不佔格子，但不會讓右邊的欄位往左滑', () => {
  const s1 = readZip(XL.build([{ name: 'x', rows: [['h1', 'h2', 'h3'], ['a', '', 'c'], ['a', null, 'c']] }]))
    .get('xl/worksheets/sheet1.xml');
  assert.match(s1, /<c r="C2"/, '空字串在中間時，C 欄必須還在 C');
  assert.match(s1, /<c r="C3"/);
});

test('非有限數不可以寫成數值 —— NaN/Infinity 在 XML 裡是壞值', () => {
  const s1 = readZip(XL.build([{ name: 'x', rows: [['h'], [NaN], [Infinity], [-Infinity]] }]))
    .get('xl/worksheets/sheet1.xml');
  assert.ok(!/<v>NaN<\/v>/.test(s1), 'NaN 被寫成數值了');
  assert.ok(!/<v>-?Infinity<\/v>/.test(s1), 'Infinity 被寫成數值了');
});

test('大量資料不會爆掉，且列數正確', () => {
  const rows = [['代碼', '名稱', '數量']];
  for (let i = 0; i < 5000; i++) rows.push([`C${i}`, `工項${i}`, i * 1.5]);
  const files = readZip(XL.build([{ name: '大表', rows }]));
  const s1 = files.get('xl/worksheets/sheet1.xml');
  assert.equal([...s1.matchAll(/<row /g)].length, 5001);
  assert.ok(s1.includes('<v>7498.5</v>'), '最後一列的數值不見了');
});

/* ── 欄寬 ── */

test('autoWidths 把中文算成兩個字寬 —— 不然中文欄全部被截掉', () => {
  const w = XL.autoWidths([['名稱'], ['低壓電力電纜 XLPE'], ['abc']]);
  assert.equal(w.length, 1);
  const ascii = XL.autoWidths([['x'], ['abcdefghijklmnop']]);
  assert.ok(w[0] > ascii[0], `中文 ${w[0]} 應該比字數相近的英數 ${ascii[0]} 寬`);
});

test('autoWidths 有上下限，避免出現 3000 寬的欄', () => {
  const w = XL.autoWidths([['x'], ['字'.repeat(500)], ['a']], { min: 8, max: 46 });
  assert.ok(w[0] <= 46, `上限沒生效：${w[0]}`);
  assert.ok(XL.autoWidths([['a']])[0] >= 8, '下限沒生效');
});

test('欄寬有寫進工作表', () => {
  const s1 = readZip(XL.build([{ ...SHEET, widths: XL.autoWidths(SHEET.rows) }])).get('xl/worksheets/sheet1.xml');
  assert.match(s1, /<cols>/);
  assert.match(s1, /<col min="1" max="1" width="[\d.]+" customWidth="1"\/>/);
});

/* ── TSV 後備 ── */

test('toTsv 用 Tab 分欄，貼進 Excel 不經過編碼猜測', () => {
  const lines = XL.toTsv(SHEET.rows).split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0].split(String.fromCharCode(9)).length, 5);
  assert.ok(lines[1].includes(CJK[0]));
});

test('toTsv 必須把欄位裡的 Tab 與換行處理掉 —— 否則貼上會整個錯格', () => {
  const TAB = String.fromCharCode(9);
  const tsv = XL.toTsv([['a', 'b'], ['有' + TAB + 'Tab', '有\n換行']]);
  assert.equal(tsv.split('\n').length, 2, `換行沒處理：${JSON.stringify(tsv)}`);
  assert.equal(tsv.split('\n')[1].split(TAB).length, 2, 'Tab 沒處理，欄位數跑掉了');
});

/* ── 邊界 ── */

test('沒有工作表時要明確失敗，而不是寫出一個壞檔', () => {
  assert.throws(() => XL.build([]));
});

/* ══════════ 讀取（往返） ══════════ */

test('自己寫出去的活頁簿，自己讀得回來', async () => {
  const bytes = XL.build([
    { name: '甲表', rows: [['代碼', '名稱', '數量'], ['A-1', '電纜 38mm²', 100], ['A-2', '導管', 50]] },
    { name: '乙表', rows: [['合計'], [150]] },
  ]);
  const back = await XL.readWorkbook(bytes);
  assert.equal(back.length, 2);
  assert.equal(back[0].name, '甲表');
  assert.equal(back[0].rows[1][1], '電纜 38mm²', '中文與上標字元要原樣回來');
  assert.equal(back[0].rows[2][2], '50');
  assert.equal(back[1].name, '乙表');
});

test('空白儲存格讀回來是空字串，不是 undefined', async () => {
  const bytes = XL.build([{ name: 'S', rows: [['a', '', 'c'], ['', '', '']] }]);
  const back = await XL.readWorkbook(bytes);
  assert.equal(back[0].rows[0][1], '');
  assert.equal(back[0].rows[0][2], 'c');
});

test('XML 特殊字元不會壞掉', async () => {
  const bytes = XL.build([{ name: 'S', rows: [['<A & B> "引號" \'單引\'']] }]);
  const back = await XL.readWorkbook(bytes);
  assert.equal(back[0].rows[0][0], '<A & B> "引號" \'單引\'');
});

test('不是 ZIP 就明講，不會回一份空資料讓人以為讀成功了', async () => {
  await assert.rejects(() => XL.readWorkbook(new Uint8Array([1, 2, 3, 4])), /ZIP／xlsx/);
});
