/**
 * calcsheet.js — 圖面計算式解析（純函式，無 DOM、無 I/O）
 *
 * 台灣 QS 的實際工作格式：圖上直接寫出算式與結果。
 *
 *   ⓑ 走廊   1.45*3.525+1.8*2.60=9.79m2
 *   ⓚ 大廳   24.565*20.80-62.33-40.39-11.22=397.01m2     ← 上方標註 ⓗ ⓘ ⓙ
 *   合計     46.53+9.79+…+397.01=720.96m2
 *
 * 這是**第五條數量來源**，而且是唯一會自我驗算的一條：
 * 算式可以重算，交叉參照可以追，合計可以驗。不需要任何幾何就能抓出錯。
 *
 * 三條不能違背的規則：
 *   1. **絕不用 eval / Function**。算式來自外部檔案，自己寫詞法與語法分析。
 *   2. **絕不改圖上的數字**。算出來不一樣就兩個都列出來讓工程師判，不「順手修正」。
 *   3. **絕不把合理寫法當成錯誤**。大面積扣除法（ⓚ 扣掉 ⓗⓘⓙ，合計再把 ⓗⓘⓙ 加回）
 *      是正確的做法，不是重複計算。誤報比不報更糟 —— 沒人會再相信第二次警告。
 */

import * as Q from './quantity.js';
import * as U from './units.js';

/* ────────── 字元正規化 ────────── */

/** 全形運算子、各種減號與乘號，一律正規化成 ASCII。 */
const CHAR_MAP = {
  '＋': '+', '﹢': '+',
  '－': '-', '−': '-', '–': '-', '—': '-', '﹣': '-', 'ー': '-',
  '×': '*', '＊': '*', 'ｘ': '*', 'X': '*', 'x': '*',
  '÷': '/', '／': '/',
  '（': '(', '）': ')', '［': '(', '］': ')',
  '＝': '=', '，': ',', '．': '.', '。': '.',
  '０': '0', '１': '1', '２': '2', '３': '3', '４': '4',
  '５': '5', '６': '6', '７': '7', '８': '8', '９': '9',
};

export function normalize(s) {
  let out = '';
  for (const ch of String(s ?? '')) out += (CHAR_MAP[ch] !== undefined ? CHAR_MAP[ch] : ch);
  return out.replace(/\s+/g, ' ').trim();
}

/* ────────── 單位 ────────── */

/** 單位正規化交給 units.js —— 單位表只能有一份，兩份一定會漂移。 */
export function normUnit(u) {
  const k = U.normalize(u);
  return k ? U.labelOf(k) : (String(u ?? '').trim() || null);
}

/** 單位認不認得。認不得的單位不參與維度判斷，也不會被拿去換算。 */
export function knownUnit(u) { return U.normalize(u) !== null; }

/* ────────── 列號標記（圈號） ────────── */

/** 圈號 ⓐ-ⓩ、Ⓐ-Ⓩ、①-⑳、㈠-㈩、(a)、(1) 都算列號標記。 */
const CIRCLE_LOWER = 'ⓐⓑⓒⓓⓔⓕⓖⓗⓘⓙⓚⓛⓜⓝⓞⓟⓠⓡⓢⓣⓤⓥⓦⓧⓨⓩ';
const CIRCLE_UPPER = 'ⒶⒷⒸⒹⒺⒻⒼⒽⒾⒿⓀⓁⓂⓃⓄⓅⓆⓇⓈⓉⓊⓋⓌⓍⓎⓏ';
const CIRCLE_NUM = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';

/** 把一個圈號字元轉成穩定的鍵（a…z / A…Z / 1…20）。不是圈號就回 null。 */
export function markKey(ch) {
  const c = String(ch ?? '');
  let i = CIRCLE_LOWER.indexOf(c); if (i >= 0) return String.fromCharCode(97 + i);
  i = CIRCLE_UPPER.indexOf(c); if (i >= 0) return String.fromCharCode(65 + i);
  i = CIRCLE_NUM.indexOf(c); if (i >= 0) return String(i + 1);
  return null;
}

