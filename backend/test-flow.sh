#!/bin/bash
# ════════════════════════════════════════════════════════════
# EPCOS V4 — 核心流程端對端測試
# 完整跑通: SR → PR → PO → 驗收 → 請款
# ════════════════════════════════════════════════════════════
set -e

BASE="http://localhost:3001/api/v1"
CT="Content-Type: application/json"

json_field() { python3 -c "import sys,json; print(json.load(sys.stdin)$1)"; }

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   EPCOS V4 核心流程端對端測試            ║"
echo "║   SR → PR → PO → 驗收 → 請款            ║"
echo "╚══════════════════════════════════════════╝"

# ── Step 0: Login & get metadata ──
echo ""
echo "━━━ Step 0: 登入 & 取得基礎資料 ━━━"

LOGIN_RESP=$(curl -sf -X POST "$BASE/auth/login" -H "$CT" -d '{"email":"wang@test.com"}')
TOKEN=$(echo "$LOGIN_RESP" | json_field "['token']")
AUTH="Authorization: Bearer $TOKEN"
echo "  ✓ 登入成功: 王建民 (申請人)"

ENTITY_ID=$(curl -sf "$BASE/auth/entities" | json_field "[0]['id']")
echo "  ✓ 法人: 森陽 (SY) → $ENTITY_ID"

PROJECT_ID="proj-sy-001"
echo "  ✓ 專案: 台北辦公大樓新建工程"

# ── Step 1: 建立需求單 SR ──
echo ""
echo "━━━ Step 1: 建立需求單 (SR) ━━━"
SR_RESP=$(curl -sf -X POST "$BASE/site-requests" \
  -H "$CT" -H "$AUTH" -H "Idempotency-Key: test-sr-$(date +%s)" \
  -d "{
    \"legalEntityId\": \"$ENTITY_ID\",
    \"projectId\": \"$PROJECT_ID\",
    \"title\": \"台北辦公大樓 - 鋼筋材料採購\",
    \"description\": \"地下室結構鋼筋 SD420 #8 共 50 噸\",
    \"items\": [{\"name\":\"SD420 #8 鋼筋\",\"qty\":50,\"unit\":\"噸\",\"unitPrice\":28000}],
    \"totalAmount\": 1400000
  }")
SR_ID=$(echo "$SR_RESP" | json_field "['id']")
SR_NUM=$(echo "$SR_RESP" | json_field "['docNumber']")
SR_STATUS=$(echo "$SR_RESP" | json_field "['status']")
echo "  ✓ 建立成功: $SR_NUM (狀態: $SR_STATUS)"

# ── Step 2: SR 送審 ──
echo ""
echo "━━━ Step 2: 需求單送審 ━━━"
SR_SUBMIT=$(curl -sf -X POST "$BASE/site-requests/$SR_ID/submit" -H "$CT" -H "$AUTH")
SR_STATUS=$(echo "$SR_SUBMIT" | json_field "['status']")
echo "  ✓ 送審完成: $SR_NUM → $SR_STATUS"

# ── Step 3: SR 核准 ──
echo ""
echo "━━━ Step 3: 需求單核准 ━━━"
# Switch to 工程主管
LOGIN_ENG=$(curl -sf -X POST "$BASE/auth/login" -H "$CT" -d '{"email":"chen@test.com"}')
TOKEN_ENG=$(echo "$LOGIN_ENG" | json_field "['token']")
AUTH_ENG="Authorization: Bearer $TOKEN_ENG"

SR_APPROVE=$(curl -sf -X POST "$BASE/site-requests/$SR_ID/approve" -H "$CT" -H "$AUTH_ENG")
SR_STATUS=$(echo "$SR_APPROVE" | json_field "['status']")
echo "  ✓ 工程主管核准: $SR_NUM → $SR_STATUS"

# ── Step 4: SR 轉 PR ──
echo ""
echo "━━━ Step 4: 需求單轉採購申請 (SR → PR) ━━━"
PR_RESP=$(curl -sf -X POST "$BASE/site-requests/$SR_ID/convert-pr" -H "$CT" -H "$AUTH_ENG")
PR_ID=$(echo "$PR_RESP" | json_field "['id']")
PR_NUM=$(echo "$PR_RESP" | json_field "['docNumber']")
PR_STATUS=$(echo "$PR_RESP" | json_field "['status']")
SR_FINAL=$(curl -sf "$BASE/site-requests/$SR_ID" -H "$AUTH" | json_field "['status']")
echo "  ✓ 轉換成功: $SR_NUM($SR_FINAL) → $PR_NUM($PR_STATUS)"

