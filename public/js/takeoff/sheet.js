/**
 * 圖號（sheet number）。
 *
 * 使用者要的是「這一列的量出自哪一張圖」，而且要的是**圖號**（A0-1），
 * 不是檔名。原本工具只記得檔名 —— 檔名是給電腦看的，圖號才是
 * 工地、業主、設計單位溝通時真正在用的那個編號。
 *
 * ── 這裡最重要的一個設計決定 ──
 *
 * **猜不到就留白，不硬湊。**
 *
 * 檔名的命名習慣千奇百怪：`A0-1.dwg`、`2024-A0-1_電氣平面圖.dwg`、
 * `電氣平面圖(最終版)_0923.dwg`、`圖面.dwg`。前兩個猜得到，後兩個猜不到。
 * 猜不到卻硬給一個（例如取檔名前三個字），會讓一個**錯的圖號**被寫進
 * 請購單、發包單、驗收單 —— 那比留白嚴重得多，因為留白看得出來要補，
 * 錯的圖號看起來是對的。
 *
 * 所以：解析出來的一律標明是「由檔名推得」，而且**永遠可以人工改**。
 * 使用者填的永遠優先，而且不會被下一次自動解析蓋掉。
 */

const s = (v) => String(v ?? '').trim();

/**
 * 圖號的字形。
 *
 * 一到三個英文字母或中文字（專業別代號：A 建築、S 結構、E 電氣、M 空調、
 * P 給排水、F 消防；或「建」「結」「電」「機」「water」），
 * 接一到三位數字，後面可以再接一段 -數字（張次）。
 *
 * 刻意**不**接受純數字（`01.dwg` 的 `01` 不是圖號，是序號），
 * 也不接受四位以上的數字開頭（`2024-...` 那是年份）。
 */
const SHEET_RE = /^([A-Za-z一-鿿]{1,3})[-_ ]?(\d{1,3})(?:[-_](\d{1,3}))?$/;

/** 明顯不是圖號的詞 —— 這些出現在檔名裡是狀態或版本，不是編號。 */
const STOP = new Set(['ver', 'rev', 'v', 'final', 'copy', 'new', 'old', 'temp', 'draft',
  '最終版', '修正版', '定稿', '副本', '草稿', '試算']);

/** 把檔名切成候選詞：去副檔名，依常見分隔符切開。 */
export function tokensOf(filename) {
  const base = s(filename).replace(/\.[A-Za-z0-9]{1,5}$/, '');
  return base.split(/[\s_、．.()（）\[\]【】]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * 從檔名推圖號。
 *
 * 回傳 { no, how } 或 { no: null, why }。
 * `how` 說明是怎麼推出來的 —— 這個欄位會顯示在畫面上，
 * 讓使用者一眼判斷要不要相信它。
 */
export function parseSheetNo(filename) {
  const name = s(filename);
  if (!name) return { no: null, why: '沒有檔名' };
  const toks = tokensOf(name);
  if (!toks.length) return { no: null, why: '檔名切不出任何詞' };

  const tryTok = (t) => {
    if (STOP.has(t.toLowerCase())) return null;
    const m = t.match(SHEET_RE);
    if (!m) return null;
    // 四位數開頭的「字母+數字」多半是年份或日期，不是圖號
    if (/^\d{4}/.test(t)) return null;
    const [, alpha, num, sub] = m;
    // 要擋的是 `rev2`、`ver3`、`最終版1` ——
    // 版本字樣後面接數字時，整串不會出現在 STOP 裡，得拿**字首**去比。
    // 代價是 `V-01`（通風）這種真圖號會被一起擋掉；留白可以人工補，
    // 把版本號寫成圖號沒人看得出來，所以這個方向是刻意選的。
    if (STOP.has(alpha.toLowerCase())) return null;
    return `${alpha.toUpperCase()}${num}${sub ? `-${sub}` : ''}`;
  };

  // 第一個詞最可信：圖號通常放在檔名最前面
  const first = tryTok(toks[0]);
  if (first) return { no: first, how: '取自檔名開頭', token: toks[0] };

  // 否則掃其餘的詞，但只接受**唯一一個**命中 ——
  // 兩個以上都像圖號時，代表這個檔名的結構我判斷不了，寧可留白
  const hits = [];
  for (let i = 1; i < toks.length; i++) {
    const v = tryTok(toks[i]);
    if (v) hits.push({ v, t: toks[i] });
  }
  if (hits.length === 1) return { no: hits[0].v, how: '取自檔名中的一段', token: hits[0].t };
  if (hits.length > 1) {
    return { no: null, why: `檔名裡有 ${hits.length} 段都像圖號（${hits.map((h) => h.v).join('、')}），無法判斷` };
  }
  return { no: null, why: '檔名裡找不到像圖號的字樣' };
}

/**
 * 一張圖目前該用的圖號。
 *
 * 人工填的永遠優先，而且不會被自動解析蓋掉 ——
 * 使用者改過的東西被程式改回去，是最讓人不信任工具的一種行為。
 */
export function sheetNoOf(drawing) {
  if (!drawing) return null;
  const manual = s(drawing.sheetNo);
  if (manual) return manual;
  const p = parseSheetNo(drawing.name);
  return p.no;
}

/** 畫面與匯出用的標籤：有圖號就用圖號，沒有就退回檔名。 */
export function labelOf(drawing) {
  const no = sheetNoOf(drawing);
  if (no) return no;
  return s(drawing && drawing.name) || '';
}

/**
 * 出處記錄的顯示字串。
 *
 * 格式刻意是「圖號｜細節」而不是只有圖號 ——
 * 圖號回答「哪一張圖」，細節回答「那張圖上的哪裡」。
 * 稽核時兩個都要，少一個都答不完整。
 */
export function provenanceLabel(prov) {
  if (!prov) return '';
  const no = s(prov.sheetNo);
  const file = s(prov.drawing);
  const head = no || file || '未記錄';
  const detail = prov.kind === 'dxf-layer' ? `圖層 ${s(prov.layer)}`
    : prov.kind === 'measure' ? `量測 ${(prov.measurements || []).length} 筆${prov.page ? ` p.${prov.page}` : ''}`
      : prov.kind ? s(prov.kind) : '';
  // 圖號與檔名都有時，把檔名放在括號裡 —— 圖號是溝通用的，檔名是找檔案用的
  const src = no && file && no !== file ? `${no}（${file}）` : head;
  return detail ? `${src}｜${detail}` : src;
}

/** 匯出時的「圖號」欄：只給圖號，沒有就留白（不要塞檔名進去充數）。 */
export function sheetCell(prov) {
  if (!prov) return '';
  const no = s(prov.sheetNo);
  if (no) return no;
  // 舊資料沒有記 sheetNo，退回用檔名推 —— 但推不出來就留白
  const p = parseSheetNo(prov.drawing);
  return p.no || '';
}
