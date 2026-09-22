/**
 * 產生 tests/fixture-dupe.dxf —— 重現「重複描繪」這件事。
 *
 * 使用者說這比任何自動化都優先，理由是它會靜默地把數量翻倍：
 * 對應猜錯了數字會不合理而被發現，重複描繪不會，它給你一個完全合理、
 * 但是錯一倍的數字。
 *
 * 這張圖裡的重複都是手算得出來的：
 *
 *   E-TRAY（電纜架層）
 *     線 A：(0,0)–(10000,0)              長 10000
 *     線 B：(10000,0)–(0,0)              長 10000，反向重合 → 重複 10000
 *     線 C：(0,3000)–(5000,3000)         長 5000
 *     線 D：(3000,3000)–(8000,3000)      長 5000，部分重疊 2000
 *     總長 30000、聯集 18000、重複 12000（40%）→ 判定 bad，擋下
 *
 *   E-LIGHT-HB（燈具層）
 *     三個 LUM 圖塊，其中兩個插在同一點 → 多算 1 只
 *     計數被灌水，一個就是一個 → 判定 bad，擋下
 *
 *   E-WIRE（乾淨層）
 *     兩條首尾相接的線，總長 9000、零重複 → 不擋
 *     首尾相接是正常畫法，誤報會讓人學會忽略警告
 */
import { writeFileSync } from 'node:fs';

const L = [];
const p = (c, v) => { L.push(String(c), String(v)); };

p(0, 'SECTION'); p(2, 'HEADER');
p(9, '$INSUNITS'); p(70, 4);                 // 4 = 公厘
p(9, '$EXTMIN'); p(10, 0); p(20, 0);
p(9, '$EXTMAX'); p(10, 12000); p(20, 6000);
p(0, 'ENDSEC');

p(0, 'SECTION'); p(2, 'TABLES');
p(0, 'TABLE'); p(2, 'LAYER');
for (const [n, c] of [['E-TRAY', 1], ['E-LIGHT-HB', 5], ['E-WIRE', 3]]) {
  p(0, 'LAYER'); p(2, n); p(70, 0); p(62, c);
}
p(0, 'ENDTAB'); p(0, 'ENDSEC');

p(0, 'SECTION'); p(2, 'BLOCKS');
p(0, 'BLOCK'); p(2, 'LUM-150W'); p(10, 0); p(20, 0);
p(0, 'LINE'); p(8, 'E-LIGHT-HB'); p(10, 0); p(20, 0); p(11, 100); p(21, 0);
p(0, 'ENDBLK');
p(0, 'ENDSEC');

p(0, 'SECTION'); p(2, 'ENTITIES');
// E-TRAY：反向重合 10000 + 部分重疊 2000
p(0, 'LINE'); p(8, 'E-TRAY'); p(10, 0); p(20, 0); p(11, 10000); p(21, 0);
p(0, 'LINE'); p(8, 'E-TRAY'); p(10, 10000); p(20, 0); p(11, 0); p(21, 0);
p(0, 'LINE'); p(8, 'E-TRAY'); p(10, 0); p(20, 3000); p(11, 5000); p(21, 3000);
p(0, 'LINE'); p(8, 'E-TRAY'); p(10, 3000); p(20, 3000); p(11, 8000); p(21, 3000);
// E-LIGHT-HB：兩個圖塊疊在同一點
p(0, 'INSERT'); p(2, 'LUM-150W'); p(8, 'E-LIGHT-HB'); p(10, 1000); p(20, 5000);
p(0, 'INSERT'); p(2, 'LUM-150W'); p(8, 'E-LIGHT-HB'); p(10, 1000); p(20, 5000);
p(0, 'INSERT'); p(2, 'LUM-150W'); p(8, 'E-LIGHT-HB'); p(10, 3000); p(20, 5000);
// E-WIRE：乾淨，首尾相接
p(0, 'LINE'); p(8, 'E-WIRE'); p(10, 0); p(20, 1500); p(11, 5000); p(21, 1500);
p(0, 'LINE'); p(8, 'E-WIRE'); p(10, 5000); p(20, 1500); p(11, 9000); p(21, 1500);
p(0, 'ENDSEC');
p(0, 'EOF');

writeFileSync(new URL('./fixture-dupe.dxf', import.meta.url), L.join('\r\n') + '\r\n', 'latin1');
console.log('wrote fixture-dupe.dxf —— E-TRAY 重複 12M/30M、E-LIGHT-HB 多 1 只、E-WIRE 乾淨');
