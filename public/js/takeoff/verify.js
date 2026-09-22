/**
 * 驗算中心 —— 回答「程式讀出來的尺寸與數量，怎麼知道對不對」。
 *
 * ── 這個模組的核心發現 ──
 *
 * DXF 的 DIMENSION（標註）實體同時帶著兩個數字：
 *
 *   group 42 `measured` —— CAD **自己**從幾何算出來的量測值，單位是圖檔單位
 *   group  1 `text`     —— 圖上**印出來**的那行字
 *
 * 正常情況兩者一致（text 是空的或 `<>`，代表「就用量到的值」）。
 * 一旦不一致，只有兩種可能，而兩種都是**必須被看見**的事：
 *
 *   **比例／單位錯了**：比值剛好是 10、100、1000 這種整數量級。
 *     圖上寫 600、幾何只有 0.6 —— $INSUNITS 宣告公厘但圖其實畫在公尺上。
 *     這是「讀出來的尺寸差 1000 倍」最直接的證據，比任何啟發式判斷都硬。
 *
 *   **標註被手動覆寫**：比值是 1.07 這種不成整數的數。
 *     繪圖者把標註文字直接打成別的數字。這是圖面最危險的一種錯 ——
 *     圖上寫的跟幾何不符，而**任何自動量測都會相信幾何**，
 *     人看圖卻相信文字。兩邊永遠對不起來，而且誰都沒說謊。
 *
 * 換句話說：**圖面自己帶著答案**，只是原本沒人去問它。
 *
 * ── 其他檢查 ──
 *
 * 閉合檢查、量級合理性，以及把既有的重複描繪、座標單位、圖框比例、
 * 計算式驗算、多來源差異彙整成一份報告 —— 讓「有沒有誤」變成一個可以看的畫面，
 * 而不是散落在七個視窗裡的七個晶片。
 */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const r2 = (v) => Math.round(v * 100) / 100;

/** 常見的量級倍率。比值落在這些數附近，就是單位或比例差了一個數量級。 */
export const MAGNITUDES = [0.001, 0.01, 0.1, 1, 10, 100, 1000];
/** 判定「等於某個量級」的相對容差。CAD 的標註值本身精確，容差可以很緊。 */
export const MAG_TOL = 0.005;
/** 比值離 1 多遠才算異常。0.5% 內視為捨位差異。 */
export const SAME_TOL = 0.005;

/**
 * 從標註文字取出數字。
 *
 * 標註文字有幾種寫法：
 *   ''、'<>'          → 沒有覆寫，用量到的值
 *   '600'             → 明確數字
 *   '%%c600'          → 直徑符號 + 數字
 *   '600 (TYP)'       → 數字帶後綴
 *   '<>+50'           → 以量到的值為基礎再運算 —— 這不算單純覆寫，跳過
 *   'R50'、'6-Ø25'    → 半徑、支數×直徑
 */
export function parseDimText(text) {
  const t = String(text ?? '').trim();
  if (!t) return { kind: 'none' };
  if (/<>/.test(t)) {
    // 純 <> 是「用量到的值」；<>+50 這種是在量到的值上加減，不是覆寫
    return /^\s*<>\s*$/.test(t) ? { kind: 'none' } : { kind: 'derived', text: t };
  }
  // 去掉 AutoCAD 的控制碼與常見前綴後再找數字
  const clean = t.replace(/%%[cdp]/gi, ' ').replace(/\\[A-Za-z][^;]*;/g, ' ');
  const m = clean.match(/-?\d+(?:\.\d+)?/);
  if (!m) return { kind: 'text', text: t };
  return { kind: 'number', value: parseFloat(m[0]), text: t };
}

/** 比值最接近哪一個量級；不接近任何一個就回 null。 */
export function nearestMagnitude(ratio) {
  if (!isNum(ratio) || ratio <= 0) return null;
  for (const m of MAGNITUDES) {
    if (Math.abs(ratio / m - 1) <= MAG_TOL) return m;
  }
  return null;
}

/**
 * 逐一比對圖面上的標註與幾何量測值。
 *
 * flat 是攤平後的實體陣列（DXF.flatten 的輸出）。
 */
