import { config as loadEnv } from 'dotenv';
import { randomBytes } from 'node:crypto';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

// .env はリポジトリルートに置く (カレントディレクトリの .env も後勝ちで読む)
const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '../../../.env') });
loadEnv();

const isProd = process.env.NODE_ENV === 'production';

function required(name: string, devFallback?: () => string): string {
  const v = process.env[name];
  if (v && v.length > 0) return v;
  if (!isProd && devFallback) {
    const gen = devFallback();
    console.warn(`[config] ${name} 未設定のため開発用の一時値を生成しました。本番では必ず設定してください。`);
    return gen;
  }
  if (isProd) {
    throw new Error(`[config] 必須環境変数 ${name} が未設定です`);
  }
  return '';
}

// DATA_DIRが相対パスの場合はリポジトリルート基準で解決する。
// (npm run -w はcwdをワークスペースへ移すため、cwd基準だとDBの場所がブレる)
const repoRoot = resolve(__dirname, '../../..');
const rawDataDir = process.env.DATA_DIR ?? './data';
const dataDir = isAbsolute(rawDataDir) ? rawDataDir : resolve(repoRoot, rawDataDir);

export const config = {
  isProd,
  port: Number(process.env.PORT ?? 8787),
  dataDir,
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 8787}`,
  sessionSecret: required('SESSION_SECRET', () => randomBytes(32).toString('hex')),
  authPasswordHash: process.env.AUTH_PASSWORD_HASH ?? '',
  authEmail: process.env.AUTH_EMAIL ?? 'owner@example.com',
  agentToken: required('AGENT_TOKEN', () => randomBytes(32).toString('hex')),
  ha: {
    baseUrl: (process.env.HA_BASE_URL ?? '').replace(/\/$/, ''),
    token: process.env.HA_TOKEN ?? '',
  },
  vapid: {
    publicKey: process.env.VAPID_PUBLIC_KEY ?? '',
    privateKey: process.env.VAPID_PRIVATE_KEY ?? '',
    subject: process.env.VAPID_SUBJECT ?? 'mailto:owner@example.com',
  },
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  timezone: 'Asia/Tokyo',
} as const;
