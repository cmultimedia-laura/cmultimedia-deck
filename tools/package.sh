#!/bin/bash
# Fabrique l'archive d'installation du CMULTIMEDIA Deck, sans aucune donnée privée :
# ni data/ (clés, appareils associés, certificats, journaux), ni .git, ni l'essai d'app native.
# Usage : bash tools/package.sh [--avec-config]
#   --avec-config : joint la configuration actuelle de ce Mac (pages, boutons, favoris, moniteurs)
set -eu
cd "$(dirname "$0")/.."
SRC="$(pwd)"
OUT="${DECK_PACKAGE_DIR:-$HOME/Documents/claude/projets}"
# --sortie DOSSIER : où écrire l'archive (prioritaire)
ARGS=("$@")
for ((k=0; k<${#ARGS[@]}; k++)); do if [ "${ARGS[$k]}" = "--sortie" ]; then OUT="${ARGS[$((k+1))]}"; fi; done
NAME="cmultimedia-deck-$(date +%Y%m%d-%H%M%S)"
ITEMS="deck cli.js server.js install.sh lib public admin tools tests config.example"
WITH_CONFIG=0
if [[ " $* " == *" --avec-config "* ]]; then WITH_CONFIG=1; ITEMS="$ITEMS config"; echo "configuration de ce Mac jointe (avec les liaisons internes : à ne donner qu'à un Mac de confiance)"; fi
# Dossier de préparation temporaire (nettoyé par macOS) : l'arborescence y est montée telle qu'elle sera livrée
STAGE="$(mktemp -d)/cmultimedia-deck"
mkdir -p "$STAGE"
for p in $ITEMS; do [ -e "$p" ] && cp -R "$p" "$STAGE/"; done
if [ -e README-PUBLIC.md ]; then cp README-PUBLIC.md "$STAGE/README.md"; else cp README.md "$STAGE/README.md"; fi
tar -czf "$OUT/$NAME.tar.gz" --exclude '.DS_Store' -C "$(dirname "$STAGE")" cmultimedia-deck
tar -tzf "$OUT/$NAME.tar.gz" > /dev/null
SZ=$(du -h "$OUT/$NAME.tar.gz" | cut -f1)
echo "✅ $OUT/$NAME.tar.gz ($SZ, archive relue sans erreur)"
echo "Sur l'autre Mac : tar -xzf $NAME.tar.gz && cd cmultimedia-deck && bash install.sh"
