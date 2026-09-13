# DWG → DXF 轉檔服務

跑在**你自己的內網**，讓工程量清單選擇器可以讀 DWG，而圖面不會離開公司。

## 為什麼要獨立一支服務

1. **授權**：能可靠讀 DWG 的自由實作 GNU LibreDWG 是 GPL-3。把它連結進網站程式，
   整份程式就落入 GPL-3 的散布義務；改成呼叫獨立行程／獨立服務則不會。
2. **機密**：投標圖面不該送到線上轉檔站。

## 啟動

```bash
# 直接跑（需要 PATH 上有 ODAFileConverter 或 dwg2dxf）
node tools/dwg-converter/server.js

# 或用 Docker（把 ODA 的 .deb 放進本目錄可自動安裝）
docker build -t dwg-converter tools/dwg-converter
docker run -d --name dwg-converter -p 8787:8787 -e TOKEN=your-secret dwg-converter
```

網站端設定：

```
DWG_CONVERT_URL=http://<內網位址>:8787
DWG_CONVERT_TOKEN=your-secret
```

## 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `PORT` / `HOST` | 8787 / 0.0.0.0 | 監聽位址 |
| `TOKEN` | 無 | 設了就要求 `Authorization: Bearer <TOKEN>`；每次請求才讀，輪替金鑰不必重啟 |
| `MAX_BYTES` | 40 MB | 單檔上限 |
| `TIMEOUT_MS` | 120000 | 轉檔逾時 |
| `DWG_OUT_VERSION` | ACAD2018 | ODA 的輸出版本 |
| `DWG_CONVERT_CMD` | 無 | 自訂命令樣板，可用 `{in} {out} {indir} {outdir}` |

轉檔器解析順序：`DWG_CONVERT_CMD` → `ODAFileConverter` → `dwg2dxf`；都沒有就回 **501** 並附安裝指引。

## 介面

```
GET  /        → { ok, converter, maxBytes, outVersion }        健康檢查兼回報用哪個轉檔器
POST /        → Body: DWG 原始位元組 → 200 application/dxf      失敗時回 JSON 錯誤
```

錯誤碼都有明確語意，不會用 200 掩蓋失敗：

| 狀態 | 意義 |
|---|---|
| 401 | TOKEN 不符 |
| 400 / 413 | 空 body／超過上限 |
| 415 | 檔頭不是 `AC10xx`，根本不是 DWG（若已是 DXF 請直接匯入） |
| 501 | 機器上沒有任何轉檔器 |
| 502 | 轉檔器執行失敗，或吐出的不是 ASCII DXF（附 stderr） |

## 設計上的兩個刻意選擇

- **以「有沒有產出 DXF」判定成敗，不只看 exit code**：ODA 成功時也可能回非零碼。
- **回應前驗證內容確實以 `0 / SECTION` 開頭**：轉檔器回錯誤頁面時直接擋在這裡，
  不讓前端拿 HTML 去當 DXF 硬解析。

測試：`node --test "tests/*.test.mjs"`（用 stub 轉檔器覆蓋完整路徑，不需真的安裝 ODA）。
