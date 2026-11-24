#!/bin/bash
# Installation du CMULTIMEDIA Deck sur un Mac (macOS 13 ou plus récent).
# Usage : bash install.sh            installation ou mise à jour, sans rien démarrer
#         bash install.sh --demarrer  installe puis démarre le serveur et ouvre l'association de l'iPad
# Ne touche ni aux LaunchAgents ni aux réglages système : le démarrage automatique reste un choix explicite
# (./deck autostart enable --confirme).
set -u
cd "$(dirname "$0")" || exit 1
ROOT="$(pwd)"
ok() { echo "✅ $1"; }
ko() { echo "❌ $1"; }
info() { echo "   $1"; }
ERR=0

echo "🎛️  Installation du CMULTIMEDIA Deck dans $ROOT"
echo "---"

# 1. Système
if [ "$(uname)" != "Darwin" ]; then ko "macOS requis (le Deck pilote le Mac : son, applis, souris, Musique)"; exit 1; fi
ok "macOS $(sw_vers -productVersion)"

# 2. Node.js 18 ou plus (aucune dépendance npm)
if ! command -v node >/dev/null 2>&1; then
  ko "Node.js introuvable. Installe-le (https://nodejs.org, version LTS) puis relance : bash install.sh"; exit 1
fi
NV="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NV" -lt 18 ]; then ko "Node.js $NV trop ancien (18 minimum)"; exit 1; fi
ok "Node.js $(node -v)"

# 3. openssl (certificat local pour l'iPad en HTTPS)
if [ -x /opt/homebrew/bin/openssl ] || [ -x /usr/bin/openssl ]; then ok "openssl présent"; else ko "openssl introuvable"; ERR=$((ERR+1)); fi

# 4. Dossiers de travail
mkdir -p data/bin data/logs data/tmp data/captures data/config-backups data/app-icons
chmod 700 data
ok "dossier data/ prêt (clés, appareils associés et certificats y seront créés au premier démarrage)"

# 5. Configuration : on garde celle qui existe, sinon on part des exemples
mkdir -p config
for f in config.example/*.json; do
  [ -e "$f" ] || continue
  dst="config/$(basename "$f")"
  if [ -e "$dst" ]; then info "conservé : $dst"; else cp "$f" "$dst"; info "créé depuis l'exemple : $dst"; fi
done
chmod 700 config
ok "configuration en place (lisible par ce seul compte)"

# 6. Petits programmes natifs (icônes d'applis, souris et clavier, spectre audio)
if command -v swiftc >/dev/null 2>&1; then
  for t in app-icons mouse spectrum; do
    if [ ! -x "data/bin/$t" ] || [ "tools/$t.swift" -nt "data/bin/$t" ]; then
      if swiftc -O "tools/$t.swift" -o "data/bin/$t" 2>"data/logs/swiftc-$t.log"; then ok "outil $t compilé"; else ko "outil $t : compilation impossible (voir data/logs/swiftc-$t.log)"; ERR=$((ERR+1)); fi
    else ok "outil $t déjà à jour"; fi
  done
else
  ko "swiftc absent : les icônes d'applis, le trackpad et le spectre seront indisponibles"
  info "pour les avoir : xcode-select --install puis relance bash install.sh"
fi

# 7. Script de démarrage adapté à l'emplacement d'installation
# (chemin protégé par printf %q : aucun caractère du nom de dossier ne peut devenir une commande)
{
  echo '#!/bin/bash'
  echo '# Démarrage du CMULTIMEDIA Deck (double-clic ou ouverture de session).'
  printf 'cd %q && ./deck start\n' "$ROOT"
  echo 'sleep 3'
  echo 'exit 0'
} > deck-matin.command
chmod 755 deck deck-matin.command install.sh 2>/dev/null
ok "commande ./deck et deck-matin.command prêtes"

# 8. Tests
if node tests/run-tests.js >data/logs/install-tests.log 2>&1; then ok "tests automatiques passés"; else ko "tests en échec (voir data/logs/install-tests.log)"; ERR=$((ERR+1)); fi

echo "---"
if [ "$ERR" -gt 0 ]; then echo "⚠️  Installation terminée avec $ERR point(s) à revoir"; else echo "✅ Installation terminée"; fi
cat <<TXT

Ensuite :
  ./deck start         démarrer le serveur
  ./deck pair          code d'association pour l'iPad (10 minutes)
  ./deck url           adresses à ouvrir dans Safari sur l'iPad
  ./deck doctor        vérifier les permissions macOS
Permissions à accorder à Terminal (Réglages Système › Confidentialité et sécurité) :
  Accessibilité (trackpad, clavier, raccourcis),
  Enregistrement de l'écran et de l'audio du système (spectre de la page Musique).
TXT

if [ "${1:-}" = "--demarrer" ]; then ./deck start && ./deck pair; fi
exit 0