/** 從一段文字裡抓出所有圈號標記，依出現順序回傳鍵。 */
export function marksIn(text) {
  const out = [];
  for (const ch of String(text ?? '')) { const k = markKey(ch); if (k) out.push(k); }
  // (a) (1) 形式
  for (const m of String(text ?? '').matchAll(/[(（]\s*([a-zA-Z]|\d{1,2})\s*[)）]/g)) {
    const k = /\d/.test(m[1]) ? String(parseInt(m[1], 10)) : m[1];
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

/* ────────── 詞法與語法分析（不用 eval） ────────── */

export function tokenize(src) {
  const s = normalize(src);
  const toks = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ') { i++; continue; }
    if ('+-*/()'.includes(c)) { toks.push({ t: c, i }); i++; continue; }
    if (/[\d.]/.test(c)) {
      let j = i;
      while (j < s.length && /[\d.]/.test(s[j])) j++;
      const raw = s.slice(i, j);
      if ((raw.match(/\./g) || []).length > 1) return { error: `數字格式有誤：${raw}`, at: i };
      const v = parseFloat(raw);
      if (!Number.isFinite(v)) return { error: `無法解析數字：${raw}`, at: i };
      toks.push({ t: 'num', v, raw, i });
      i = j; continue;
    }
    return { error: `不認得的字元「${c}」`, at: i };
  }
  return { tokens: toks };
}

/**
 * 遞迴下降求值。文法：
 *   expr   := term (('+'|'-') term)*
 *   term   := factor (('*'|'/') factor)*
 *   factor := '-'? primary
 *   primary:= number | '(' expr ')'
 *
 * 同時記下每個「頂層加減項」的值 —— 交叉參照要靠它比對。
 */
export function evaluate(src) {
  const lex = tokenize(src);
  if (lex.error) return { error: lex.error };
  const toks = lex.tokens;
  if (!toks.length) return { error: '沒有可計算的內容' };
  let p = 0;
  const peek = () => toks[p];
  const eat = (t) => (toks[p] && toks[p].t === t ? toks[p++] : null);
  let err = null;

  function primary() {
    if (err) return 0;
    if (eat('(')) {
      const v = expr();
      if (!eat(')')) { err = err || '括號沒有閉合'; return 0; }
      return v;
    }
    const n = eat('num');
    if (!n) { err = err || `位置 ${p} 少了數字`; return 0; }
    return n.v;
  }
  function factor() {
    if (eat('-')) return -factor();
    if (eat('+')) return factor();
    return primary();
  }
  function term() {
    let v = factor();
    for (;;) {
      if (eat('*')) { v *= factor(); continue; }
      if (eat('/')) {
        const d = factor();
        if (d === 0) { err = err || '除以零'; return 0; }
        v /= d; continue;
      }
      return v;
    }
  }
  // 頂層加減項：算式的骨架，交叉參照比對用
  const terms = [];
  /** 這個頂層項是不是「單純一個數字」（而非乘除或括號）。合計列的判別靠它。 */
  const plainAt = (start) => toks.length > start && toks[start].t === 'num' && (p - start) === 1;
  function expr() {
    let sign = 1;
    let s0 = p;
    let v = term();
    terms.push({ sign: 1, value: v, plain: plainAt(s0) });
    for (;;) {
      if (eat('+')) sign = 1;
      else if (eat('-')) sign = -1;
      else return v;
      s0 = p;
      const t = term();
      terms.push({ sign, value: t, plain: plainAt(s0) });
      v += sign * t;
    }
  }
  const value = expr();
  if (err) return { error: err };
  if (p < toks.length) return { error: `位置 ${p} 之後還有多餘的內容` };
  return { value, terms };
}

/* ────────── 單列解析 ────────── */

/**
 * 解析一段文字裡的「算式＝結果單位」。
 *
 * 實際圖面上常見三種寫法，都要吃得下：
 *   1.45*3.525+1.8*2.60=9.79m2          純算式
 *   合計=720.96+788.08=1509.04m2        前面帶標籤（可能是亂碼的中文）
 *   樓地板面積=1509.04m2                只宣告數值、沒有算式
 *
 * 做法：最後一個 = 之後是結果；左邊取「最長的、合法的算式後綴」，
 * 這樣標籤裡有 = 或中文都不會把整列判掉。
 */
export function parseExpression(text) {
  const s = normalize(text);
  const eq = s.lastIndexOf('=');
  if (eq < 0) return null;
  const right = s.slice(eq + 1).trim();
  const m = right.match(/^([0-9]+(?:\.[0-9]+)?)\s*(.*)$/);
  if (!m) return null;
  const stated = parseFloat(m[1]);
  if (!Number.isFinite(stated)) return null;
  const decimals = (m[1].split('.')[1] || '').length;

  // 由右往左找最長的合法算式後綴
  const lhs = s.slice(0, eq);
  let expr = null, prefix = '';
  for (let i = 0; i < lhs.length; i++) {
    const cand = lhs.slice(i).trim();
    if (!cand || !/^[0-9+\-*/(). ]+$/.test(cand)) continue;
    if (!/[0-9]/.test(cand)) continue;
    expr = cand; prefix = lhs.slice(0, i).trim();
    break;
  }
  const base = {
    stated, decimals,
    unit: normUnit(m[2]) || null, unitRaw: m[2] || null,
    prefix: prefix || null,
  };
  // 只宣告數值、沒有算式 → 是「宣告值」，可拿去跟算出來的總計對照，但不參與驗算
  if (!expr || !/[+\-*/]/.test(expr)) {
    return { ...base, expr: expr || null, declared: true, computed: null, terms: [], error: null };
  }
  const ev = evaluate(expr);
  return {
    ...base, expr, declared: false,
    computed: ev.error ? null : ev.value,
    terms: ev.error ? [] : ev.terms,
    error: ev.error || null,
  };
}

/* ────────── 亂碼偵測 ────────── */

/**
 * 中文 DWG 常因缺 SHX 大字型而把中文全部變成「?」。
 * 數字與運算子不受影響 —— 所以算式仍可解析，但工項名稱必須人工對照。
 * 這件事要明說，不能讓人以為工具「讀懂了」那些名稱。
 */
export function isMojibake(text) {
  const s = String(text ?? '');
  const q = (s.match(/\?/g) || []).length;
  if (q < 2) return false;
  const letters = (s.match(/[^\s\d+\-*/=().,]/g) || []).length;
  return letters > 0 && q / letters >= 0.6;
}

/* ────────── 依座標把文字分列 ────────── */

/**
 * DXF 的表格是一堆獨立 TEXT，沒有「列」的概念 —— 列是用 Y 座標看出來的。
 * 以字高為尺度做分群，同列再依 X 排序。
 */
export function groupRows(texts, opts = {}) {
  const items = (texts || []).filter((t) => t && String(t.text ?? '').trim() !== '');
  if (!items.length) return [];
  const heights = items.map((t) => (Q.isNum(t.height) && t.height > 0 ? t.height : 0)).filter(Boolean).sort((a, b) => a - b);
  const h = heights.length ? heights[Math.floor(heights.length / 2)] : 1;
  const tol = Q.isNum(opts.tol) ? opts.tol : h * 0.6;

  const sorted = [...items].sort((a, b) => (b.y || 0) - (a.y || 0));
  const rows = [];
  for (const t of sorted) {
    const r = rows.find((x) => Math.abs(x.y - (t.y || 0)) <= tol);
    if (r) { r.cells.push(t); r.y = (r.y * r.cells.length + (t.y || 0)) / (r.cells.length + 1); }
    else rows.push({ y: t.y || 0, cells: [t] });
  }
  for (const r of rows) r.cells.sort((a, b) => (a.x || 0) - (b.x || 0));
  return rows.map((r) => ({ y: r.y, cells: r.cells, text: r.cells.map((c) => c.text).join(' ') }));
}

/* ────────── 整張表 ────────── */

/**
 * 解析一整張計算式表。
 *
 * 每一列找：列號標記、名稱、算式。算式列上方的圈號標記視為該列的交叉參照
 * （ⓚ 的算式上方標著 ⓗ ⓘ ⓙ，代表扣掉的是那三列）。
 */
export function parseSheet(texts, opts = {}) {
  const rows = groupRows(texts, opts);
  const heights = (texts || []).map((t) => t.height).filter((x) => Q.isNum(x) && x > 0).sort((a, b) => a - b);
  const h = heights.length ? heights[Math.floor(heights.length / 2)] : 1;

  const out = [];
  const declared = [];          // 只宣告數值、沒有算式的列
  let mojibake = 0, total = 0;
  for (const r of rows) {
    for (const c of r.cells) { total++; if (isMojibake(c.text)) mojibake++; }

    // 算式格：整格就是算式，或格內含 =
    let exprCell = null, parsed = null;
    for (const c of r.cells) {
      const p = parseExpression(c.text);
      if (p) { exprCell = c; parsed = p; break; }
    }
    if (!parsed) continue;

    const left = r.cells.filter((c) => c !== exprCell && (c.x || 0) < (exprCell.x || 0));
    const label = [left.map((c) => c.text).join(' '), parsed.prefix || ''].filter(Boolean).join(' ').trim();
    let own = marksIn(label);
    // Big5 字集沒有 ⓐ ① ㈠ 這些圈號字元，所以台灣的圖多半把圈圈畫成 CIRCLE 幾何、
    // 圈裡只放一個裸字母。那個字母在文字層就是最左邊的一格單一字元。
    if (!own.length && left.length) {
      const first = String(left[0].text || '').trim();
      if (/^[a-zA-Z]$|^\d{1,2}$/.test(first)) own = [first];
    }
    const row = {
      y: r.y, label,
      name: cleanName(label),
      mark: own.length ? own[0] : null,
      ...parsed,
      refs: [],                     // 之後由上方標記填入
      // 合計列的判別：沒有列號、兩項以上、全部是加項、而且每一項都是單純的數字
      //（不是乘除算式）。中文標籤在這類圖上常是亂碼，所以不能只靠文字判。
      isTotal: !parsed.declared && (/合\s*計|小\s*計|總\s*計|計$/.test(label)
        || (!own.length && parsed.terms.length >= 2
            && parsed.terms.every((t) => t.sign > 0 && t.plain))),
      raw: r.text,
    };
    (parsed.declared ? declared : out).push(row);
  }

  // 交叉參照：算式格正上方（約一個字高內）的圈號
  const exprXs = out.map((o) => o);
  for (const o of out) {
    const band = (texts || []).filter((t) =>
      Q.isNum(t.y) && t.y > o.y + h * 0.15 && t.y <= o.y + h * 2.2 && marksIn(t.text).length);
    const near = band.filter((t) => !exprXs.some((e) => e !== o && Math.abs(e.y - t.y) < h * 0.5));
    const set = [];
    for (const t of near) for (const k of marksIn(t.text)) if (!set.includes(k)) set.push(k);
    o.refs = set;
  }

  return {
    rows: out, declared,
    mojibake: { count: mojibake, total, ratio: total ? mojibake / total : 0 },
  };
}

/** 從「（a） 玄關」這種標籤裡取出工項名稱，去掉列號與標點。 */
export function cleanName(label) {
  let s = normalize(String(label ?? ''));
  s = s.replace(/^\s*[(（]?\s*[a-zA-Z0-9]{1,2}\s*[)）]?\s*/, '');
  for (const ch of CIRCLE_LOWER + CIRCLE_UPPER + CIRCLE_NUM) s = s.split(ch).join('');
  s = s.replace(/[=：:]\s*$/, '').trim();
  return s || null;
}

/**
 * 把計算式的列對到 BOM 工項。
 *
 * 這件事在編碼修好之前做不到 —— 名稱全是 ???? 的時候無從比對。
 * 回傳的一律是**建議**：分數、理由都附上，由人確認後才寫入。
 * 名稱相似不等於同一個工項，工具沒有資格替使用者決定。
 */
export function matchItems(rows, items, opts = {}) {
  const minScore = Q.isNum(opts.minScore) ? opts.minScore : 0.4;
  const out = [];
  for (const r of rows) {
    if (!r.name) continue;
    const cand = [];
    for (const it of items) {
      const score = nameScore(r.name, it);
      if (score <= 0) continue;
      const dimOk = !r.unit || !it.unit || U.dimOf(r.unit) === U.dimOf(it.unit);
      cand.push({ item: it, score: dimOk ? score : score * 0.4, dimOk });
    }
    cand.sort((a, b) => b.score - a.score);
    const top = cand[0];
    if (!top || top.score < minScore) { out.push({ row: r, match: null, candidates: cand.slice(0, 3) }); continue; }
    const conv = (r.unit && top.item.unit) ? U.convert(r.stated, r.unit, top.item.unit) : null;
    out.push({
      row: r, match: top.item, score: top.score, dimOk: top.dimOk,
      convert: conv,
      // 第二名太接近就是分不出來，要讓人自己選
      ambiguous: cand.length > 1 && cand[1].score > top.score * 0.85,
      candidates: cand.slice(0, 3),
    });
  }
  return out;
}

/** 名稱相似度 0–1。中文沒有空白分詞，用字元層的最長共同子字串比例。 */
export function nameScore(name, item) {
  const a = String(name || '').replace(/\s+/g, '');
  if (!a) return 0;
  let best = 0;
  for (const field of [item.name, item.spec, item.code]) {
    const b = String(field || '').replace(/\s+/g, '');
    if (!b) continue;
    if (a === b) { best = Math.max(best, 1); continue; }
    if (b.includes(a) || a.includes(b)) {
      best = Math.max(best, Math.min(a.length, b.length) / Math.max(a.length, b.length));
      continue;
    }
    const lcs = longestCommon(a, b);
    if (lcs >= 2) best = Math.max(best, lcs / Math.max(a.length, b.length));
  }
  return best;
}

function longestCommon(a, b) {
  let best = 0;
  const prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : 0;
      if (prev[j] > best) best = prev[j];
      diag = tmp;
    }
  }
  return best;
}

