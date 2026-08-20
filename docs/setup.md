# Aide セットアップ手順

## 0. 前提 (Mac mini)

導入済み: Node.js 22 (nvm) / Homebrew / git / colima / docker CLI / Claude Code CLI (`claude`)

```sh
# 未導入の場合
brew install colima docker docker-compose
npm install -g @anthropic-ai/claude-code   # 既存のClaude Code認証を共有
```

## 1. 初期設定

```sh
cd ~/aide
npm install
npm run setup -- <ログインパスワード8文字以上>   # .env生成 (SESSION_SECRET/AGENT_TOKEN/VAPID等)
```

## 2. Home Assistant

```sh
colima start --cpu 2 --memory 3      # 初回のみVM作成 (数分)
cd ops/homeassistant
docker compose up -d
```

1. `http://localhost:8123` を開き、オーナーアカウントを作成
2. プロフィール → セキュリティ → **長期アクセストークン** を発行
3. `.env` の `HA_TOKEN` に設定 (`HA_BASE_URL=http://localhost:8123`)

### 機器連携 (colima=VM経由の制約に注意)

| 機器 | 連携方法 |
|---|---|
| SwitchBot | **SwitchBotハブ必須**。HAの「SwitchBot Cloud」統合 (SwitchBotアプリでトークン/シークレット発行)。BLE直結はVMのため不可 |
| IKEA (DIRIGERA) | HAの「IKEA DIRIGERA」統合。mDNS検出が効かない場合はハブのIPを手動入力 |
| エアコン/テレビ | SwitchBotハブの赤外線リモコン登録 → HAに露出 / またはメーカー公式統合 |

連携後、HAの entity_id (例: `light.bedroom`) を確認し、**PWAの設定タブ→デバイス登録**で日本語名・部屋とともに登録する (Routerの高速分類に使われる)。

### Mac起動時の自動起動

```sh
brew services start colima   # colima自動起動 (dockerコンテナはrestart:unless-stoppedで復帰)
```

## 3. Backendをローカルで起動 (開発)

```sh
npm run dev:server    # http://localhost:8787
npm run dev:web       # http://localhost:5173 (開発UI、/apiは8787へプロキシ)
```

本番相当 (PWAをBackendから配信):

```sh
npm run build && npm start   # http://localhost:8787
```

## 4. Mac Agent

```sh
mkdir -p ~/.aide
cat > ~/.aide/agent.env <<EOF
AIDE_SERVER_URL=ws://localhost:8787/agent/ws
AIDE_AGENT_TOKEN=<.envのAGENT_TOKENと同じ値>
AIDE_HA_URL=http://localhost:8123
AIDE_HA_TOKEN=<HAの長期アクセストークン>
EOF
npm run dev:agent
```

常駐化 (launchd):

```sh
sed "s|__HOME__|$HOME|g" ops/mac-agent/com.aide.agent.plist > ~/Library/LaunchAgents/com.aide.agent.plist
launchctl load ~/Library/LaunchAgents/com.aide.agent.plist
tail -f ~/.aide/agent.log
```

Railwayデプロイ後は `AIDE_SERVER_URL=wss://<railway-domain>/agent/ws` に変更して再起動。

## 5. Railwayデプロイ

> 新しい課金は発生しない前提 (既存Railway契約内)。既存プロジェクトには触れず**新規サービス**として作る。

1. GitHubにこのリポジトリをpush
2. Railwayで New Service → GitHub repo選択 (DockerfileでビルドされるTOP: `railway.json`)
3. **Persistent Volume** を作成し `/data` にマウント
4. 環境変数を設定: `.env` の内容 + `DATA_DIR=/data` + `NODE_ENV=production` + `PUBLIC_URL=https://<domain>`
   - `HA_BASE_URL`/`HA_TOKEN` は**設定しない** (RailwayからLANへ直接届かないため、家電操作はMac Agent経由で自動プロキシされる)
5. デプロイ後、Mac Agentの `AIDE_SERVER_URL` をRailwayのwss URLへ変更

## 6. PWAインストール

- iPhone: Safariで開く → 共有 → ホーム画面に追加
- 設定タブ → 「このデバイスでプッシュ通知を有効化」 (iOSはホーム画面追加後のみ通知可)

## 7. テスト

```sh
npm test          # 自動テスト (Router/権限/リスク/タスク/Undo/Memory/設定/フォールバック)
npm run typecheck
```

### 実機テストチェックリスト (Phase 1完成条件)

- [ ] スマホ・PCからPWAへログインできる
- [ ] AIと会話できる (ClaudeがメインAI)
- [ ] 「寝室の電気つけて」がClaude経由なしで1〜2秒で動く (履歴のtool=home参照)
- [ ] 「部屋いい感じにして」はClaudeが判断して実行する
- [ ] Home Assistant経由で実際の家電が動く
- [ ] 会話履歴・操作履歴が残る
- [ ] 設定を変更できる (通知レベル・学習ON/OFF・権限)
- [ ] Claude CLIを一時的に使えなくしても「電気つけて」が動く
- [ ] 有料APIを一切有効化せず動作する (設定でOFFのまま)
- [ ] Web Push通知が届く (予約タスク完了時)
- [ ] 履歴から「元に戻す」で家電が復元される
