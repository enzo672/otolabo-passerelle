#!/bin/bash
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js n est pas installe : https://nodejs.org (version LTS)"; read; exit 1; }
[ -d node_modules ] || npm install --no-audit --no-fund
npm run gateway
