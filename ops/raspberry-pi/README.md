# Raspberry Pi で動かす

Mac miniの代わりにRaspberry Piでも動きます。**むしろ家電まわりは有利**です。

## Macと比べてどうか

| | Mac mini | Raspberry Pi |
|---|---|---|
| Home Assistant | Docker(colima)経由。**VMのためBluetooth直結もmDNS検出も不可** | HAOSまたはDockerで**ネイティブ**。BLE・mDNS・Matterが使える |
| SwitchBotの応答 | クラウドAPI経由で**約5秒** | **BLE直結なら1秒未満**(ハブ不要) |
| Claude Code CLI | 動く | 動く(`linux-arm64` の公式バイナリあり) |
| PC操作(AppleScript/アプリ) | 使える | **使えない**(macOS専用) |
| ブラウザ操作(Playwright) | 使える | 使えるがメモリを食う。**8GB以上推奨** |
| 消費電力・費用 | 大きい | 小さい |

**家電を速くしたいならPi、PCを操作させたいならMac。** 両方欲しければ、
Home AssistantをPi、Agentをmacと分けることもできます(HAはネットワーク越しに繋がります)。

## 必要なもの

- Raspberry Pi 5 / 8GB以上を推奨
  - 4GBでも家電操作だけなら動きますが、Playwrightを使うなら8GB以上
- microSDではなく**SSD推奨**(SQLiteの書き込みが多く、SDは寿命が短い)
- Raspberry Pi OS (64-bit) または Ubuntu Server 24.04 ARM64

## 手順

### 1. Node.js 22 以上

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs build-essential
node -v
```

`build-essential` は better-sqlite3 のビルドに使います(通常はprebuiltが降ってくるので使いません)。

### 2. Claude Code CLI

```sh
sudo npm install -g @anthropic-ai/claude-code
claude --version
claude          # 初回のみ、ブラウザでログイン
```

`linux-arm64` の公式バイナリが配布されているので、そのまま動きます。
ヘッドレスの場合、表示されたURLを手元のPCで開いて認証します。

### 3. Home Assistant

**Piで動かす最大の利点はここです。** Bluetoothとネットワーク検出がそのまま使えるため、
SwitchBotをハブ無し・クラウド経由なしで直接操作できます(応答が5秒→1秒未満)。

- 専用機にするなら **Home Assistant OS** を焼くのが最も簡単
- 他の用途と同居させるなら Docker (`ops/homeassistant/docker-compose.yml` がそのまま使えます)

Dockerで動かす場合、BLEを使うには `network_mode: host` と D-Bus の共有が必要です。

### 4. Aide本体

```sh
git clone <このリポジトリ> ~/aide
cd ~/aide
npm install
npm run setup -- <ログインパスワード>
./ops/set-ha-token.sh <HAの長期アクセストークン>
```

Playwrightを使う場合のみ:

```sh
npx playwright install --with-deps chromium
```

### 5. 常駐化

```sh
mkdir -p ~/.aide
cat > ~/.aide/agent.env <<'ENV'
AIDE_SERVER_URL=wss://<あなたのドメイン>/agent/ws
AIDE_AGENT_TOKEN=<.envのAGENT_TOKENと同じ値>
AIDE_HA_URL=http://localhost:8123
AIDE_HA_TOKEN=<HAの長期アクセストークン>
ENV
chmod 600 ~/.aide/agent.env

sudo cp ops/raspberry-pi/aide-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now aide-agent
journalctl -u aide-agent -f
```

Backendも同じPiで動かす場合は、同様のserviceファイルを
`apps/server/src/index.ts` 向けに作れば動きます。

## Piでは使えない機能

`mac.execute` のうち以下はmacOS専用です。呼ばれた場合はその旨を返します。

- `applescript` — AppleScript
- `open_app` — アプリ起動(Linuxでは `xdg-open` を試みますが、ヘッドレスでは意味がありません)

`shell` と `playwright` は動きます。

また、**人がPCを使用中かどうかの判定は行いません。** ヘッドレス機には奪うGUIが無いため、
常にアイドル扱いとしてGUIキューイングを行いません。
