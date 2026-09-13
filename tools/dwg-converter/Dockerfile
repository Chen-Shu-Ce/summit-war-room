# DWG → DXF 轉檔服務
#
# ODA File Converter 需要到 opendesign.com 註冊後自行下載，無法在映像檔裡直接抓，
# 所以請把下載好的 .deb 放在本目錄再 build。沒有放也能 build，會退回用 LibreDWG。
#
#   docker build -t dwg-converter tools/dwg-converter
#   docker run -d --name dwg-converter -p 8787:8787 -e TOKEN=<你的金鑰> dwg-converter
#   然後在網站端設定 DWG_CONVERT_URL=http://<內網位址>:8787  與 DWG_CONVERT_TOKEN=<同一把金鑰>
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      libredwg-tools ca-certificates xvfb libxi6 libxrender1 libxrandr2 libfontconfig1 \
 || apt-get install -y --no-install-recommends ca-certificates xvfb libxi6 libxrender1 libxrandr2 libfontconfig1 \
 ; rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.js ./
# 有放 ODA 的 .deb 就裝起來；沒有就跳過（build 不會因此失敗）
COPY *.de[b] /tmp/oda/
RUN if ls /tmp/oda/*.deb >/dev/null 2>&1; then \
      apt-get update && apt-get install -y --no-install-recommends /tmp/oda/*.deb && rm -rf /var/lib/apt/lists/*; \
      ln -sf "$(find /usr -name 'ODAFileConverter*' -type f -perm -u+x | head -1)" /usr/local/bin/ODAFileConverter || true; \
    fi; rm -rf /tmp/oda

ENV PORT=8787 HOST=0.0.0.0
EXPOSE 8787
# ODA 是 Qt 程式，無視窗環境要靠 xvfb 撐起來
CMD ["sh", "-c", "if command -v ODAFileConverter >/dev/null; then exec xvfb-run -a node server.js; else exec node server.js; fi"]
