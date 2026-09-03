#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js non trovato. Installa Node.js 22.13 o successivo e riprova."
  exit 1
fi

if [ ! -f node_modules/express/package.json ] || [ ! -f node_modules/multer/package.json ] || [ -f node_modules/music-metadata/package.json ]; then
  echo "Installazione o aggiornamento dipendenze dal registry pubblico npm..."
  npm install --no-audit --no-fund --registry=https://registry.npmjs.org
fi

[ -f .env ] || cp .env.example .env
echo "Avvio Baia Cinghiala..."
npm start
