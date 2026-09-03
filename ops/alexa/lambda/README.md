# Alexa スマートホームスキル

これを設定すると、**「アレクサ、寝室の電気消して」という標準の言い方**が
Home Assistant経由になります。SwitchBotやIKEAが各社のAlexaスキルを
正しく登録できているかに左右されなくなります。

呼び出し名（「エージェントで〜」）は不要です。

## なぜLambdaが要るのか

Alexaはスマートホームスキルのエンドポイントに **AWS Lambdaしか受け付けません**
（カスタムスキルと違い、HTTPSエンドポイントは指定できない）。
そのためLambdaは中継だけを行い、実処理はAideのサーバーで行います。
Lambdaにロジックが無いので、機能を足してもLambdaの更新は不要です。

```
Echo → Alexaクラウド → AWS Lambda（中継）→ Aideサーバー → Mac Agent → Home Assistant
```

## 準備

- AWSアカウント（無料枠で足ります。この用途の実行回数は無料枠に十分収まります）
- Alexa開発者アカウント（カスタムスキルで使っているものと同じでよい）

## 手順

### 1. シークレットを生成してAideに設定

```sh
openssl rand -hex 32   # ALEXA_LAMBDA_SECRET 用
openssl rand -hex 16   # ALEXA_CLIENT_ID 用
openssl rand -hex 32   # ALEXA_CLIENT_SECRET 用
```

Railwayの環境変数に設定します。

```sh
railway variables \
  --set "ALEXA_LAMBDA_SECRET=<1つ目>" \
  --set "ALEXA_CLIENT_ID=<2つ目>" \
  --set "ALEXA_CLIENT_SECRET=<3つ目>"
```

### 2. Lambdaを作る

AWSコンソール → Lambda → 関数の作成

- 名前: `aide-alexa-smarthome`
- ランタイム: **Node.js 22.x**
- リージョン: 日本語スキルなら **米国西部 (オレゴン) us-west-2**
  （Alexaのスマートホームスキルは対応リージョンが限られる。ja-JPはus-west-2）

`index.mjs` の内容を貼り付けてデプロイし、環境変数を設定します。

- `AIDE_URL` = Aideの公開URL
- `AIDE_LAMBDA_SECRET` = 手順1の1つ目

設定 → トリガーを追加 → **Alexa Smart Home** → スキルIDを入力（手順3で発行）。

### 3. スマートホームスキルを作る

Alexa開発者コンソール → スキルの作成 → モデル: **スマートホーム**

- **デフォルトのエンドポイント**: 手順2のLambda ARN
- **アカウントリンク**:
  - Web認証画面のURI: `https://<Aideのドメイン>/alexa/oauth/authorize`
  - アクセストークンのURI: `https://<Aideのドメイン>/alexa/oauth/token`
  - クライアントID / シークレット: 手順1の2つ目・3つ目
  - 認可付与の種類: **Authorization Code Grant**
  - クライアントの認証方式: どちらでも可（Basic / リクエストボディの両方に対応）

### 4. 有効化してデバイスを検出

Alexaアプリ → スキル → 開発中のスキル → 有効にする → Aideにログイン
→ 「デバイスを検出」

Aideの設定タブに登録済みの機器がそのまま出てきます。

## 安全のための挙動

- **解錠はAlexaから即実行しません。** 承認フローに回り、
  Alexaには「スマホで承認してください」と返します（施錠はそのまま実行）
- Lambda ↔ Aide 間は共有シークレットで保護しています
- アカウントリンクのリダイレクト先はAmazonのドメインのみ許可します
- トークンはハッシュ化して保存し、認可コードは1度きり・10分で失効します

## 動かない場合

- **デバイスが見つからない** → Aideの設定タブでデバイスが登録されているか確認
- **「対応していません」と言われる** → Lambdaのリージョンがja-JP対応か確認（us-west-2）
- **連携が切れる** → Aideのログイン有効期限。Alexaアプリでスキルを無効化→再有効化
