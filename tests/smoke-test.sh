#!/bin/bash
# smoke-test.sh — Deck (Mac local)
# Créé le 24/11/2026 — mis à jour à chaque feature majeure. Usage : bash tests/smoke-test.sh
# N'active JAMAIS le micro ni la caméra.
ERRORS=0
PROJECT="CMULTIMEDIA Deck"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Ports lus dans la configuration (8710 et 8711 par défaut)
H=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("portHttp", 8710))' "$DIR/config/settings.json" 2>/dev/null || echo 8710)
S=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("portHttps", 8711))' "$DIR/config/settings.json" 2>/dev/null || echo 8711)
check() { if eval "$2" > /dev/null 2>&1; then echo "✅ $1"; else echo "❌ $1"; ERRORS=$((ERRORS+1)); fi; }
echo "🧪 Smoke-test $PROJECT — $(date)"
echo "---"
# Juste après un démarrage, la première mesure du processeur est vide : on attend au plus 15 s.
for i in $(seq 1 15); do "$DIR/deck" status --json 2>/dev/null | python3 -c 'import json,sys; m=json.load(sys.stdin)["metrics"]; assert m.get("cpu") is not None' 2>/dev/null && break; sleep 1; done
check "Service UP (./deck status)" "\"$DIR/deck\" status --json | grep -q '\"ok\": true'"
check "HTTP 200 interface iPad" "curl -sf -o /dev/null http://127.0.0.1:$H/"
check "HTTPS 200 interface iPad (certificat du deck)" "curl -sf -o /dev/null --cacert \"$DIR/data/tls/ca.crt\" https://localhost:$S/"
check "Page certificat /setup" "curl -sf http://127.0.0.1:$H/setup | grep -q 'certificat'"
check "API refuse un appareil non associé en https (401)" "[ \"\$(curl -s -o /dev/null -w '%{http_code}' --cacert \"$DIR/data/tls/ca.crt\" https://localhost:$S/api/bootstrap)\" = 401 ]"
check "API fermée en http, association comprise (403)" "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'X-Deck: 1' -H 'Content-Type: application/json' -d '{\\\"code\\\":\\\"000000\\\"}' http://127.0.0.1:$H/api/pair)\" = 403 ]"
check "Aperçu refusé sans jeton d'administration (403)" "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -H 'X-Deck-Preview: 1' http://127.0.0.1:$H/api/journal)\" = 403 ]"
check "Admin refusée sans jeton (401)" "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -H 'X-Deck: 1' http://127.0.0.1:$H/admin/api/status)\" = 401 ]"
check "Jeton d'administration réservé au compte (600)" "[ \"\$(stat -f %Lp \"$DIR/data/admin.token\")\" = 600 ]"
check "Admin refusée hors 127.0.0.1 (Host étranger)" "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -H 'X-Deck: 1' -H 'Host: evil.example' http://127.0.0.1:$H/admin/api/status)\" = 403 ]"
check "Mesures réelles récentes (non démo)" "\"$DIR/deck\" status --json | python3 -c 'import json,sys,time; m=json.load(sys.stdin)[\"metrics\"]; assert m[\"demo\"] is False and time.time()*1000-m[\"t\"]<30000 and m[\"cpu\"] is not None'"
check "Configuration valide" "\"$DIR/deck\" doctor --json | python3 -c 'import json,sys; c=[x for x in json.load(sys.stdin)[\"checks\"] if x[\"label\"]==\"Configuration valide\"][0]; assert c[\"ok\"]'"
check "Aucune capture active" "\"$DIR/deck\" media status --json | grep -q '\"active\": \\[\\]'"
echo "---"
if [ $ERRORS -eq 0 ]; then echo "✅ SMOKE TEST PASSÉ ($PROJECT)"; exit 0; else echo "❌ $ERRORS ERREUR(S) ($PROJECT) — à corriger avant usage"; exit 1; fi