/* ────────── 驗算 ────────── */

/**
 * 四捨五入到指定位數，半進位（四捨五入），並先修掉二進位表示誤差。
 *
 * 3.45*3.90 在浮點裡是 13.454999999999998，直接 *100 再 Math.round 會得到 13.45，
 * 但工程上 13.455 四捨五入就是 13.46。toPrecision(15) 把表示誤差抹掉後再進位。
 */
export function roundHalfUp(v, d) {
  if (!Number.isFinite(v)) return v;
  const f = Math.pow(10, d);
  const scaled = Number((v * f).toPrecision(15));
  return (scaled < 0 ? -1 : 1) * Math.round(Math.abs(scaled)) / f;
}

/** 兩個數在小數第 d 位上是否**完全相等**（比整數，不留容差）。 */
export function equalAt(a, b, d) {
  const f = Math.pow(10, d);
  return Math.round(roundHalfUp(a, d) * f) === Math.round(roundHalfUp(b, d) * f);
}

/** 這張表主要在量什麼維度 —— 以計算式列的多數決決定。 */
export function dominantDim(rows) {
  const count = new Map();
  for (const r of rows || []) {
    const d = U.dimOf(r.unit);
    if (d) count.set(d, (count.get(d) || 0) + 1);
  }
  let best = null;
  for (const [d, n] of count) if (!best || n > best[1]) best = [d, n];
  return best ? best[0] : null;
}

