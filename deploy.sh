#!/bin/bash
# MK 대결미션 매니저 - 안전 배포 스크립트
# 사용법: ./deploy.sh

set -e
cd "$(dirname "$0")"

SERVER="https://soop-mission-manager-production.up.railway.app"
BACKUP_FILE="data-backup-$(date +%Y%m%d-%H%M%S).json"

echo "╔══════════════════════════════════════════╗"
echo "║   ⚔  MK 대결미션 매니저 배포             ║"
echo "╚══════════════════════════════════════════╝"

# 1. 배포 전 백업
echo ""
echo "📦 1단계: 운영서버 데이터 백업..."
HTTP_CODE=$(curl -s -o "$BACKUP_FILE" -w "%{http_code}" "$SERVER/api/data-backup" 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "200" ] && [ -s "$BACKUP_FILE" ]; then
  TEMPLATES=$(python3 -c "import json; d=json.load(open('$BACKUP_FILE')); print(len(d.get('missionTemplates',[])))" 2>/dev/null || echo "?")
  RESULTS=$(python3 -c "import json; d=json.load(open('$BACKUP_FILE')); print(len(d.get('missionResults',[])))" 2>/dev/null || echo "?")
  echo "   ✅ 백업 완료: $BACKUP_FILE (템플릿 ${TEMPLATES}개, 결과 ${RESULTS}개)"

  # data.json에도 복사 (배포 패키지에 포함)
  cp "$BACKUP_FILE" data.json
  echo "   ✅ data.json 업데이트 완료"
else
  echo "   ⚠️  서버 백업 실패 (HTTP $HTTP_CODE) - 기존 data.json 사용"
  if [ ! -f data.json ]; then
    echo '{"missionTemplates":[],"missionResults":[],"autoThreshold":0}' > data.json
    echo "   ⚠️  빈 data.json 생성됨"
  fi
fi

# 2. Railway 배포
echo ""
echo "🚀 2단계: Railway 배포 시작..."
railway up

# 3. 배포 후 확인
echo ""
echo "⏳ 3단계: 서버 재시작 대기 (15초)..."
sleep 15

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$SERVER/health" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  echo "   ✅ 서버 정상 가동!"

  # 데이터 확인
  STATE=$(curl -s "$SERVER/api/state" 2>/dev/null)
  TEMPLATES=$(echo "$STATE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('missionTemplates',[])))" 2>/dev/null || echo "?")
  RESULTS=$(echo "$STATE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('missionResults',[])))" 2>/dev/null || echo "?")
  echo "   📊 데이터: 템플릿 ${TEMPLATES}개, 결과 ${RESULTS}개"

  if [ "$TEMPLATES" = "0" ] && [ -s "$BACKUP_FILE" ]; then
    echo ""
    echo "   ⚠️  데이터가 비어있음! 백업에서 복원 중..."
    curl -s -X POST "$SERVER/api/data-restore" \
      -H "Content-Type: application/json" \
      -d @"$BACKUP_FILE" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'   ✅ 복원 완료: 템플릿 {d.get(\"templates\",0)}개, 결과 {d.get(\"results\",0)}개')" 2>/dev/null || echo "   ❌ 복원 실패"
  fi
else
  echo "   ❌ 서버 응답 없음 (HTTP $HTTP_CODE)"
fi

echo ""
echo "✅ 배포 완료!"
