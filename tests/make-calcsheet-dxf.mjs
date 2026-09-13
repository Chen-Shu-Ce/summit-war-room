/**
 * 產生 tests/fixture-calcsheet.dxf —— 重現使用者附件的計算式表格。
 * 中文標註刻意寫成 "?"，重現缺 SHX 大字型時的亂碼實況。
 */
import { writeFile } from 'node:fs/promises';

const H = 2.2;                 // 字高
const ROW = 5.0;               // 列距
const X_MARK = 4, X_NAME = 8, X_EXPR = 40;

// [圈號, 名稱(亂碼), 算式, 上方參照標記]
const ROWS = [
  ['ⓐ', '??',      '46.53',                                 null],   // 上方被裁掉，只給結果
  ['ⓑ', '??',      '1.45*3.525+1.8*2.60=9.79m2',            null],
  ['ⓒ', '???',     '1.85*3.90+1.15*2.10=9.63m2',            null],
  ['ⓓ', '???',     '2.60*3.90=10.14m2',                     null],
  ['ⓔ', '??????',  '3.45*3.90=13.46m2',                     null],
  ['ⓕ', 'A???',    '8.29*7.265=60.23m2',                    null],
  ['ⓖ', 'B???',    '8.29*7.265=60.23m2',                    null],
  ['ⓗ', '???',     '8.58*7.265=62.33m2',                    null],
  ['ⓘ', '???',     '5.56*7.265=40.39m2',                    null],
  ['ⓙ', '?????',   '1.785*5.565+1.785*0.72=11.22m2',        null],
  ['ⓚ', '????',    '24.565*20.80-62.33-40.39-11.22=397.01m2', 'ⓗ ⓘ ⓙ'],
  ['',   '??',     '46.53+9.79+9.63+10.14+13.46+60.23+60.23+62.33+40.39+11.22+397.01=720.96m2', null],
  ['ⓛ', '??',      '47.985*20.80-46.53-9.79-9.63-10.14-13.46-60.23-60.23=788.08m2', 'ⓐ ⓑ ⓒ ⓓ ⓔ ⓕ ⓖ'],
];

let handle = 0x200;
const ents = [];
function text(s, x, y, layer = 'TEXT', h = H) {
  if (!s) return;
  ents.push([
    '0', 'TEXT', '5', (handle++).toString(16).toUpperCase(), '100', 'AcDbEntity',
    '8', layer, '100', 'AcDbText',
    '10', x.toFixed(4), '20', y.toFixed(4), '30', '0.0',
    '40', h.toFixed(4), '1', s, '100', 'AcDbText',
  ].join('\n'));
}

let y = 100;
for (const [mark, name, expr, refs] of ROWS) {
  if (refs) text(refs, X_EXPR + 12, y + H * 1.1, 'REF', H * 0.8);   // 參照標記在算式上方
  text(mark, X_MARK, y, 'MARK');
  text(name, X_NAME, y, 'NAME');
  text(expr, X_EXPR, y, 'CALC');
  y -= ROW;
}
y -= ROW;
text('??????????=1509.04m2', X_MARK, y, 'CALC'); y -= ROW * 0.8;
text('?????(102)????  00055?', X_MARK, y, 'NOTE'); y -= ROW * 0.8;
text('???????=720.96+788.08=1509.04m2', X_MARK, y, 'CALC'); y -= ROW * 0.8;
text('?????????=720.96+788.08=1509.04m2', X_MARK, y, 'CALC');

const dxf = [
  '0', 'SECTION', '2', 'HEADER',
  '9', '$INSUNITS', '70', '6',
  '0', 'ENDSEC',
  '0', 'SECTION', '2', 'ENTITIES',
  ents.join('\n'),
  '0', 'ENDSEC', '0', 'EOF', '',
].join('\n');

await writeFile(new URL('./fixture-calcsheet.dxf', import.meta.url), dxf, 'utf8');
console.log('wrote fixture-calcsheet.dxf —', ents.length, 'text entities');