export const ISSUE = {
  arith:    { label: '算錯',       level: 'bad',  note: '重算的結果與圖上寫的數字不符。' },
  parse:    { label: '算式看不懂', level: 'warn', note: '算式無法解析，可能有不認得的符號或括號不全。' },
  ref:      { label: '參照過期',   level: 'bad',  note: '算式扣除的數字與它標註參照的那一列對不上 —— 通常是圖改版後沒同步。' },
  refMiss:  { label: '參照不存在', level: 'warn', note: '標註參照了一列，但表上找不到那一列。' },
  sum:      { label: '合計不符',   level: 'bad',  note: '合計與各列結果加總不符。' },
  declared: { label: '宣告值不符', level: 'bad',  note: '圖上另外宣告的總數與表上算出來的總計對不上 —— 改版時漏改其中一處。' },
  sumItem:  { label: '合計有孤項', level: 'warn', note: '合計裡有一項對不到任何一列的結果。' },
  unit:     { label: '單位不一致', level: 'warn', note: '同一張表出現不同單位。' },
};

/**
 * 驗算整張表。
 *
 * 容差：以圖上寫的小數位數為準。1.45*3.525+1.8*2.60 = 9.79125，圖上寫 9.79，
 * 那是四捨五入不是錯誤。硬要求完全相等會把整張正確的表判成全錯。
 */
