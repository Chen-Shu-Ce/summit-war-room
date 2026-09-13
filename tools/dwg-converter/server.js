#!/usr/bin/env node
/**
 * DWG → DXF 轉檔服務（零相依，Node 18+）。
 *
 * 契約（與 /api/convert-dwg 對接）：
 *   POST /            Content-Type: application/octet-stream
 *                     X-Filename: <URL 編碼的原始檔名>
 *                     Body: DWG 原始位元組
 *   200 OK            Content-Type: application/dxf
 *                     Body: ASCII DXF 文字
 *
 * 為什麼要獨立成一支服務而不是塞進網站程式：
 *   1. 授權 —— LibreDWG 是 GPL-3。以獨立行程呼叫不會把你的網站程式捲進 copyleft。
 *   2. 機密 —— 這支服務跑在你自己的內網，投標圖面不會離開公司。
 *
 * 轉檔器解析順序：DWG_CONVERT_CMD → ODAFileConverter → dwg2dxf。
 * 三個都沒有就回 501 並說明怎麼裝，不會假裝成功。
 */

const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
// TOKEN 每次請求才讀：輪替金鑰不必重啟服務，也讓行為可被測試覆蓋。
const token = () => process.env.TOKEN || '';
const MAX_BYTES = Number(process.env.MAX_BYTES || 40 * 1024 * 1024);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 120000);
const OUT_VERSION = process.env.DWG_OUT_VERSION || 'ACAD2018';

const GUIDE = {
  error: 'no_converter',
  message: '找不到可用的 DWG 轉檔器。',
  install: [
    'ODA File Converter：到 opendesign.com 下載對應平台安裝檔，安裝後確認 ODAFileConverter 在 PATH 上。',
    'LibreDWG：安裝後確認 dwg2dxf 在 PATH 上（GPL-3，以獨立行程呼叫）。',
    '或設定 DWG_CONVERT_CMD 自訂命令，樣板中可用 {in} {out} {indir} {outdir}。',
  ],
};

function which(bin) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    const p = path.join(d, bin);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* 這個目錄沒有，換下一個 */ }
  }
  return null;
}

/** 決定要用哪個轉檔器。回傳 { argv, cwd } 或 null。 */
function buildCommand(ctx) {
  const tpl = process.env.DWG_CONVERT_CMD;
  if (tpl) {
    const filled = tpl
      .replaceAll('{in}', ctx.inFile).replaceAll('{out}', ctx.outFile)
      .replaceAll('{indir}', ctx.inDir).replaceAll('{outdir}', ctx.outDir);
    return { argv: ['sh', '-c', filled], via: 'DWG_CONVERT_CMD' };
  }
  if (which('ODAFileConverter')) {
    // ODA 是資料夾對資料夾：<indir> <outdir> <輸出版本> DXF <遞迴> <稽核> <萬用字元>
    return { argv: ['ODAFileConverter', ctx.inDir, ctx.outDir, OUT_VERSION, 'DXF', '0', '1', '*.dwg'], via: 'ODAFileConverter' };
  }
  if (which('dwg2dxf')) {
    return { argv: ['dwg2dxf', '-o', ctx.outFile, ctx.inFile], via: 'dwg2dxf' };
  }
  return null;
}

function run(argv, timeoutMs) {
  return new Promise((resolve) => {
    const p = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); resolve({ code: -1, out, err: err + '\n轉檔逾時' }); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e.message) }); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BYTES) { reject(Object.assign(new Error('檔案超過上限'), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
};

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET') {
    const cmd = buildCommand({ inFile: 'x', outFile: 'y', inDir: 'a', outDir: 'b' });
    return json(res, 200, { ok: true, converter: cmd ? cmd.via : null, maxBytes: MAX_BYTES, outVersion: OUT_VERSION, ...(cmd ? {} : GUIDE) });
  }
  if (req.method !== 'POST') { res.writeHead(405, { allow: 'GET, POST' }); return res.end(); }
  const tk = token();
  if (tk && req.headers.authorization !== `Bearer ${tk}`) return json(res, 401, { error: 'unauthorized' });

  let body;
  try { body = await readBody(req); }
  catch (e) { return json(res, e.code === 413 ? 413 : 400, { error: 'bad_request', message: e.message, maxBytes: MAX_BYTES }); }
  if (!body.length) return json(res, 400, { error: 'empty_body' });

  const sig = body.subarray(0, 6).toString('latin1');
  if (!/^AC10\d\d$/.test(sig)) {
    return json(res, 415, { error: 'not_dwg', message: `檔頭不是 DWG（讀到 "${sig}"）。若已是 DXF 請直接匯入，不需經過轉檔。` });
  }

  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'dwgconv-'));
  const inDir = path.join(work, 'in'); const outDir = path.join(work, 'out');
  await fsp.mkdir(inDir); await fsp.mkdir(outDir);
  const base = 'drawing';
  const ctx = { inDir, outDir, inFile: path.join(inDir, base + '.dwg'), outFile: path.join(outDir, base + '.dxf') };
  await fsp.writeFile(ctx.inFile, body);

  try {
    const cmd = buildCommand(ctx);
    if (!cmd) return json(res, 501, GUIDE);
    const r = await run(cmd.argv, TIMEOUT_MS);
    // 有些轉檔器即使成功也回非零碼，所以以「輸出檔存不存在」為準，不只看 exit code
    const produced = (await fsp.readdir(outDir)).filter((f) => f.toLowerCase().endsWith('.dxf'));
    if (!produced.length) {
      return json(res, 502, { error: 'convert_failed', via: cmd.via, code: r.code, stderr: String(r.err).slice(0, 800) });
    }
    const text = await fsp.readFile(path.join(outDir, produced[0]), 'utf8');
    if (!/^\s*0\s*[\r\n]+\s*SECTION/m.test(text)) {
      return json(res, 502, { error: 'not_dxf', via: cmd.via, head: text.slice(0, 120) });
    }
    res.writeHead(200, { 'content-type': 'application/dxf; charset=utf-8', 'x-converter': cmd.via, 'cache-control': 'no-store' });
    res.end(text);
  } catch (e) {
    json(res, 500, { error: 'server_error', message: String(e && e.message || e) });
  } finally {
    fsp.rm(work, { recursive: true, force: true }).catch(() => { /* 暫存目錄清不掉不影響回應 */ });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    const cmd = buildCommand({ inFile: 'x', outFile: 'y', inDir: 'a', outDir: 'b' });
    console.log(`DWG 轉檔服務已啟動 http://${HOST}:${PORT}  轉檔器：${cmd ? cmd.via : '未安裝（會回 501）'}`);
  });
}

module.exports = { server, buildCommand, which };