# ── Step 5: PR 送審 ──
echo ""
echo "━━━ Step 5: 採購申請送審 ━━━"
# Switch to 採購承辦
LOGIN_PROC=$(curl -sf -X POST "$BASE/auth/login" -H "$CT" -d '{"email":"li@test.com"}')
TOKEN_PROC=$(echo "$LOGIN_PROC" | json_field "['token']")
AUTH_PROC="Authorization: Bearer $TOKEN_PROC"

PR_SUBMIT=$(curl -sf -X POST "$BASE/purchase-requests/$PR_ID/submit" -H "$CT" -H "$AUTH_PROC")
PR_STATUS=$(echo "$PR_SUBMIT" | json_field "['status']")
echo "  ✓ 採購承辦送審: $PR_NUM → $PR_STATUS"

# ── Step 6: PR 核准 ──
echo ""
echo "━━━ Step 6: 採購申請核准 ━━━"
# Switch to 採購主管
LOGIN_PMGR=$(curl -sf -X POST "$BASE/auth/login" -H "$CT" -d '{"email":"zhang@test.com"}')
TOKEN_PMGR=$(echo "$LOGIN_PMGR" | json_field "['token']")
AUTH_PMGR="Authorization: Bearer $TOKEN_PMGR"

PR_APPROVE=$(curl -sf -X POST "$BASE/purchase-requests/$PR_ID/approve" -H "$CT" -H "$AUTH_PMGR")
PR_STATUS=$(echo "$PR_APPROVE" | json_field "['status']")
echo "  ✓ 採購主管核准: $PR_NUM → $PR_STATUS"

# ── Step 7: PR 轉 PO ──
echo ""
echo "━━━ Step 7: 採購申請轉發包單 (PR → PO) ━━━"
PO_RESP=$(curl -sf -X POST "$BASE/purchase-requests/$PR_ID/convert-po" -H "$CT" -H "$AUTH_PMGR")
PO_ID=$(echo "$PO_RESP" | json_field "['id']")
PO_NUM=$(echo "$PO_RESP" | json_field "['docNumber']")
PO_STATUS=$(echo "$PO_RESP" | json_field "['status']")
echo "  ✓ 轉換成功: $PR_NUM → $PO_NUM($PO_STATUS)"

# ── Step 8: PO 送審 & 核准 & 發包 ──
echo ""
echo "━━━ Step 8: 發包單 送審 → 核准 → 發包 ━━━"
PO_SUBMIT=$(curl -sf -X POST "$BASE/purchase-orders/$PO_ID/submit" -H "$CT" -H "$AUTH_PMGR")
echo "  ✓ 送審: $(echo "$PO_SUBMIT" | json_field "['status']")"

PO_APPROVE=$(curl -sf -X POST "$BASE/purchase-orders/$PO_ID/approve" -H "$CT" -H "$AUTH_PMGR")
echo "  ✓ 核准: $(echo "$PO_APPROVE" | json_field "['status']")"

PO_ISSUE=$(curl -sf -X POST "$BASE/purchase-orders/$PO_ID/issue" -H "$CT" -H "$AUTH_PMGR")
PO_STATUS=$(echo "$PO_ISSUE" | json_field "['status']")
echo "  ✓ 發包: $PO_NUM → $PO_STATUS"

# ── Step 9: 建立驗收單 ──
echo ""
echo "━━━ Step 9: 建立驗收單 (PO → 驗收) ━━━"
INSP_RESP=$(curl -sf -X POST "$BASE/inspections" \
  -H "$CT" -H "$AUTH_ENG" -H "Idempotency-Key: test-insp-$(date +%s)" \
  -d "{
    \"sourceId\": \"$PO_ID\",
    \"legalEntityId\": \"$ENTITY_ID\",
    \"projectId\": \"$PROJECT_ID\",
    \"title\": \"鋼筋到貨驗收 - 第一批\",
    \"items\": [{\"name\":\"SD420 #8 鋼筋\",\"qty\":50,\"unit\":\"噸\",\"result\":\"合格\"}],
    \"totalAmount\": 1400000
  }")