export function checkDimensions(flat = []) {
  const dims = flat.filter((e) => e.type === 'DIMENSION' && isNum(e.measured) && e.measured > 0);
  const rows = [];
  const magCount = new Map();

  for (const d of dims) {
    const p = parseDimText(d.text);
    if (p.kind !== 'number') {
      rows.push({ measured: d.measured, text: d.text, verdict: p.kind === 'none' ? 'no-override' : 'unparsed',
        at: d.pt, layer: d.layer });
      continue;
    }
    const ratio = p.value / d.measured;
    const mag = nearestMagnitude(ratio);
    let verdict;
    if (Math.abs(ratio - 1) <= SAME_TOL) verdict = 'match';
    else if (mag != null && mag !== 1) verdict = 'scale';       // 差一個整數量級 → 單位或比例
    else verdict = 'override';                                   // 不成量級 → 標註被手動改過
    if (verdict === 'scale') magCount.set(mag, (magCount.get(mag) || 0) + 1);
    rows.push({ measured: d.measured, text: d.text, stated: p.value, ratio: +ratio.toFixed(6),
      magnitude: mag, verdict, at: d.pt, layer: d.layer });
  }

  const counted = rows.filter((r) => r.verdict === 'match' || r.verdict === 'scale' || r.verdict === 'override');
  const match = counted.filter((r) => r.verdict === 'match').length;
  const scale = counted.filter((r) => r.verdict === 'scale').length;
  const override = counted.filter((r) => r.verdict === 'override').length;

  // 多數標註都差同一個量級 → 那不是個別錯誤，是整張圖的單位就不對
  let dominant = null;
  for (const [m, n] of magCount) {
    if (n / Math.max(counted.length, 1) >= 0.6) dominant = { magnitude: m, count: n };
  }

  return {
    total: dims.length, checked: counted.length,
    match, scale, override,
    noOverride: rows.filter((r) => r.verdict === 'no-override').length,
    unparsed: rows.filter((r) => r.verdict === 'unparsed').length,
    dominant, rows,
  };
}

/**
 * 面積工項的閉合檢查。
 *
 * 用開放多段線算出來的「面積」不是那個構件的面積 ——
 * shoelace 會把首尾自動連起來，算出一個看起來合理、但不是圖上那塊的數字。
 * 這種錯不會報錯，只會給你一個錯的面積。
 */
export function checkClosure(items = []) {
  const bad = [];
  for (const it of items) {
    if (it.measureType !== 'area') continue;
    if (!isNum(it.qty && it.qty.drawing)) continue;
    // 只有「從圖層幾何彙總出來」的面積才判得了閉合。
    //
    // 人工量測的面積，closed 旗標講的是別的事（量測工具本來就會把多邊形收口），
    // 範本裡的預設 false 更不是證據。原本的條件寫成
    //   drawingSource !== 'auto' && provenance && provenance.kind !== 'dxf-layer'
    // provenance 是 null 時整個 && 短路成 false，於是人工量測的項目照樣被判不閉合 ——
    // 這是誤報，而誤報會讓人學會忽略警告。
    const fromLayer = it.drawingSource === 'auto'
      || (it.provenance && it.provenance.kind === 'dxf-layer');
    if (!fromLayer) continue;
    if (it.closed === false) {
      bad.push({ code: it.code, name: it.name,
        why: '面積量取自未閉合的多段線 —— shoelace 會自動把首尾連起來，算出的不是圖上那塊面積' });
    }
  }
  return bad;
}

/**
 * 量級合理性。
 *
 * 不是判斷「對不對」，是判斷「有沒有離譜到不可能」——
 * 一條 0.2 公尺的幹線、五百萬公尺的電纜，都不需要專業知識就看得出不對。
 * 抓的是打錯單位、比例套錯這一類的錯，不是估算誤差。
 */
export const PLAUSIBLE = {
  length: { min: 0.5, max: 500000, unit: 'M' },
  area: { min: 0.1, max: 200000, unit: 'M²' },
  volume: { min: 0.01, max: 100000, unit: 'M³' },
  weight: { min: 1, max: 5000000, unit: 'KG' },
  count: { min: 1, max: 100000, unit: '個' },
};

export function checkMagnitude(items = []) {
  const out = [];
  for (const it of items) {
    const v = it.qty && it.qty.drawing;
    if (!isNum(v)) continue;
    const p = PLAUSIBLE[it.measureType];
    if (!p) continue;
    if (v < p.min) {
      out.push({ code: it.code, name: it.name, value: v, level: 'bad',
        why: `圖面量 ${v} ${p.unit} 小於合理下限 ${p.min} —— 多半是比例或單位少乘了一個量級` });
    } else if (v > p.max) {
      out.push({ code: it.code, name: it.name, value: v, level: 'bad',
        why: `圖面量 ${v} ${p.unit} 超過合理上限 ${p.max} —— 多半是比例或單位多乘了一個量級，或圖層重複描繪` });
    }
  }
  return out;
}

