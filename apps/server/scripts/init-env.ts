// .env 初期生成スクリプト
// 使い方: npm run setup -- <ログインパスワード>
// SESSION_SECRET / AGENT_TOKEN / VAPIDキー / パスワードハッシュを生成して .env に書き出す。

import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import webpush from 'web-push';
import bcrypt from 'bcryptjs';

const password = process.argv[2];
if (!password || password.length < 8) {
  console.error('使い方: npm run setup -- <ログインパスワード (8文字以上)>');
  process.exit(1);
}

const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  console.error('.env がすでに存在します。上書きする場合は削除してから実行してください。');
  process.exit(1);
}

const vapid = webpush.generateVAPIDKeys();
const hash = bcrypt.hashSync(password, 12);

const env = `# Aide 環境変数 (自動生成: ${new Date().toISOString()})
PORT=8787
DATA_DIR=./data
NODE_ENV=development
PUBLIC_URL=http://localhost:8787
SESSION_SECRET=${randomBytes(32).toString('hex')}
AUTH_PASSWORD_HASH=${hash}
AUTH_EMAIL=owner@example.com
AGENT_TOKEN=${randomBytes(32).toString('hex')}
HA_BASE_URL=http://localhost:8123
HA_TOKEN=
VAPID_PUBLIC_KEY=${vapid.publicKey}
VAPID_PRIVATE_KEY=${vapid.privateKey}
VAPID_SUBJECT=mailto:owner@example.com
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
`;

writeFileSync(envPath, env, { mode: 0o600 });
console.log(`.env を生成しました: ${envPath}`);
console.log('HA_TOKEN はHome Assistantセットアップ後に設定してください (docs/setup.md参照)');
