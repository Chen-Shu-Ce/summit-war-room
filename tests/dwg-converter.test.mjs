/** 轉檔服務的行為測試：用 stub 轉檔器驗證完整路徑，不需要真的裝 ODA。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const FIXTURE = fileURLToPath(new URL('./fixture.dxf', import.meta.url));

// stub：無視輸入，直接吐出已知的 DXF，用來驗證服務的搬運與驗證邏輯
process.env.DWG_CONVERT_CMD = `cp '${FIXTURE}' {out}`;
const { server } = require('../tools/dwg-converter/server.js');

let base;
test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const DWG_HEADER = Buffer.concat([Buffer.from('AC1032', 'latin1'), Buffer.alloc(64)]);

test('GET 回報目前使用的轉檔器', async () => {
  const r = await fetch(base + '/');
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.converter, 'DWG_CONVERT_CMD');
});

test('POST DWG 回傳 ASCII DXF', async () => {
  const r = await fetch(base + '/', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: DWG_HEADER });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/dxf; charset=utf-8');
  const text = await r.text();
  assert.ok(text.startsWith('0\r\nSECTION'), text.slice(0, 20));
  assert.equal(text, readFileSync(FIXTURE, 'utf8'));
});

test('非 DWG 檔頭直接擋下，不浪費一次轉檔', async () => {
  const r = await fetch(base + '/', { method: 'POST', body: Buffer.from('0\nSECTION\n') });
  assert.equal(r.status, 415);
  const j = await r.json();
  assert.equal(j.error, 'not_dwg');
  assert.match(j.message, /DXF/);
});

test('空的 body 回 400', async () => {
  const r = await fetch(base + '/', { method: 'POST', body: Buffer.alloc(0) });
  assert.equal(r.status, 400);
});

test('轉檔器沒產出 DXF 時回 502 並帶 stderr', async () => {
  const old = process.env.DWG_CONVERT_CMD;
  process.env.DWG_CONVERT_CMD = 'echo "converter blew up" >&2; exit 3';
  const r = await fetch(base + '/', { method: 'POST', body: DWG_HEADER });
  process.env.DWG_CONVERT_CMD = old;
  assert.equal(r.status, 502);
  const j = await r.json();
  assert.equal(j.error, 'convert_failed');
  assert.match(j.stderr, /blew up/);
});

test('轉檔器吐出的不是 DXF 時回 502，不讓前端硬解析', async () => {
  const old = process.env.DWG_CONVERT_CMD;
  process.env.DWG_CONVERT_CMD = 'echo "<html>error page</html>" > {out}';
  const r = await fetch(base + '/', { method: 'POST', body: DWG_HEADER });
  process.env.DWG_CONVERT_CMD = old;
  assert.equal(r.status, 502);
  assert.equal((await r.json()).error, 'not_dxf');
});

test('設定 TOKEN 後未帶授權一律 401', async () => {
  process.env.TOKEN = 's3cret';
  const r = await fetch(base + '/', { method: 'POST', body: DWG_HEADER });
  assert.equal(r.status, 401);
  const ok = await fetch(base + '/', { method: 'POST', headers: { authorization: 'Bearer s3cret' }, body: DWG_HEADER });
  assert.equal(ok.status, 200);
  delete process.env.TOKEN;
});