export function verify(sheet, opts = {}) {
  const rows = sheet.rows || [];
  const byMark = new Map();
  for (const r of rows) if (r.mark) byMark.set(r.mark, r);
  const issues = [];
  const push = (kind, row, msg, extra) => issues.push({ kind, ...ISSUE[kind], row: row ? (row.mark || row.label || '—') : '—', y: row ? row.y : null, msg, ...extra });

  for (const r of rows) {
    // 1. 算式本身
    if (r.error) { push('parse', r, `${r.expr}：${r.error}`); r.ok = false; continue; }
    // 圖上寫的是「四捨五入到 N 位」的結果，所以比對方式是：
    // 把重算值四捨五入到同樣位數，然後要求**完全相等**。
    // 不再另外給容差 —— 進位過後還允許誤差，等於同一件事放寬兩次。
    const rounded = roundHalfUp(r.computed, r.decimals);
    r.rounded = rounded;
    r.diff = r.computed - r.stated;
    r.ok = equalAt(r.computed, r.stated, r.decimals);
    if (!r.ok) {
      push('arith', r, `${r.expr} 重算並四捨五入至小數 ${r.decimals} 位為 ${rounded.toFixed(r.decimals)}，圖上寫 ${r.stated.toFixed(r.decimals)}（未進位前為 ${r.computed.toFixed(r.decimals + 3)}）`,
        { computed: rounded, stated: r.stated, raw: r.computed });
    }

    // 2. 交叉參照：被扣掉的數字要對得上它參照的那一列
    if (r.refs.length && r.terms.length) {
      const negs = r.terms.filter((t) => t.sign < 0).map((t) => t.value);
      for (const k of r.refs) {
        const src = byMark.get(k);
        if (!src) { push('refMiss', r, `參照了 ${k} 但表上沒有這一列`); continue; }
        const hit = negs.some((v) => Math.abs(v - src.stated) < Math.pow(10, -Math.max(r.decimals, src.decimals)) / 2 + 1e-9);
        if (!hit) {
          push('ref', r, `參照 ${k}（該列為 ${src.stated}）但本列扣除的數字是 ${negs.map((v) => v).join('、') || '無'}`,
            { ref: k, expected: src.stated, got: negs });
        }
      }
    }
  }

  // 3. 合計列：每一個加項都要對得到某一列。
  //    比對池含其他合計列 —— 總計加小計是正常的階層寫法，不是錯誤。
  //    同樣地，ⓚ 扣掉 ⓗⓘⓙ 而合計又把 ⓗⓘⓙ 加回，是標準的大面積扣除法，
  //    這裡只驗「每個加項都有出處」，不去質疑人家的算法。誤報比不報更糟。
  for (const r of rows.filter((x) => x.isTotal && !x.error)) {
    const others = rows.filter((x) => x !== r);
    const pool = others.map((o) => o.stated);
    const used = new Set();
    for (const t of r.terms.filter((x) => x.sign > 0)) {
      const idx = pool.findIndex((v, i) => !used.has(i) && Math.abs(v - t.value) < 5e-3);
      if (idx < 0) push('sumItem', r, `合計裡的 ${t.value} 對不到任何一列的結果`, { value: t.value });
      else used.add(idx);
    }
    r.coverage = { matched: used.size, terms: r.terms.filter((x) => x.sign > 0).length };
  }

  // 4. 宣告值 vs 算出來的總計。
  //    圖上常在好幾處各寫一次總面積（標題、圖例、統計框）。改版時最容易漏改其中一處，
  //    而那正是這種表最常見、也最貴的錯誤。
  //
  //    但只有**同維度**的宣告才算數：圖上的「t=15cm」是版厚註記，不是面積宣告。
  //    拿它去對 1509.04 M2 會產生一個看起來很嚴重、實際上毫無意義的警告。
  const declared = sheet.declared || [];
  const sheetDim = dominantDim(rows);
  const gt = rows.filter((r) => r.isTotal).reduce((a, b) => (!a || b.stated > a.stated ? b : a), null);
  for (const d of declared) {
    d.dim = U.dimOf(d.unit);
    d.comparable = !!(sheetDim && d.dim && d.dim === sheetDim);
    if (!d.comparable) { d.confirmedBy = 0; continue; }
    const same = [...rows, ...declared].filter((x) => x !== d
      && (U.dimOf(x.unit) === sheetDim)
      && equalAt(x.stated, d.stated, Math.min(x.decimals, d.decimals)));
    d.confirmedBy = same.length;
    if (gt && !same.length && !equalAt(d.stated, gt.stated, Math.min(d.decimals, gt.decimals))) {
      push('declared', d, `圖上宣告 ${d.stated}${d.unit || ''}，但表上算出來的總計是 ${gt.stated}${gt.unit || ''}（差 ${(d.stated - gt.stated).toFixed(2)}）`,
        { declaredValue: d.stated, computedTotal: gt.stated });
    }
  }

  // 5. 單位一致性 —— 只看計算式列。註記裡的 cm、mm 不是這張表在量的東西。
  const units = [...new Set(rows.map((r) => r.unit).filter(Boolean))];
  if (units.length > 1) push('unit', null, `本表的計算式出現 ${units.length} 種單位：${units.join('、')}`, { units });

  const bad = issues.filter((i) => i.level === 'bad').length;
  return {
    rows, declared, issues,
    units,
    ok: bad === 0,
    counts: {
      rows: rows.length,
      passed: rows.filter((r) => r.ok).length,
      failed: rows.filter((r) => r.ok === false).length,
      bad, warn: issues.filter((i) => i.level === 'warn').length,
    },
    mojibake: sheet.mojibake,
  };
}

