#!/bin/sh
# Updates Channel Planner on the VPS to the latest code on GitHub and restarts it.
# GitHub Actions runs this over SSH after every push to main (see .github/workflows/deploy.yml).
set -e
cd "$(dirname "$0")/.."
git fetch --quiet origin main
git reset --quiet --hard origin/main
docker compose up -d --build --remove-orphans
docker image prune -f > /dev/null
echo "Channel Planner updated to $(git rev-parse --short HEAD)."
