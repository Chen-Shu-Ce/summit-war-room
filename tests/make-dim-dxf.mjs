/**
 * 產生兩張帶 DIMENSION 標註的 DXF，用來驗證「圖面標註 vs 幾何」這條檢查。
 *
 * fixture-dim-ok.dxf   標註與幾何一致 —— 圖檔單位與比例可信
 * fixture-dim-bad.dxf  重現兩種真實錯誤：
 *   1. 整張圖的標註都比幾何大 1000 倍
 *      （$INSUNITS 宣告公厘，圖其實畫在公尺上 —— 就是那張地籍圖的情形）
 *   2. 一個標註文字被手動覆寫（幾何 560，圖上印 600）
 *      這是最危險的一種：人看圖相信文字，程式量測相信幾何，兩邊永遠對不起來。
 */
import { writeFileSync } from 'node:fs';

function build({ dims, lines, insunits = 4, max = 10000 }) {
  const L = [];
  const p = (c, v) => { L.push(String(c), String(v)); };
  p(0, 'SECTION'); p(2, 'HEADER');
  p(9, '$INSUNITS'); p(70, insunits);
  p(9, '$EXTMIN'); p(10, 0); p(20, 0);
  p(9, '$EXTMAX'); p(10, max); p(20, max);
  p(0, 'ENDSEC');
  p(0, 'SECTION'); p(2, 'TABLES'); p(0, 'TABLE'); p(2, 'LAYER');
  for (const [n, c] of [['E-TRAY', 1], ['A-DIM', 2]]) { p(0, 'LAYER'); p(2, n); p(70, 0); p(62, c); }
  p(0, 'ENDTAB'); p(0, 'ENDSEC');
  p(0, 'SECTION'); p(2, 'ENTITIES');
  for (const [x1, y1, x2, y2] of lines) {
    p(0, 'LINE'); p(8, 'E-TRAY'); p(10, x1); p(20, y1); p(11, x2); p(21, y2);
  }
  // group 42 = CAD 自己量到的值；group 1 = 圖上印出來的字
  for (const [measured, text, x, y] of dims) {
    p(0, 'DIMENSION'); p(8, 'A-DIM'); p(10, x); p(20, y); p(42, measured); p(1, text);
  }
  p(0, 'ENDSEC'); p(0, 'EOF');
  return L.join('\r\n') + '\r\n';
}

// 一致：幾何就是 5000／3000／1200，標註也寫一樣
writeFileSync(new URL('./fixture-dim-ok.dxf', import.meta.url), build({
  insunits: 4, max: 10000,
  lines: [[0, 0, 5000, 0], [0, 1000, 3000, 1000], [0, 2000, 1200, 2000]],
  dims: [[5000, '5000', 2500, 100], [3000, '3000', 1500, 1100], [1200, '1200', 600, 2100]],
}), 'latin1');

// 錯誤：四個標註差 1000 倍（單位錯），另一個被手動覆寫
writeFileSync(new URL('./fixture-dim-bad.dxf', import.meta.url), build({
  insunits: 4, max: 20,
  lines: [[0, 0, 5, 0], [0, 1, 3, 1], [0, 2, 1.2, 2], [0, 3, 0.6, 3], [0, 4, 0.56, 4]],
  dims: [
    [5, '5000', 2.5, 0.1], [3, '3000', 1.5, 1.1], [1.2, '1200', 0.6, 2.1], [0.6, '600', 0.3, 3.1],
    [0.56, '600', 0.28, 4.1],     // 覆寫：幾何 0.56（= 560mm）卻印 600
  ],
}), 'latin1');

console.log('wrote fixture-dim-ok.dxf（標註與幾何一致）/ fixture-dim-bad.dxf（4 個差 1000 倍 + 1 個覆寫）');
