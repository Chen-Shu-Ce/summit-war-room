/**
 * pdfscale.js — 從 PDF 圖框讀出宣告比例（純函式，無 DOM、無 I/O）
 *
 * 真實施工圖逼出來的：一張 φ60cm 基樁詳圖，pdf.js 只抽得到 5 條文字
 *（圖上的尺寸標註全被轉成曲線），但其中一條是圖框的比例欄：
 *
 *     "A3圖:1:200"    "A1圖:1:100"
 *
 * 而該頁是 2384 × 1684 pt = 841.0 × 594.0 mm —— **精確吻合 A1**。
 * 兩件事湊起來就能算出比例，使用者不必再去點兩個點做校正。
 *
 * 但宣告比例**不能直接當成事實**，理由有三：
 *   1. PDF 可能被縮放過（列印「符合頁面大小」、另存不同紙張）。
 *      紙張尺寸吻合標準規格的精確度，就是「有沒有被縮放」的證據。
 *   2. 同一張圖常同時標 A1 與 A3 兩種比例 —— 挑錯就差一倍。
 *   3. 圖框寫的是繪圖時的意圖，不保證等於這個檔案的實際幾何。
 *
 * 所以這裡輸出的是**帶著證據與可信度的候選**，由人確認；
 * 兩點校正仍然是權威方法，宣告比例只是省掉第一步。
 */

import * as Q from './quantity.js';

/** ISO 216 A 系列，單位公厘（長邊 × 短邊）。 */
export const PAPER = {
  A0: [1189, 841], A1: [841, 594], A2: [594, 420], A3: [420, 297], A4: [297, 210],
  B1: [1000, 707], B2: [707, 500], B3: [500, 353],
};

export const PT_TO_MM = 25.4 / 72;

/**
 * 由頁面尺寸判斷紙張規格。
 * `slack` 是吻合的鬆緊度（公厘）——吻合得越緊，代表這份 PDF 越可能沒被縮放過。
 */
export function detectPaper(widthPt, heightPt, tolMm = 6) {
  if (!Q.isNum(widthPt) || !Q.isNum(heightPt) || widthPt <= 0 || heightPt <= 0) return null;
  const w = widthPt * PT_TO_MM, h = heightPt * PT_TO_MM;
  let best = null;
  for (const [name, [lo, sh]] of Object.entries(PAPER)) {
    for (const [pw, ph, orient] of [[lo, sh, 'landscape'], [sh, lo, 'portrait']]) {
      const err = Math.max(Math.abs(w - pw), Math.abs(h - ph));
      if (err <= tolMm && (!best || err < best.slack)) {
        best = { name, orientation: orient, wMm: w, hMm: h, nominal: [pw, ph], slack: err };
      }
    }
  }
  return best;
}

/**
 * 紙張吻合得夠緊 → 這份 PDF 幾何是原尺寸，圖框宣告的比例可信。
 * 差了幾公厘就代表被縮放過，宣告比例就不能直接套。
 */
export const EXACT_MM = 0.5;

/* ────────── 比例文字 ────────── */

const NORM = { '：': ':', '／': '/', '＝': '=', '，': ',' };
function norm(s) {
  let out = '';
  for (const ch of String(s ?? '')) out += (NORM[ch] !== undefined ? NORM[ch] : ch);
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * 「不按比例」的明示寫法。這種圖不能量，必須講清楚。
 *
 * `NO SCALE` 是真實圖面上最常見的寫法（空軍第二戰術戰鬥機聯隊那份標單圖，
 * 七張標題欄的比例尺欄位全部寫 NO SCALE），而第一版偏偏沒收 —— 補上。
 */
const NTS_RE = /\b(N\s*T\s*S|N\.T\.S\.?)\b|\bNO[\s\-_]*SCALE\b|\bSCALE\s*[:：]?\s*(NONE|N\/A|-)\b|不按比例|不依比例|未按比例|非按比例|無比例/i;

/**
 * 從一段文字裡找出所有比例宣告。
 *
 * 認得的寫法：
 *   1:100   1/100   1：100   S:1/200   SCALE 1:50
 *   比例 1:100     比例尺 1/50
 *   A1圖:1:100     A3圖:1:200      A1:1/200
 */
export function findScales(text) {
  const s = norm(text);
  const out = [];
  if (NTS_RE.test(s)) out.push({ nts: true, raw: s });
  // 紙張前綴（A0–A4、B1–B3），可帶「圖」字
  const re = /(?:([AB][0-4])\s*圖?\s*[:：]?\s*)?(?:S|SCALE|比例尺|比例)?\s*[:：]?\s*\b1\s*[:/]\s*(\d{1,5})\b/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    const ratio = parseInt(m[2], 10);
    if (!Number.isFinite(ratio) || ratio < 1 || ratio > 20000) continue;
    out.push({ paper: m[1] ? m[1].toUpperCase() : null, ratio, raw: m[0].trim(), nts: false });
  }
  return out;
}