INSP_ID=$(echo "$INSP_RESP" | json_field "['id']")
INSP_NUM=$(echo "$INSP_RESP" | json_field "['docNumber']")
INSP_STATUS=$(echo "$INSP_RESP" | json_field "['status']")
echo "  ✓ 驗收單建立: $INSP_NUM (狀態: $INSP_STATUS)"

# ── Step 10: 驗收完成 ──
echo ""
echo "━━━ Step 10: 驗收完成 ━━━"
INSP_COMPLETE=$(curl -sf -X POST "$BASE/inspections/$INSP_ID/complete" -H "$CT" -H "$AUTH_ENG")
INSP_STATUS=$(echo "$INSP_COMPLETE" | json_field "['status']")
echo "  ✓ 驗收完成: $INSP_NUM → $INSP_STATUS"

# ── Step 11: 建立請款單 ──
echo ""
echo "━━━ Step 11: 建立請款單 (驗收 → 請款) ━━━"
PAY_RESP=$(curl -sf -X POST "$BASE/payment-claims" \
  -H "$CT" -H "$AUTH_PROC" -H "Idempotency-Key: test-pay-$(date +%s)" \
  -d "{
    \"sourceId\": \"$INSP_ID\",
    \"legalEntityId\": \"$ENTITY_ID\",
    \"projectId\": \"$PROJECT_ID\",
    \"title\": \"鋼筋材料請款 - 第一期\",
    \"items\": [{\"name\":\"SD420 #8 鋼筋\",\"qty\":50,\"unit\":\"噸\",\"unitPrice\":28000}],
    \"totalAmount\": 1400000
  }")
PAY_ID=$(echo "$PAY_RESP" | json_field "['id']")
PAY_NUM=$(echo "$PAY_RESP" | json_field "['docNumber']")
PAY_STATUS=$(echo "$PAY_RESP" | json_field "['status']")
echo "  ✓ 請款單建立: $PAY_NUM (狀態: $PAY_STATUS)"

# ── Step 12: 請款送審 ──
echo ""
echo "━━━ Step 12: 請款送審 ━━━"
PAY_SUBMIT=$(curl -sf -X POST "$BASE/payment-claims/$PAY_ID/submit" -H "$CT" -H "$AUTH_PROC")
PAY_STATUS=$(echo "$PAY_SUBMIT" | json_field "['status']")
echo "  ✓ 送審: $PAY_NUM → $PAY_STATUS"

# ── Step 13: 請款核准 ──
echo ""
echo "━━━ Step 13: 請款核准 ━━━"
# Switch to 財務
LOGIN_FIN=$(curl -sf -X POST "$BASE/auth/login" -H "$CT" -d '{"email":"huang@test.com"}')
TOKEN_FIN=$(echo "$LOGIN_FIN" | json_field "['token']")
AUTH_FIN="Authorization: Bearer $TOKEN_FIN"

PAY_APPROVE=$(curl -sf -X POST "$BASE/payment-claims/$PAY_ID/approve" -H "$CT" -H "$AUTH_FIN")
PAY_STATUS=$(echo "$PAY_APPROVE" | json_field "['status']")
echo "  ✓ 財務核准: $PAY_NUM → $PAY_STATUS"

# ── Summary ──
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   ✓ 核心流程全部跑通!                    ║"
echo "╠══════════════════════════════════════════╣"
echo "║                                          ║"
echo "  SR: $SR_NUM (CONVERTED)"
echo "   ↓ convert-pr"
echo "  PR: $PR_NUM (CONVERTED)"
echo "   ↓ convert-po"
echo "  PO: $PO_NUM (ISSUED)"
echo "   ↓ inspection"
echo "  驗收: $INSP_NUM (COMPLETED)"
echo "   ↓ payment-claim"
echo "  請款: $PAY_NUM (APPROVED)"
echo "║                                          ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "角色參與:"
echo "  王建民(申請人) → 建立SR"
echo "  陳文茜(工程主管) → 核准SR、建立驗收"
echo "  李明哲(採購承辦) → 送審PR、建立請款"
echo "  張雅琴(採購主管) → 核准PR、發包PO"
echo "  黃美玲(財務) → 核准請款"
