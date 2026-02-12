#!/bin/bash
echo ""
echo "=============================="
echo " SOOP 대결미션 매니저 시작"
echo "=============================="
echo ""
cd "$(dirname "$0")"
open http://localhost:3000 2>/dev/null || xdg-open http://localhost:3000 2>/dev/null
node server.js
