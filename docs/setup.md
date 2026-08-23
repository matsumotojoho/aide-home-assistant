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
2. 左下のユーザー名 → セキュリティタブ → 一番下の **長期アクセストークン** を発行 (名前は「Aide」等)
3. トークンを両方の設定ファイルへ反映してサービス再起動:

```sh
./ops/set-ha-token.sh <発行したトークン>
curl -s http://localhost:8787/api/status   # ha.configured が true ならOK
```

### 機器連携 (colima=VM経由の制約に注意)

colimaはLinux VM上でDockerを動かすため、**Bluetooth直結とmDNS/Matter等のLAN内自動検出は使えない前提**で連携方法を選ぶ。

| 機器 | 連携方法 |
|---|---|
| SwitchBot | **SwitchBotハブ経由のクラウドAPI**を使う (HAの SwitchBot Cloud 統合)。トークン/シークレットはSwitchBotアプリのプロフィール→設定→開発者オプションで発行。BLE直結はVMのため不可 |
| IKEA | ハブの型番で手順が変わる。DIRIGERA=Matter/専用統合、TRÅDFRIゲートウェイ=IKEA TRÅDFRI統合。**導入前にHAの統合一覧で現行の対応状況を確認する**。自動検出が効かない場合はハブのIPを手動入力 |
| エアコン/テレビ | SwitchBotハブの赤外線リモコンに登録 → クラウドAPI経由でHAに露出。またはメーカー公式統合 |

自動検出やMatterがどうしても必要になった場合の代替: Home AssistantをMac上のDockerではなく、別のRaspberry Pi等(HAOS)へ移す。その場合もAide側は `HA_BASE_URL` の変更だけで済む (Mac AgentのHAプロキシも同様)。

連携後、HAの entity_id (例: `light.bedroom`) を確認し、**PWAの設定タブ→デバイス登録**で日本語名・部屋とともに登録する (Routerの高速分類に使われる)。

### Mac起動時の自動起動 (設定済み)

```sh
brew services start colima   # colima自動起動 (HAコンテナはrestart:unless-stoppedで復帰)
```

Backend / Mac Agent も launchd で常駐化済み:

```sh
launchctl list | grep aide            # com.aide.server / com.aide.agent
launchctl kickstart -k gui/$(id -u)/com.aide.server   # 再起動
tail -f ~/.aide/server.log ~/.aide/agent.log          # ログ
```

Railwayへ移行したらローカルBackendは停止してよい:
`launchctl unload ~/Library/LaunchAgents/com.aide.server.plist`

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

## 本番構成 (2026-08-22 移行完了)

```
スマホ / PC / Alexa
        │ HTTPS
   Railway (aide-server)          ← 公開URL・PWA配信・Alexaエンドポイント
        │ WebSocket (Mac→Railwayへのoutbound)
   Mac Agent (Mac mini常駐)
        ├→ Home Assistant (LAN)   ← 家電操作はここを経由
        ├→ Claude Code CLI        ← AI判断はここを経由 (サブスク枠)
        └→ Playwright / shell
```

- 公開URL: Railwayが発行するドメイン (`railway domain` で確認)
- データ: Railway Persistent Volume の `/data/aide.db`
- `HA_BASE_URL` / `HA_TOKEN` はRailway側では**空**。LANへ直接届かないため、
  Mac Agentの `ha.request` プロキシ経由で操作する (トークンはMac側の `~/.aide/agent.env` にのみ置く)
- ローカルのBackend (`com.aide.server`) は停止済み。戻す場合は
  `launchctl load ~/Library/LaunchAgents/com.aide.server.plist` して
  `~/.aide/agent.env` の `AIDE_SERVER_URL` を `ws://localhost:8787/agent/ws` に戻す

実測レイテンシ (クラウド経由): 家電のON/OFF 約930ms、Claude判断は数秒。

### データ移行

インスタンス間でデバイス登録・設定・権限・記憶を移す:

```sh
node ops/migrate-data.mjs <移行元URL> <移行先URL> <パスワード>
```

会話履歴は移行対象外 (移行元に残る)。


## 別の家へ導入する場合

コードに特定の家に依存する値は入っていない。家ごとに違うのは以下だけで、
すべて設定・DB・環境変数のどれかに収まっている。

| 家ごとに違うもの | どこで設定するか |
|---|---|
| 家電 (entity_id・日本語名・部屋) | PWA設定タブ → デバイス登録 (DB) |
| Home Assistantのトークン | `./ops/set-ha-token.sh <token>` |
| 位置情報 (天気用) | 設定タブ `home.location`。HAの設定から取り込める |
| Alexaの呼び出し名 | 設定タブ `alexa.invocation_name` + `ops/alexa/interaction-model.json` |
| 公開URL | Railwayのドメイン。`PUBLIC_URL` とAlexaのEndpointに設定 |
| ログインパスワード・各種シークレット | `npm run setup -- <パスワード>` で生成 |
| Google / LINE / Slack | 設定タブ → 外部サービス連携 |

### 手順

1. リポジトリを配置し `npm install`
2. `npm run setup -- <ログインパスワード>` で `.env` 生成
3. Home Assistantを立てて機器を繋ぐ (上記「2. Home Assistant」)
4. `./ops/set-ha-token.sh <HAの長期アクセストークン>`
5. Mac Agentを常駐化 (上記「4. Mac Agent」)
6. Railwayへデプロイ (上記「5. Railwayデプロイ」)
7. PWAの設定タブで家電を登録し、`home.location` を設定
8. Alexaを使うなら `ops/alexa/README.md` の手順

### 前提として必要なもの

- 常時起動のMac (Home AssistantとClaude Code CLIが動く)
- Claudeのサブスクリプション (Claude Code CLIが使えること)
- Railwayアカウント (外部公開する場合)
- Amazon開発者アカウント + Echoと同じAmazonアカウント (Alexaを使う場合)
- SwitchBotハブ等、機器側のクラウド連携 (Bluetooth直結はcolimaでは不可)

### 移行

既存インスタンスからデバイス登録・設定・権限・記憶を移すには:

```sh
node ops/migrate-data.mjs <移行元URL> <移行先URL> <パスワード>
```
