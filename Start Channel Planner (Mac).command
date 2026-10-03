#!/bin/bash
# Double-click to start Channel Planner on a Mac.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1 || ! node -e "process.exit(Number(process.versions.node.split('.')[0]) < 22 ? 1 : 0)"; then
  echo
  echo "  Channel Planner needs Node.js version 22 or newer."
  echo "  Your browser will now open the download page."
  echo "  Download the \"LTS\" version, install it, then double-click this file again."
  echo
  open "https://nodejs.org/en/download"
  read -r -p "  Press Enter to close this window."
  exit 1
fi

echo
echo "  Getting Channel Planner ready. The first time takes a few minutes..."
echo
if ! npm install --no-audit --no-fund --loglevel=error || ! npm run build --silent; then
  echo
  echo "  Something went wrong while getting ready. Check your internet connection and try again."
  echo "  If it keeps happening, take a screenshot of this window and ask for help."
  read -r -p "  Press Enter to close this window."
  exit 1
fi

# Open the browser once the app has had a few seconds to start.
(sleep 5; open "http://localhost:3000") &
npm start --silent