/** 從一堆文字項目收集比例候選，重複的合併並記下出現次數。 */
export function collectScales(strings) {
  const byKey = new Map();
  let nts = false;
  for (const s of strings || []) {
    for (const hit of findScales(s)) {
      if (hit.nts) { nts = true; continue; }
      const key = `${hit.paper || ''}|${hit.ratio}`;
      const prev = byKey.get(key);
      if (prev) prev.count++;
      else byKey.set(key, { ...hit, count: 1 });
    }
  }
  return { scales: [...byKey.values()], nts };
}

/**
 * 挑出該用哪一個比例。
 *
 * 規則很簡單也很重要：**同一張圖常同時標 A1 與 A3 兩種比例，挑錯就差一倍。**
 * 所以有紙張前綴、且前綴等於實際頁面規格的那一個最優先；
 * 找不到對應前綴時不猜，回報「有候選但選不出來」讓人決定。
 */
export function pickScale(collected, paper) {
  const list = (collected && collected.scales) || [];
  if (collected && collected.nts && !list.length) {
    return { pick: null, reason: 'nts', msg: '圖框標示「不按比例（NTS）」。這種圖不能拿來量測，請改用有比例的圖。' };
  }
  if (!list.length) return { pick: null, reason: 'none', msg: '圖框裡找不到比例宣告。' };

  const withPaper = list.filter((x) => x.paper);
  if (paper && withPaper.length) {
    const match = withPaper.filter((x) => x.paper === paper.name);
    if (match.length === 1) {
      return { pick: match[0], reason: 'paper-match', others: list.filter((x) => x !== match[0]),
        msg: `圖框標示「${match[0].raw}」，而本頁實際尺寸就是 ${paper.name}，兩者相符。` };
    }
    if (match.length > 1) {
      return { pick: null, reason: 'conflict', others: match,
        msg: `圖框為 ${paper.name} 標了 ${match.length} 個不同比例（${match.map((x) => '1:' + x.ratio).join('、')}），無法判定該用哪一個。` };
    }
    return { pick: null, reason: 'paper-mismatch', others: withPaper,
      msg: `圖框標的是 ${withPaper.map((x) => x.paper).join('、')} 的比例，但本頁實際尺寸是 ${paper.name}。`
        + `這通常代表 PDF 是用別的紙張輸出的 —— 直接套用會整批算錯，請改用兩點校正。` };
  }
  if (list.length === 1) {
    return { pick: list[0], reason: 'single', others: [],
      msg: `圖框裡只找到一個比例「${list[0].raw}」，但它沒有標明適用的紙張規格。` };
  }
  return { pick: null, reason: 'ambiguous', others: list,
    msg: `圖框裡有 ${list.length} 個比例（${list.map((x) => '1:' + x.ratio).join('、')}），且都沒標明適用紙張，無法判定。` };
}

/* ────────── 這一頁是向量還是掃描 ────────── */

/**
 * 判斷一頁 PDF 的性質。
 *
 * 真實案例：一份七頁 A3 的標單圖，每一頁的繪圖指令只有
 *   { transform:2, save:1, dependency:1, paintImageXObject:1, restore:1 }
 * —— 整頁就是一張點陣圖，沒有文字、沒有向量。
 *
 * 這對算量的意義是決定性的：
 *   沒有文字 → 讀不到圖框、讀不到比例、讀不到任何標註
 *   沒有向量 → 沒有端點可吸附、沒有圖層可彙總
 *   只剩像素量測，而像素量測**完全依賴校正是否正確，且無從驗證**
 *
 * 所以必須主動講，不能讓使用者以為「載進來了就等於能算」。
 */
