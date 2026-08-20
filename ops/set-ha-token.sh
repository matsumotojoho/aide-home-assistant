#!/bin/bash
# Home Assistantの長期アクセストークンを .env と ~/.aide/agent.env の両方へ設定し、
# BackendとMac Agentを再起動する。
#
# 使い方: ./ops/set-ha-token.sh <長期アクセストークン>

set -euo pipefail

TOKEN="${1:-}"
if [ -z "$TOKEN" ]; then
  echo "使い方: ./ops/set-ha-token.sh <Home Assistantの長期アクセストークン>"
  echo "トークンは http://localhost:8123 → 左下のユーザー名 → セキュリティ → 長期アクセストークン から発行できます。"
  exit 1
fi

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO_DIR/.env"
AGENT_ENV="$HOME/.aide/agent.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "エラー: $ENV_FILE がありません。先に npm run setup -- <パスワード> を実行してください。"
  exit 1
fi

# .env の HA_TOKEN を置換 (既存行があれば書き換え、無ければ追記)
if grep -q '^HA_TOKEN=' "$ENV_FILE"; then
  tmp="$(mktemp)"
  sed "s|^HA_TOKEN=.*|HA_TOKEN=$TOKEN|" "$ENV_FILE" > "$tmp"
  mv "$tmp" "$ENV_FILE"
else
  echo "HA_TOKEN=$TOKEN" >> "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"
echo "設定しました: $ENV_FILE (HA_TOKEN)"

# Mac Agent側 (LAN内HAへのプロキシ用)
mkdir -p "$HOME/.aide"
if [ -f "$AGENT_ENV" ] && grep -q '^AIDE_HA_TOKEN=' "$AGENT_ENV"; then
  tmp="$(mktemp)"
  sed "s|^AIDE_HA_TOKEN=.*|AIDE_HA_TOKEN=$TOKEN|" "$AGENT_ENV" > "$tmp"
  mv "$tmp" "$AGENT_ENV"
else
  echo "AIDE_HA_TOKEN=$TOKEN" >> "$AGENT_ENV"
fi
chmod 600 "$AGENT_ENV"
echo "設定しました: $AGENT_ENV (AIDE_HA_TOKEN)"

# 再起動 (launchd常駐している場合のみ)
for label in com.aide.server com.aide.agent; do
  if launchctl list | grep -q "$label"; then
    launchctl kickstart -k "gui/$(id -u)/$label" 2>/dev/null && echo "再起動しました: $label"
  fi
done

echo
echo "確認: curl -s http://localhost:8787/api/status"
echo "(ha.configured が true になっていればOK)"