/* ────────── 交叉比對幾何量 ────────── */

/**
 * 把計算式的結果拿去跟幾何量測比。
 *
 * 兩者都來自同一張圖，但**方法不同**：一邊是設計者寫下的尺寸相乘，
 * 一邊是我從線段算出來的面積。相符代表圖上畫的跟標的一致；
 * 不符就是二者必有一錯 —— 那正是最該發 RFI 的情形。
 */
export function crossCheck(calcQty, drawingQty, tol = 0.05) {
  if (!Q.isNum(calcQty) || !Q.isNum(drawingQty) || drawingQty === 0) return null;
  const diff = calcQty - drawingQty;
  const rate = Math.abs(diff) / Math.abs(drawingQty);
  return {
    calc: calcQty, drawing: drawingQty, diff, rate,
    agree: rate <= tol,
    verdict: rate <= tol
      ? '計算式與圖面幾何相符 —— 圖上畫的與標的一致。'
      : '計算式與圖面幾何不符。兩者都來自同一張圖，必有一錯：不是標註尺寸過期，就是圖面沒照標註畫。',
  };
}

/** 表上的總計（最大的那個合計列，或全表最後一列）。 */
export function grandTotal(sheet) {
  const rows = (sheet.rows || []).filter((r) => !r.error);
  const totals = rows.filter((r) => r.isTotal);
  if (!totals.length) return null;
  return totals.reduce((a, b) => (b.stated > a.stated ? b : a));
}
