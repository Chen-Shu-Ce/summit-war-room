# pdf.js（隨附）

- 套件：`pdfjs-dist@4.10.38`，取自 npm registry，僅保留 `build/pdf.min.mjs` 與 `build/pdf.worker.min.mjs`。
- 授權：Apache License 2.0，Copyright Mozilla Foundation（授權宣告保留在檔案開頭）。
- 為什麼隨附而不用 CDN：投標圖面屬機密，工具必須能在無外網的環境（工地、內網）運作，
  同時避免第三方 CDN 成為單點故障或 CSP 例外。
- 升級方式：`npm pack pdfjs-dist@<版本>` 後取出上述兩個檔案覆蓋，並重跑 `npm run test:e2e`。
