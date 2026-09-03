// Alexaアカウントリンク用のOAuth2 認可サーバー。
//
// Alexaのスマートホームスキルは「Alexaユーザー ↔ このシステムのユーザー」を
// 結ぶためにOAuth2を要求する。単一ユーザー運用なので、
// ログイン済みであれば即座に認可コードを発行する形にしている。
//
// 発行するのはこのシステム専用のトークンで、他サービスの認証情報は一切扱わない。

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/index.js';

const CODE_TTL_MS = 10 * 60_000;
const ACCESS_TTL_MS = 60 * 60_000;

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
}

interface TokenRow {
  token: string;
  user_id: string;
  kind: string;
  expires_at: string | null;
}

/** トークンは平文で持たず、ハッシュで保存する (DB流出時の被害を抑える) */
function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export class AlexaOAuth {
  constructor(private db: Db, private config: OAuthConfig) {}

  configured(): boolean {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  /** Alexaからのリダイレクト先が正しいか (許可するのはAmazonのドメインのみ) */
  isAllowedRedirect(uri: string): boolean {
    try {
      const u = new URL(uri);
      if (u.protocol !== 'https:') return false;
      return /(^|\.)amazon\.(com|co\.jp)$/.test(u.hostname) || /(^|\.)amazonalexa\.com$/.test(u.hostname);
    } catch {
      return false;
    }
  }

  verifyClient(clientId: string, clientSecret?: string): boolean {
    if (!this.configured()) return false;
    if (!safeEqual(clientId, this.config.clientId)) return false;
    if (clientSecret === undefined) return true;
    return safeEqual(clientSecret, this.config.clientSecret);
  }

  /** 認可コードを発行 (10分で失効、1度きり) */
  issueCode(userId: string, clientId: string, redirectUri: string): string {
    const code = randomBytes(32).toString('base64url');
    const now = new Date();
    this.db.$client
      .prepare(
        'INSERT INTO oauth_codes (code,user_id,client_id,redirect_uri,expires_at,created_at) VALUES (?,?,?,?,?,?)',
      )
      .run(
        hash(code),
        userId,
        clientId,
        redirectUri,
        new Date(now.getTime() + CODE_TTL_MS).toISOString(),
        now.toISOString(),
      );
    return code;
  }

  /** 認可コードをトークンへ交換 */
  exchangeCode(
    code: string,
    clientId: string,
    redirectUri: string,
  ): { access_token: string; refresh_token: string; expires_in: number } | null {
    const row = this.db.$client.prepare('SELECT * FROM oauth_codes WHERE code = ?').get(hash(code)) as
      | { user_id: string; client_id: string; redirect_uri: string; expires_at: string }
      | undefined;
    // 使い回しを防ぐため、見つかった時点で必ず消す
    this.db.$client.prepare('DELETE FROM oauth_codes WHERE code = ?').run(hash(code));
    if (!row) return null;
    if (row.client_id !== clientId) return null;
    if (row.redirect_uri !== redirectUri) return null;
    if (Date.parse(row.expires_at) < Date.now()) return null;
    return this.issueTokens(row.user_id);
  }

  /** リフレッシュトークンからアクセストークンを再発行 */
  refresh(refreshToken: string): { access_token: string; refresh_token: string; expires_in: number } | null {
    const row = this.db.$client
      .prepare("SELECT * FROM oauth_tokens WHERE token = ? AND kind = 'refresh'")
      .get(hash(refreshToken)) as TokenRow | undefined;
    if (!row) return null;
    // リフレッシュトークンは使い回せるようにし、アクセストークンだけ作り直す
    const access = this.newAccessToken(row.user_id);
    return { access_token: access, refresh_token: refreshToken, expires_in: ACCESS_TTL_MS / 1000 };
  }

  private issueTokens(userId: string) {
    const refresh = randomBytes(32).toString('base64url');
    this.db.$client
      .prepare('INSERT INTO oauth_tokens (token,user_id,kind,expires_at,created_at) VALUES (?,?,?,?,?)')
      .run(hash(refresh), userId, 'refresh', null, new Date().toISOString());
    const access = this.newAccessToken(userId);
    return { access_token: access, refresh_token: refresh, expires_in: ACCESS_TTL_MS / 1000 };
  }

  private newAccessToken(userId: string): string {
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    this.db.$client
      .prepare('INSERT INTO oauth_tokens (token,user_id,kind,expires_at,created_at) VALUES (?,?,?,?,?)')
      .run(
        hash(token),
        userId,
        'access',
        new Date(now.getTime() + ACCESS_TTL_MS).toISOString(),
        now.toISOString(),
      );
    // 期限切れを溜め込まない
    this.db.$client.prepare("DELETE FROM oauth_tokens WHERE kind='access' AND expires_at < ?").run(now.toISOString());
    return token;
  }

  /** アクセストークンからユーザーを引く。無効ならnull */
  verifyAccessToken(token: string): string | null {
    const row = this.db.$client
      .prepare("SELECT * FROM oauth_tokens WHERE token = ? AND kind = 'access'")
      .get(hash(token)) as TokenRow | undefined;
    if (!row) return null;
    if (row.expires_at && Date.parse(row.expires_at) < Date.now()) return null;
    this.db.$client
      .prepare('UPDATE oauth_tokens SET last_used_at = ? WHERE token = ?')
      .run(new Date().toISOString(), hash(token));
    return row.user_id;
  }

  /** 連携解除 (全トークンを失効) */
  revokeAll(userId: string): void {
    this.db.$client.prepare('DELETE FROM oauth_tokens WHERE user_id = ?').run(userId);
    this.db.$client.prepare('DELETE FROM oauth_codes WHERE user_id = ?').run(userId);
  }

  linkedCount(userId: string): number {
    const row = this.db.$client
      .prepare("SELECT count(*) c FROM oauth_tokens WHERE user_id = ? AND kind = 'refresh'")
      .get(userId) as { c: number };
    return row.c;
  }
}
