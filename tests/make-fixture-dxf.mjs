/** 產生一個幾何量已知的 DXF 測試檔，用來驗證解析器與長度/面積演算法。 */
import { writeFileSync } from 'node:fs';

const L = [];
const p = (c, v) => { L.push(String(c), String(v)); };

p(0, 'SECTION'); p(2, 'HEADER');
p(9, '$INSUNITS'); p(70, 4);
p(9, '$EXTMIN'); p(10, 0); p(20, 0);
p(9, '$EXTMAX'); p(10, 10000); p(20, 10000);
p(0, 'ENDSEC');

p(0, 'SECTION'); p(2, 'TABLES');
p(0, 'TABLE'); p(2, 'LAYER');
for (const [n, c] of [['E-CABLE-PWR', 1], ['S-FORM', 3], ['E-LITE', 5]]) { p(0, 'LAYER'); p(2, n); p(70, 0); p(62, c); }
p(0, 'ENDTAB'); p(0, 'ENDSEC');

p(0, 'SECTION'); p(2, 'BLOCKS');
p(0, 'BLOCK'); p(2, 'LUM-150W'); p(10, 0); p(20, 0);
p(0, 'LINE'); p(8, 'E-LITE'); p(10, 0); p(20, 0); p(11, 100); p(21, 0);
p(0, 'ENDBLK');
p(0, 'ENDSEC');

p(0, 'SECTION'); p(2, 'ENTITIES');
// 1) LINE 3-4-5 → 5000
p(0, 'LINE'); p(8, 'E-CABLE-PWR'); p(10, 0); p(20, 0); p(11, 3000); p(21, 4000);
// 2) 封閉矩形 1000×2000 → 周長 6000、面積 2,000,000
p(0, 'LWPOLYLINE'); p(8, 'S-FORM'); p(90, 4); p(70, 1);
p(10, 0); p(20, 0); p(10, 1000); p(20, 0); p(10, 1000); p(20, 2000); p(10, 0); p(20, 2000);
// 3) 圓 r=500
p(0, 'CIRCLE'); p(8, 'S-FORM'); p(10, 5000); p(20, 5000); p(40, 500);
// 4) 弧 r=1000, 0°→90°
p(0, 'ARC'); p(8, 'E-CABLE-PWR'); p(10, 8000); p(20, 0); p(40, 1000); p(50, 0); p(51, 90);
// 5) bulge 半圓：兩點距 2000、bulge=1 → 弧長 π·1000
p(0, 'LWPOLYLINE'); p(8, 'E-CABLE-PWR'); p(90, 2); p(70, 0);
p(10, 0); p(20, 9000); p(42, 1); p(10, 2000); p(20, 9000);
// 6) 4 個圖塊插入（含 2×1 陣列）→ 計數 4、展開長度 400
p(0, 'INSERT'); p(2, 'LUM-150W'); p(8, 'E-LITE'); p(10, 100); p(20, 100);
p(0, 'INSERT'); p(2, 'LUM-150W'); p(8, 'E-LITE'); p(10, 300); p(20, 100);
p(0, 'INSERT'); p(2, 'LUM-150W'); p(8, 'E-LITE'); p(10, 500); p(20, 100); p(70, 2); p(44, 200);
p(0, 'ENDSEC');
p(0, 'EOF');

writeFileSync(new URL('./fixture.dxf', import.meta.url), L.join('\r\n') + '\r\n');
console.log('fixture.dxf written', L.length / 2, 'pairs');
