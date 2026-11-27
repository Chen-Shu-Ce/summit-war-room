#!/bin/bash
# EPCOS V4 — 錯誤狀態攔截測試 (Phase 5)
set -e

BASE="http://localhost:3001/api/v1"
CT="Content-Type: application/json"
PASS=0; FAIL=0; TOTAL=0

json_field() { python3 -c "import sys,json; print(json.load(sys.stdin)$1)"; }

assert_status() {
  local desc="$1" expected="$2" actual="$3"
  TOTAL=$((TOTAL+1))
  if [ "$actual" = "$expected" ]; then
    echo "  ✓ $desc (HTTP $actual)"
    PASS=$((PASS+1))
  else
    echo "  ✗ $desc — 期望 $expected 但得到 $actual"
    FAIL=$((FAIL+1))
  fi
}

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   EPCOS V4 錯誤狀態攔截測試              ║"
echo "╚══════════════════════════════════════════╝"

# --- 準備: 取得 token 和基本資料 ---
LOGIN_RESP=$(curl -sf -X POST "$BASE/auth/login" -H "$CT" -d '{"email":"wang@test.com"}')
TOKEN=$(echo "$LOGIN_RESP" | json_field "['token']")
AUTH="Authorization: Bearer $TOKEN"
ENTITY_ID=$(curl -sf "$BASE/auth/entities" | json_field "[0]['id']")
PROJECT_ID="proj-sy-001"

echo ""
echo "━━━ 1. 認證攔截 (401) ━━━"

# 無 token
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/site-requests")
assert_status "無 Authorization header → 401" "401" "$STATUS"

# 無效 token
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/site-requests" -H "Authorization: Bearer invalid.token.here")
assert_status "無效 JWT token → 401" "401" "$STATUS"

# 空 Bearer
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/site-requests" -H "Authorization: Bearer ")
assert_status "空 Bearer token → 401" "401" "$STATUS"

echo ""
echo "━━━ 2. 資源不存在 (404) ━━━"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/site-requests/nonexistent-id" -H "$AUTH")
assert_status "SR 不存在 → 404" "404" "$STATUS"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/purchase-requests/nonexistent-id" -H "$AUTH")
assert_status "PR 不存在 → 404" "404" "$STATUS"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/purchase-orders/nonexistent-id" -H "$AUTH")
assert_status "PO 不存在 → 404" "404" "$STATUS"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/site-requests/nonexistent-id/submit" -H "$CT" -H "$AUTH")
assert_status "送審不存在的 SR → 404" "404" "$STATUS"

echo ""
echo "━━━ 3. 狀態流轉攔截 (400) ━━━"

# 建立一個 SR (DRAFT)
SR=$(curl -sf -X POST "$BASE/site-requests" -H "$CT" -H "$AUTH" \
  -d "{\"legalEntityId\":\"$ENTITY_ID\",\"projectId\":\"$PROJECT_ID\",\"title\":\"錯誤測試\",\"totalAmount\":100}")
SR_ID=$(echo "$SR" | json_field "['id']")

# DRAFT → approve (should fail, only PENDING can be approved)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/site-requests/$SR_ID/approve" -H "$CT" -H "$AUTH")
assert_status "DRAFT 不能直接核准 → 400" "400" "$STATUS"

# DRAFT → convert-pr (should fail, only APPROVED can convert)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/site-requests/$SR_ID/convert-pr" -H "$CT" -H "$AUTH")
assert_status "DRAFT 不能轉 PR → 400" "400" "$STATUS"

# Submit → PENDING
curl -sf -X POST "$BASE/site-requests/$SR_ID/submit" -H "$CT" -H "$AUTH" > /dev/null

# PENDING → submit again (should fail)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/site-requests/$SR_ID/submit" -H "$CT" -H "$AUTH")
assert_status "PENDING 不能重複送審 → 400" "400" "$STATUS"

# PENDING → convert-pr (should fail, need APPROVED)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/site-requests/$SR_ID/convert-pr" -H "$CT" -H "$AUTH")
assert_status "PENDING 不能轉 PR → 400" "400" "$STATUS"

# Approve → APPROVED
curl -sf -X POST "$BASE/site-requests/$SR_ID/approve" -H "$CT" -H "$AUTH" > /dev/null

# APPROVED → submit (should fail)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/site-requests/$SR_ID/submit" -H "$CT" -H "$AUTH")
assert_status "APPROVED 不能送審 → 400" "400" "$STATUS"

# APPROVED → approve again (should fail)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/site-requests/$SR_ID/approve" -H "$CT" -H "$AUTH")
assert_status "APPROVED 不能重複核准 → 400" "400" "$STATUS"

echo ""
echo "━━━ 4. 樂觀鎖衝突 (409) ━━━"

# 建立新 SR for concurrency test
SR2=$(curl -sf -X POST "$BASE/site-requests" -H "$CT" -H "$AUTH" \
  -d "{\"legalEntityId\":\"$ENTITY_ID\",\"projectId\":\"$PROJECT_ID\",\"title\":\"併發測試\",\"totalAmount\":200}")
SR2_ID=$(echo "$SR2" | json_field "['id']")

# 無 rowVersion → 400
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "$BASE/site-requests/$SR2_ID" -H "$CT" -H "$AUTH" \
  -d '{"title":"更新"}')
assert_status "更新缺少 rowVersion → 400" "400" "$STATUS"

# 取得當前 rowVersion
SR2_RV=$(echo "$SR2" | json_field "['rowVersion']")

