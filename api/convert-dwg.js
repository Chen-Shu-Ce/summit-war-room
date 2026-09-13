/**
 * /api/convert-dwg — DWG → DXF 轉檔轉發器。
 *
 * 這支 API 刻意「不自己解析 DWG」。理由有兩個，都是硬理由：
 *  1. 授權：能可靠讀 DWG 的自由實作（LibreDWG）是 GPL-3。把它連結進本站的程式碼，
 *     整份程式就落入 GPL-3 的散布義務。改成「呼叫一個獨立行程／獨立服務」則屬於
 *     一般所稱的獨立程式互通，不會把本站程式碼捲進 copyleft。
 *  2. 機密：投標圖面不應該送到來路不明的線上轉檔站。預設路徑是「你自己內網那台」。
 *
 * 設定 DWG_CONVERT_URL 指向你自建的轉檔服務（見 docs/TAKEOFF.md 的部署範例）。
 * 未設定時回 501 並附上可直接照做的指引，而不是假裝成功。
 */

const MAX_BYTES = Number(process.env.DWG_MAX_BYTES || 40 * 1024 * 1024);

const GUIDE = {
  error: 'dwg_converter_not_configured',
  message: 'DWG 轉檔服務未設定。請設定環境變數 DWG_CONVERT_URL 指向自建的 DWG→DXF 服務，或改用 DXF／PDF 匯入。',
  options: [
    {
      name: 'ODA File Converter',
      note: 'Open Design Alliance 免費工具，支援 R12–2018 批次轉檔，品質最穩。',
      command: 'ODAFileConverter /in /out ACAD2018 DXF 0 1 "*.dwg"',
    },
    {
      name: 'LibreDWG dwg2dxf',
      note: 'GPL-3 命令列工具；以獨立行程呼叫不影響本站授權。新版 DWG 支援度較弱。',
      command: 'dwg2dxf -o out.dxf in.dwg',
    },
    {
      name: '人工轉出',
      note: '在 AutoCAD／BricsCAD 另存為 ASCII DXF，或列印為向量 PDF，功能完全相同。',
      command: 'SAVEAS → AutoCAD DXF (*.dxf)',
    },
  ],
};

function readBody(req) {
  // 部分平台（含 Vercel 的 Node 執行環境）會先把請求主體讀進 req.body，
  // 這時串流已經沒有資料可讀，必須直接用 req.body，否則會永遠等不到 'end'。
  if (req.body != null) {
    const b = Buffer.isBuffer(req.body) ? req.body
      : typeof req.body === 'string' ? Buffer.from(req.body, 'binary')
        : null;
    if (b) {
      if (b.length > MAX_BYTES) return Promise.reject(Object.assign(new Error('檔案超過上限'), { code: 413 }));
      return Promise.resolve(b);
    }
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BYTES) { reject(Object.assign(new Error('檔案超過上限'), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') {
    return res.status(200).json({ configured: !!process.env.DWG_CONVERT_URL, ...GUIDE });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const target = process.env.DWG_CONVERT_URL;
  if (!target) return res.status(501).json(GUIDE);

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    const code = err.code === 413 ? 413 : 400;
    return res.status(code).json({ error: code === 413 ? 'payload_too_large' : 'bad_request', message: err.message, maxBytes: MAX_BYTES });
  }
  if (!body || !body.length) return res.status(400).json({ error: 'empty_body' });

  const headers = {
    'content-type': req.headers['content-type'] || 'application/octet-stream',
    'x-filename': req.headers['x-filename'] || 'drawing.dwg',
  };
  if (process.env.DWG_CONVERT_TOKEN) headers.authorization = `Bearer ${process.env.DWG_CONVERT_TOKEN}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(process.env.DWG_CONVERT_TIMEOUT_MS || 120000));
  try {
    const upstream = await fetch(target, { method: 'POST', headers, body, signal: ctrl.signal });
    const text = await upstream.text();
    if (!upstream.ok) {
      return res.status(502).json({ error: 'converter_failed', status: upstream.status, detail: text.slice(0, 500) });
    }
    // 轉檔服務必須回傳 ASCII DXF 文字；回了別的東西就是設定錯了，不要讓前端拿去硬解析。
    if (!/^\s*0\s*[\r\n]+\s*SECTION/m.test(text)) {
      return res.status(502).json({ error: 'not_dxf', message: '轉檔服務回應的不是 ASCII DXF 文字。', head: text.slice(0, 120) });
    }
    res.setHeader('Content-Type', 'application/dxf; charset=utf-8');
    return res.status(200).send(text);
  } catch (err) {
    const aborted = err && (err.name === 'AbortError');
    return res.status(aborted ? 504 : 502).json({ error: aborted ? 'converter_timeout' : 'converter_unreachable', message: String(err && err.message || err) });
  } finally {
    clearTimeout(timer);
  }
};

// Vercel：關掉內建 body parser，才能拿到原始二進位。
module.exports.config = { api: { bodyParser: false } };