export function classifyPage(info = {}) {
  const textCount = info.textCount || 0;
  const ops = info.ops || {};
  const images = (ops.paintImageXObject || 0) + (ops.paintInlineImageXObject || 0)
    + (ops.paintJpegXObject || 0);
  const paths = (ops.constructPath || 0) + (ops.stroke || 0) + (ops.fill || 0)
    + (ops.eoFill || 0) + (ops.closeStroke || 0) + (ops.fillStroke || 0);
  const total = Object.values(ops).reduce((a, b) => a + b, 0);

  const reasons = [];
  let kind = 'vector';
  if (!total && !textCount) kind = 'empty';
  else if (images > 0 && paths <= 2 && textCount === 0) kind = 'scan';
  else if (images > 0 && (paths > 2 || textCount > 0)) kind = 'mixed';

  // 掃描解析度：影像像素 ÷ 紙張英吋
  let dpi = null;
  if (info.imageWidth && info.widthPt) dpi = info.imageWidth / (info.widthPt / 72);

  if (kind === 'scan') {
    reasons.push({
      level: 'bad', kind: 'scan',
      msg: '這一頁是**純掃描圖**：整頁只有一張點陣圖，沒有任何文字或向量。'
        + (dpi ? `（掃描解析度約 ${Math.round(dpi)} dpi）` : '')
        + '讀不到圖框比例、讀不到尺寸標註、沒有端點可吸附、沒有圖層可彙總 ——'
        + '只能靠像素量測，而像素量測完全依賴校正是否正確，且無從驗證。',
    });
  } else if (kind === 'mixed') {
    reasons.push({
      level: 'warn', kind: 'mixed',
      msg: `這一頁同時有點陣圖與向量內容（影像 ${images}、路徑 ${paths}、文字 ${textCount}）。`
        + '底圖若是掃描件，疊在上面的向量標註不代表底圖是按比例的。',
    });
  }
  return { kind, images, paths, textCount, dpi, measurable: kind === 'vector' || kind === 'mixed', reasons };
}

/** 比例 1:ratio 之下，PDF 的 1 pt 等於現實幾公尺。 */
export function metersPerPoint(ratio) {
  if (!Q.isNum(ratio) || ratio <= 0) return null;
  return (PT_TO_MM / 1000) * ratio;
}

/**
 * 整合：從頁面尺寸與文字算出可套用的比例，連同**證據與可信度**一起回傳。
 *
 * 永遠不會自己套用。宣告比例是省掉第一步，不是取代兩點校正。
 */
export function analyze(widthPt, heightPt, strings, pageInfo) {
  const paper = detectPaper(widthPt, heightPt);
  const collected = collectScales(strings);
  const picked = pickScale(collected, paper);
  const exact = !!(paper && paper.slack <= EXACT_MM);
  const page = pageInfo ? classifyPage({ ...pageInfo, widthPt }) : null;

  const evidence = [];
  if (page) evidence.push(...page.reasons);
  if (paper) {
    evidence.push({
      level: exact ? 'ok' : 'warn', kind: 'paper',
      msg: `頁面 ${(widthPt * PT_TO_MM).toFixed(1)} × ${(heightPt * PT_TO_MM).toFixed(1)} mm`
        + `，${exact ? '精確' : '大致'}吻合 ${paper.name}（${paper.orientation === 'landscape' ? '橫式' : '直式'}，誤差 ${paper.slack.toFixed(2)} mm）。`
        + (exact
          ? '吻合得這麼精確，代表這份 PDF 的幾何是原尺寸、沒有被縮放過 —— 圖框宣告的比例才有意義。'
          : '差了幾公厘，代表 PDF 可能被縮放過（例如列印時選了「符合頁面大小」）。宣告比例不可直接套用。'),
    });
  } else {
    evidence.push({
      level: 'warn', kind: 'paper',
      msg: `頁面 ${(widthPt * PT_TO_MM).toFixed(1)} × ${(heightPt * PT_TO_MM).toFixed(1)} mm 不吻合任何標準紙張規格，`
        + '無法判斷這份 PDF 有沒有被縮放過。宣告比例不可直接套用。',
    });
  }
  if (collected.nts) {
    evidence.push({ level: 'bad', kind: 'nts', msg: '圖框出現「不按比例（NTS）」字樣。' });
  }
  evidence.push({ level: picked.pick ? 'ok' : 'warn', kind: 'scale', msg: picked.msg });

  // 純掃描頁讀不到任何文字，圖框比例自然也讀不到 —— 但那不是「沒有比例」，
  // 是「讀不到」。兩者的處方完全不同，必須分開講。
  if (page && page.kind === 'scan' && !collected.scales.length) {
    evidence.push({
      level: 'warn', kind: 'scan-noscale',
      msg: '因為讀不到文字，圖框上就算寫了比例也抓不到。請人眼確認標題欄的比例尺欄位 ——'
        + '台灣的標單圖很常寫「NO SCALE」，那種圖**不能量**，尺寸只能照圖上寫的數字讀。',
    });
  }

  const usable = !!(picked.pick && exact && !collected.nts && (!page || page.measurable));
  return {
    paper, exact, collected, picked, evidence, page,
    scan: !!(page && page.kind === 'scan'),
    nts: collected.nts,
    ratio: picked.pick ? picked.pick.ratio : null,
    metersPerPoint: picked.pick ? metersPerPoint(picked.pick.ratio) : null,
    usable,
    // 找得到比例但紙張不精確 → 可以當起點，但要人確認
    provisional: !!(picked.pick && !exact && !collected.nts),
  };
}