# 正確 rowVersion → 200
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "$BASE/site-requests/$SR2_ID" -H "$CT" -H "$AUTH" \
  -d "{\"rowVersion\":$SR2_RV,\"title\":\"更新成功\"}")
assert_status "正確 rowVersion → 200" "200" "$STATUS"

# 舊 rowVersion → 409
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "$BASE/site-requests/$SR2_ID" -H "$CT" -H "$AUTH" \
  -d "{\"rowVersion\":$SR2_RV,\"title\":\"應該衝突\"}")
assert_status "舊 rowVersion → 409 衝突" "409" "$STATUS"

# 不可編輯非 DRAFT (submit first)
curl -sf -X POST "$BASE/site-requests/$SR2_ID/submit" -H "$CT" -H "$AUTH" > /dev/null
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "$BASE/site-requests/$SR2_ID" -H "$CT" -H "$AUTH" \
  -d "{\"rowVersion\":$((SR2_RV+1)),\"title\":\"不能改\"}")
assert_status "PENDING 狀態不可編輯 → 400" "400" "$STATUS"

echo ""
echo "━━━ 5. 冪等性 (Idempotency-Key) ━━━"

IDEM_KEY="test-idem-$(date +%s)"

# 第一次建立
RESP1=$(curl -sf -X POST "$BASE/site-requests" -H "$CT" -H "$AUTH" -H "Idempotency-Key: $IDEM_KEY" \
  -d "{\"legalEntityId\":\"$ENTITY_ID\",\"projectId\":\"$PROJECT_ID\",\"title\":\"冪等測試\",\"totalAmount\":300}")
ID1=$(echo "$RESP1" | json_field "['id']")

# 第二次相同 key — 應回傳同一筆
RESP2=$(curl -sf -X POST "$BASE/site-requests" -H "$CT" -H "$AUTH" -H "Idempotency-Key: $IDEM_KEY" \
  -d "{\"legalEntityId\":\"$ENTITY_ID\",\"projectId\":\"$PROJECT_ID\",\"title\":\"冪等測試2\",\"totalAmount\":999}")
ID2=$(echo "$RESP2" | json_field "['id']")

TOTAL=$((TOTAL+1))
if [ "$ID1" = "$ID2" ]; then
  echo "  ✓ 相同 Idempotency-Key 回傳同一筆 (ID: ${ID1:0:12}...)"
  PASS=$((PASS+1))
else
  echo "  ✗ Idempotency-Key 未攔截重複 — ID1=$ID1, ID2=$ID2"
  FAIL=$((FAIL+1))
fi

echo ""
echo "━━━ 6. 變更單狀態攔截 ━━━"

LOGIN_ENG=$(curl -sf -X POST "$BASE/auth/login" -H "$CT" -d '{"email":"chen@test.com"}')
TOKEN_ENG=$(echo "$LOGIN_ENG" | json_field "['token']")
AUTH_ENG="Authorization: Bearer $TOKEN_ENG"

CO=$(curl -sf -X POST "$BASE/change-orders" -H "$CT" -H "$AUTH_ENG" \
  -d "{\"legalEntityId\":\"$ENTITY_ID\",\"projectId\":\"$PROJECT_ID\",\"title\":\"測試變更\",\"reason\":\"測試\",\"originalAmount\":100,\"changeAmount\":50,\"items\":[]}")
CO_ID=$(echo "$CO" | json_field "['id']")

# ESTIMATING → approve (should fail)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/change-orders/$CO_ID/approve" -H "$CT" -H "$AUTH_ENG")
assert_status "ESTIMATING 不能直接核准 → 400" "400" "$STATUS"

# Submit → PENDING
curl -sf -X POST "$BASE/change-orders/$CO_ID/submit" -H "$CT" -H "$AUTH_ENG" > /dev/null

# PENDING → submit again
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/change-orders/$CO_ID/submit" -H "$CT" -H "$AUTH_ENG")
assert_status "PENDING 不能重複送審 → 400" "400" "$STATUS"

echo ""
echo "━━━ 7. 傳票狀態攔截 ━━━"

# Try confirm nonexistent voucher
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/vouchers/nonexistent-id/confirm" -H "$CT" -H "$AUTH" \
  -d '{"debitAccount":"6100","creditAccount":"2100"}')
assert_status "確認不存在的傳票 → 404" "404" "$STATUS"

echo ""
echo "━━━ 8. 預算檢查邊界 ━━━"

# 超額預算檢查
B_CHECK=$(curl -sf -X POST "$BASE/budgets/check" -H "$CT" -H "$AUTH" \
  -d "{\"projectId\":\"$PROJECT_ID\",\"category\":\"MATERIAL\",\"amount\":999999999}")
B_AVAIL=$(echo "$B_CHECK" | json_field "['available']")
TOTAL=$((TOTAL+1))
if [ "$B_AVAIL" = "False" ]; then
  echo "  ✓ 超額預算檢查 → available=False"
  PASS=$((PASS+1))
else
  echo "  ✗ 超額預算檢查 — 期望 False 但得到 $B_AVAIL"
  FAIL=$((FAIL+1))
fi

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   結果: $PASS/$TOTAL 通過, $FAIL 失敗          ║"
if [ "$FAIL" -eq 0 ]; then
  echo "║   ✓ 全部錯誤狀態攔截測試通過!            ║"
else
  echo "║   ✗ 有 $FAIL 項測試失敗                     ║"
fi
echo "╚══════════════════════════════════════════╝"

[ "$FAIL" -eq 0 ]