/**
 * 多來源交叉驗算。
 *
 * 兩條**獨立**來源同時算出接近的數，才叫互相驗證。
 * 只有一條來源時不管數字多漂亮都不是驗算 —— 那只是「沒有人反對」。
 */
export function crossSources(items = [], opts = {}) {
  const warn = isNum(opts.warn) ? opts.warn : 0.1;
  const rows = [];
  for (const it of items) {
    const q = it.qty || {};
    const src = [
      ['圖面量', q.drawing], ['計算式量', q.calc], ['BOQ 量', q.boq],
      ['人工確認', q.manual], ['供應商量', q.vendor],
    ].filter(([, v]) => isNum(v));
    if (src.length < 2) {
      rows.push({ code: it.code, name: it.name, sources: src.length, level: src.length ? 'warn' : 'bad',
        why: src.length ? '只有一條數量來源 —— 沒有第二條可以對，這不是驗算' : '沒有任何數量' });
      continue;
    }
    const vals = src.map(([, v]) => v);
    const max = Math.max(...vals), min = Math.min(...vals);
    const spread = max > 0 ? (max - min) / max : 0;
    rows.push({
      code: it.code, name: it.name, sources: src.length, spread: +spread.toFixed(4),
      detail: src.map(([k, v]) => `${k} ${v}`).join('、'),
      level: spread > warn ? 'bad' : spread > warn / 2 ? 'warn' : 'ok',
      why: spread > warn ? `來源之間相差 ${(spread * 100).toFixed(1)}%，超過門檻 ${(warn * 100).toFixed(0)}%`
        : `${src.length} 條來源，最大差異 ${(spread * 100).toFixed(1)}%`,
    });
  }
  return rows;
}

/**
 * 彙總成一份報告。
 *
 * 每一條都標明：**這是「已驗過」還是「沒得驗」**。
 * 這兩件事在畫面上長得很像，但意義完全相反 ——
 * 「沒有發現錯誤」跟「沒有檢查」是不一樣的，混在一起講就是騙人。
 */
