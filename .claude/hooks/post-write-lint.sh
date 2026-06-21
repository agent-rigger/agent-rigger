#!/bin/bash
# Hook Stop : Auto-format + lint après que Claude a fini ses modifications
# Appelé automatiquement par Claude Code à la fin d'une réponse
#
# Vérifie le marker .needs-lint (créé par PostToolUse sur Edit/Write)
# Output: stderr avec exit 2 pour que Claude voie les erreurs
#
# Stack: dprint (format) + oxlint (lint) + tsc (types)

set -o pipefail

# Aller à la racine du projet
cd "$(dirname "$0")/../.." || exit 0

MARKER=".claude/.needs-lint"

# Si pas de marker, aucune modification → sortir
if [[ ! -f "$MARKER" ]]; then
  exit 0
fi

# Supprimer le marker immédiatement
rm -f "$MARKER"

# Récupérer les fichiers modifiés (staged + unstaged, sans les deleted)
MODIFIED_FILES=$(git diff --name-only --diff-filter=d HEAD 2>/dev/null | grep -E '\.(js|jsx|ts|tsx)$' || true)

# Si aucun fichier JS/TS modifié, sortir silencieusement
if [[ -z "$MODIFIED_FILES" ]]; then
  exit 0
fi

# Convertir en array
mapfile -t FILES <<< "$MODIFIED_FILES"
FILE_COUNT=${#FILES[@]}

# Variables pour tracker les erreurs
HAS_ERRORS=0
OUTPUT=""

# === ETAPE 1: dprint format (tous les fichiers JS/TS) ===
if command -v bun &> /dev/null; then
  DPRINT_OUTPUT=$(bun dprint fmt "${FILES[@]}" 2>&1)
  DPRINT_EXIT=$?

  if [[ $DPRINT_EXIT -ne 0 ]]; then
    HAS_ERRORS=1
    OUTPUT+="dprint ($FILE_COUNT files):\n$DPRINT_OUTPUT\n\n"
  fi
fi

# === ETAPE 2: oxlint (tous les fichiers JS/TS) ===
if [[ -x ./node_modules/.bin/oxlint ]]; then
  OXLINT_OUTPUT=$(./node_modules/.bin/oxlint --fix "${FILES[@]}" 2>&1)
  OXLINT_EXIT=$?

  if [[ $OXLINT_EXIT -ne 0 ]]; then
    HAS_ERRORS=1
    OUTPUT+="Oxlint ($FILE_COUNT files):\n$OXLINT_OUTPUT\n\n"
  fi
fi

# === ETAPE 3: tsc --noEmit (check types global) ===
# On lance tsc sur tout le projet car les erreurs de types peuvent être ailleurs
TS_FILES=$(echo "$MODIFIED_FILES" | grep -E '\.(ts|tsx)$' || true)
if [[ -n "$TS_FILES" ]]; then
  TSC_OUTPUT=$(bun run typecheck 2>&1)
  TSC_EXIT=$?

  if [[ $TSC_EXIT -ne 0 ]]; then
    HAS_ERRORS=1
    OUTPUT+="TypeScript:\n$TSC_OUTPUT\n"
  fi
fi

# Feedback via stderr + exit 2 pour que Claude voie le résultat
if [[ $HAS_ERRORS -ne 0 ]]; then
  echo -e "## Auto-lint errors\n\n$OUTPUT" >&2
  exit 2
fi

# Succès silencieux
echo "Auto-lint OK: $FILE_COUNT file(s) checked (dprint + oxlint + tsc)"
exit 0
