/**
 * 產生 tests/fixture-tm2.dxf —— 重現真實地籍圖暴露出來的兩個問題。
 *
 * 刻意**不使用**使用者提供的真實地籍圖：那是他們的地號與產權資料，
 * 提交進 git repo 等於公開。這裡用合成資料重現同樣的條件：
 *
 *   1. 內容畫在 TWD97 TM2 測量座標上（E≈260,500、N≈2,737,500），單位是公尺，
 *      但 $INSUNITS 宣告成公厘（4）—— 照宣告算會小一千倍。
 *   2. 圖例與指北針畫在原點旁 ±30，與內容相距 26 萬單位 ——
 *      對全部實體取外框會得到毫無意義的跨距，自動全覽完全失效。
 *
 * 另外產生 fixture-tm2-ok.dxf：同樣的內容，但 $INSUNITS 正確宣告為公尺（6），
 * 用來確認檢查不會對正常圖檔誤報。
 */
import { writeFile } from 'node:fs/promises';

const E0 = 260400, N0 = 2737400;      // TM2 原點（公尺）
const W = 217.7, H = 207.0;           // 地塊實際大小（公尺）

function build(insunits) {
  let handle = 0x300;
  const ents = [];
  const push = (lines) => ents.push(lines.join('\n'));
  const head = (type, layer) => ['0', type, '5', (handle++).toString(16).toUpperCase(),
    '100', 'AcDbEntity', '8', layer];

  const line = (x1, y1, x2, y2, layer) => push([...head('LINE', layer), '100', 'AcDbLine',
    '10', x1.toFixed(4), '20', y1.toFixed(4), '30', '0.0',
    '11', x2.toFixed(4), '21', y2.toFixed(4), '31', '0.0']);
  const text = (s, x, y, layer, h = 3) => push([...head('TEXT', layer), '100', 'AcDbText',
    '10', x.toFixed(4), '20', y.toFixed(4), '30', '0.0', '40', h.toFixed(4), '1', s]);

  // ── 地籍內容：畫在 TM2 座標上 ──
  // 地界線：一圈封閉多邊形（周長剛好 400 M，方便驗算）
  const p = [[0, 0], [120, 0], [120, 80], [0, 80]];
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    line(E0 + a[0], N0 + a[1], E0 + b[0], N0 + b[1], 'L - 地界線');
  }
  // 建築線：三段，合計 363 M
  line(E0 + 10, N0 + 10, E0 + 160, N0 + 10, 'L - 建築線');
  line(E0 + 160, N0 + 10, E0 + 160, N0 + 133, 'L - 建築線');
  line(E0 + 160, N0 + 133, E0 + 70, N0 + 133, 'L - 建築線');
  // 座標格網：6 條 × 200 M = 1200 M
  for (let i = 0; i <= 2; i++) {
    line(E0 + i * 100, N0, E0 + i * 100, N0 + 200, 'NE_GRID');
    line(E0, N0 + i * 100, E0 + 200, N0 + i * 100, 'NE_GRID');
  }
  // 地號與格網標註
  for (const [n, dx, dy] of [['1267', 30, 30], ['1268', 80, 30], ['2-13', 30, 60], ['1006-2', 80, 60]]) {
    text(n, E0 + dx, N0 + dy, 'T - 地籍');
  }
  text('E260400', E0, N0 - 8, 'NE_GRID', 2);
  text('N2737400', E0 - 20, N0, 'NE_GRID', 2);
  text('地界線', E0 + W * 0.6, N0 + 40, 'T - 地籍');
  text('建築線', E0 + W * 0.5, N0 + 20, 'T - 地籍');

  // ── 圖例與指北針：畫在原點旁 ──
  text('北', 0, 25, 'LEGEND', 4);
  line(0, 0, 0, 20, 'LEGEND');
  line(-5, 15, 0, 20, 'LEGEND');
  line(5, 15, 0, 20, 'LEGEND');
  for (const [s, y] of [['圖例表', 30], ['圖根點', -10], ['導線點', -20], ['結構線', -30]]) {
    text(s, -30, y, 'LEGEND', 3);
  }
  line(-32, -32, 32, -32, 'LEGEND');
  line(-32, 32, 32, 32, 'LEGEND');

  return ['0', 'SECTION', '2', 'HEADER',
    '9', '$ACADVER', '1', 'AC1032',
    '9', '$DWGCODEPAGE', '3', 'ANSI_950',
    '9', '$INSUNITS', '70', String(insunits),
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    ents.join('\n'),
    '0', 'ENDSEC', '0', 'EOF', ''].join('\n');
}

const base = new URL('.', import.meta.url);
// $INSUNITS = 4（公厘）—— 錯的，重現真實圖檔的狀況
await writeFile(new URL('./fixture-tm2.dxf', base), Buffer.from(build(4), 'utf8'));
// $INSUNITS = 6（公尺）—— 對的，用來確認不會誤報
await writeFile(new URL('./fixture-tm2-ok.dxf', base), Buffer.from(build(6), 'utf8'));
console.log('wrote fixture-tm2.dxf（宣告公厘，實為公尺）/ fixture-tm2-ok.dxf（宣告正確）');