export function report(ctx = {}) {
  const checks = [];
  const add = (key, label, status, msg, detail) => checks.push({ key, label, status, msg, detail });

  // 1. 標註 vs 幾何
  const dim = ctx.dimensions;
  if (!dim || !dim.total) {
    add('dim', '圖面標註 vs 幾何', 'none', '這張圖沒有 DIMENSION 標註實體，無法用圖面自己的標註互相驗算');
  } else if (dim.dominant) {
    add('dim', '圖面標註 vs 幾何', 'bad',
      `${dim.dominant.count}/${dim.checked} 個標註與幾何差 ${dim.dominant.magnitude} 倍 —— 圖檔單位或比例設定錯誤`,
      dim);
  } else if (dim.override > 0) {
    add('dim', '圖面標註 vs 幾何', 'bad',
      `${dim.override} 個標註文字被手動覆寫，與幾何不符 —— 人看圖相信文字，程式量測相信幾何，兩邊永遠對不起來`, dim);
  } else if (dim.scale > 0) {
    add('dim', '圖面標註 vs 幾何', 'warn',
      `${dim.scale} 個標註與幾何差整數量級（可能是局部大樣用了不同比例）`, dim);
  } else if (dim.match > 0) {
    add('dim', '圖面標註 vs 幾何', 'ok', `${dim.match} 個標註與幾何一致，圖檔單位與比例可信`, dim);
  } else {
    add('dim', '圖面標註 vs 幾何', 'none', `${dim.total} 個標註都沒有文字可比對（未覆寫），無從交叉驗算`, dim);
  }

  // 2. 重複描繪
  const dd = ctx.dupe;
  if (!dd) add('dupe', '重複描繪', 'none', '未載入向量圖，未檢查');
  else if (dd.clean) add('dupe', '重複描繪', 'ok', '沒有偵測到重複描繪');
  else {
    add('dupe', '重複描繪', 'bad',
      `重複長度佔 ${(dd.totals.ratio * 100).toFixed(1)}%${dd.totals.dupInserts ? `、${dd.totals.dupInserts} 個圖塊重疊` : ''} —— 會讓長度與計數直接灌水`, dd.totals);
  }

  // 3. 座標與單位
  const sv = ctx.survey;
  if (!sv) add('survey', '座標與圖檔單位', 'none', '未載入向量圖，未檢查');
  else if (sv.issues && sv.issues.length) {
    add('survey', '座標與圖檔單位', sv.issues.some((i) => i.level === 'bad') ? 'bad' : 'warn',
      sv.issues.map((i) => i.msg).join('；'), sv.issues);
  } else add('survey', '座標與圖檔單位', 'ok', '座標範圍與宣告單位相符');

  // 4. 圖框比例（PDF）
  const ps = ctx.pdfScale;
  if (!ps) add('scale', '圖框比例', 'none', '非 PDF 或未讀到圖框，未檢查');
  else if (ps.nts) add('scale', '圖框比例', 'bad', '圖面標示不按比例 —— 任何量測都不可作為數量依據');
  else if (ps.conflict) add('scale', '圖框比例', 'warn', '圖框標示多個比例，需人工指定適用範圍');
  else if (ps.ratio) add('scale', '圖框比例', 'ok', `讀到比例 1:${ps.ratio}，紙張吻合`);
  else add('scale', '圖框比例', 'none', '圖框沒有讀到比例宣告');

  // 5. 計算式
  const cs = ctx.calc;
  if (!cs) add('calc', '圖面計算式', 'none', '這張圖沒有計算式表，無法用設計者寫的算式互相驗算');
  else {
    const c = cs.verify.counts;
    add('calc', '圖面計算式', c.bad ? 'bad' : c.warn ? 'warn' : 'ok',
      `${c.rows} 道算式重算：${c.passed} 道相符${c.bad ? `、${c.bad} 處有誤` : ''}${c.warn ? `、${c.warn} 處待確認` : ''}`, c);
  }

  // 6. 閉合
  const cl = ctx.closure || [];
  if (!ctx.items || !ctx.items.length) add('closure', '面積閉合', 'none', '沒有工項可檢查');
  else if (cl.length) add('closure', '面積閉合', 'bad', `${cl.length} 個面積工項取自未閉合的多段線`, cl);
  else add('closure', '面積閉合', 'ok', '面積工項都取自封閉多段線');

  // 7. 量級
  const mg = ctx.magnitude || [];
  if (!ctx.items || !ctx.items.length) add('mag', '量級合理性', 'none', '沒有工項可檢查');
  else if (mg.length) add('mag', '量級合理性', 'bad', `${mg.length} 個工項的量離譜到不可能`, mg);
  else add('mag', '量級合理性', 'ok', '沒有離譜的量');

  // 8. 多來源
  const xs = ctx.cross || [];
  if (!xs.length) add('cross', '多來源交叉驗算', 'none', '沒有工項可檢查');
  else {
    const bad = xs.filter((x) => x.level === 'bad');
    const single = xs.filter((x) => x.sources < 2);
    add('cross', '多來源交叉驗算', bad.length ? 'bad' : single.length ? 'warn' : 'ok',
      bad.length ? `${bad.length} 個工項的來源之間差異超標`
        : single.length ? `${single.length} 個工項只有一條來源 —— 沒得對，不算驗過`
          : `全部工項都有兩條以上來源且一致`, xs);
  }

  const bad = checks.filter((c) => c.status === 'bad').length;
  const warn = checks.filter((c) => c.status === 'warn').length;
  const none = checks.filter((c) => c.status === 'none').length;
  const ok = checks.filter((c) => c.status === 'ok').length;
  return {
    checks, bad, warn, none, ok,
    // 「通過」的定義刻意嚴格：沒有 bad，而且至少有一項真的驗過。
    // 八項全是「沒得驗」不叫通過，那叫沒有檢查。
    passed: bad === 0 && ok > 0,
    verdict: bad ? 'bad' : warn ? 'warn' : ok ? 'ok' : 'none',
    note: bad ? `${bad} 項檢查不通過，數量不可直接用於發包`
      : warn ? `${warn} 項需人工確認`
        : ok ? `${ok} 項通過${none ? `、${none} 項無法檢查` : ''}`
          : '沒有任何一項檢查得以執行 —— 這不是「沒有錯誤」，是「沒有檢查」',
  };
}
