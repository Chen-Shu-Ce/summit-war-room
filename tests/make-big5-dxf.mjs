/**
 * 產生 tests/fixture-big5.dxf —— 真正的 Big5 位元組編碼（$DWGCODEPAGE = ANSI_950）。
 *
 * 這是使用者附件的實況版本：同一張計算式表，但中文是真的中文，
 * 以 Big5 寫入檔案。用 UTF-8 解它，每個中文字都會變成 U+FFFD。
 *
 * 另外產生 fixture-gbk.dxf（GBK，檔頭宣告 ANSI_936）與
 * fixture-badcp.dxf（內容是 Big5 但檔頭謊稱 ANSI_1252 —— 轉檔工具常見的情形）。
 */
import { writeFile } from 'node:fs/promises';
import { encode } from './lib-encode.mjs';

const H = 2.2, ROW = 5.0;
const X_MARK = 4, X_NAME = 8, X_EXPR = 40;

// [列號, 中文名稱, 算式, 上方參照]
// Big5 字集裡沒有 ⓐ ① ㈠ 這些圈號字元 —— 真實圖面因此用全形括號 （a），
// 或把圈圈畫成 CIRCLE 幾何、圈裡放一個裸字母。面積單位則常用 Big5 有的 ㎡。
const ROWS = [
  ['（a）', '玄關', '2.85*3.90+1.10*2.40=13.76㎡', null],
  ['（b）', '走廊', '1.45*3.525+1.8*2.60=9.79㎡', null],
  ['（c）', '儲藏室', '1.85*3.90+1.15*2.10=9.63㎡', null],
  ['（d）', '機房', '2.60*3.90=10.14㎡', null],
  ['（e）', '電氣室', '3.45*3.90=13.46㎡', null],
  ['（f）', 'A棟辦公', '8.29*7.265=60.23㎡', null],
  ['（g）', 'B棟辦公', '8.29*7.265=60.23㎡', null],
  ['（h）', '會議室', '8.58*7.265=62.33㎡', null],
  ['（i）', '茶水間', '5.56*7.265=40.39㎡', null],
  ['（j）', '無障礙廁所', '1.785*5.565+1.785*0.72=11.22㎡', null],
  ['（k）', '大廳', '24.565*20.80-62.33-40.39-11.22=397.01㎡', '（h）（i）（j）'],
  ['', '小計', '13.76+9.79+9.63+10.14+13.46+60.23+60.23+62.33+40.39+11.22+397.01=688.19㎡', null],
  ['（l）', '二樓', '47.985*20.80-13.76-9.79-9.63-10.14-13.46-60.23-60.23=820.85㎡',
    '（a）（b）（c）（d）（e）（f）（g）'],
];

function build(codepage, acadver) {
  let handle = 0x200;
  const ents = [];
  const text = (s, x, y, layer, h = H) => {
    if (!s) return;
    ents.push(['0', 'TEXT', '5', (handle++).toString(16).toUpperCase(), '100', 'AcDbEntity',
      '8', layer, '100', 'AcDbText',
      '10', x.toFixed(4), '20', y.toFixed(4), '30', '0.0',
      '40', h.toFixed(4), '1', s, '100', 'AcDbText'].join('\n'));
  };
  let y = 100;
  for (const [mark, name, expr, refs] of ROWS) {
    if (refs) text(refs, X_EXPR + 12, y + H * 1.1, 'REF', H * 0.8);
    text(mark, X_MARK, y, 'MARK');
    text(name, X_NAME, y, 'NAME');
    text(expr, X_EXPR, y, 'CALC');
    y -= ROW;
  }
  y -= ROW;
  text('總樓地板面積=1509.04㎡', X_MARK, y, 'CALC'); y -= ROW * 0.8;
  text('合計=688.19+820.85=1509.04㎡', X_MARK, y, 'CALC'); y -= ROW * 0.8;
  // MTEXT 排版碼：字型、字高與 Unicode 跳脫混在一起
  text('{\\fMSungGBK|b0|i0|c136|p2;\\H1.2x;鋼筋混凝土樓版 t=15cm}', X_MARK, y, 'NOTE');

  return ['0', 'SECTION', '2', 'HEADER',
    '9', '$ACADVER', '1', acadver,
    '9', '$DWGCODEPAGE', '3', codepage,
    '9', '$INSUNITS', '70', '6',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    ents.join('\n'),
    '0', 'ENDSEC', '0', 'EOF', ''].join('\n');
}

const base = new URL('.', import.meta.url);
// 真 Big5、檔頭誠實
await writeFile(new URL('./fixture-big5.dxf', base), encode(build('ANSI_950', 'AC1015'), 'big5'));
// 真 GBK、檔頭誠實
await writeFile(new URL('./fixture-gbk.dxf', base), encode(build('ANSI_936', 'AC1015'), 'gbk'));
// 真 Big5、但檔頭謊稱是 Latin-1（轉檔工具常見）
await writeFile(new URL('./fixture-badcp.dxf', base), encode(build('ANSI_1252', 'AC1015'), 'big5'));
// R2007 之後：UTF-8，檔頭宣告的 codepage 應被忽略
await writeFile(new URL('./fixture-utf8.dxf', base), Buffer.from(build('ANSI_950', 'AC1021'), 'utf8'));
console.log('wrote fixture-big5.dxf / fixture-gbk.dxf / fixture-badcp.dxf / fixture-utf8.dxf');
