#!/usr/bin/env bash
set -euo pipefail

SERVICE_SRC="/home/thetopham/memecoin-alpha-bot/systemd/memecoin-alpha-bot.service"
SERVICE_DST="$HOME/.config/systemd/user/memecoin-alpha-bot.service"

mkdir -p "$(dirname "$SERVICE_DST")"
cp "$SERVICE_SRC" "$SERVICE_DST"
systemctl --user daemon-reload
systemctl --user enable memecoin-alpha-bot.service

echo "Installed user service. Start with: systemctl --user start memecoin-alpha-bot.service"
echo "Logs: journalctl --user -u memecoin-alpha-bot.service -f"
