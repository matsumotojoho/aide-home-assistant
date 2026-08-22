// Google OAuth 2.0 (認可コードフロー + リフレッシュトークン)。
// 資格情報は tool_connections.config にJSONで保存し、Gitには出さない。
// スコープはユーザーが接続時に選ぶ (カレンダーだけ、メールも、など)。

import { and, eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import type { Db } from '../db/index.js';
import { toolConnections } from '../db/schema.js';

export const GOOGLE_SCOPES = {
  calendar: 'https://www.googleapis.com/auth/calendar',
  gmail_read: 'https://www.googleapis.com/auth/gmail.readonly',
  gmail_send: 'https://www.googleapis.com/auth/gmail.send',
  gmail_compose: 'https://www.googleapis.com/auth/gmail.compose',
  contacts: 'https://www.googleapis.com/auth/contacts.readonly',
} as const;

export const DEFAULT_SCOPES = [
  GOOGLE_SCOPES.calendar,
  GOOGLE_SCOPES.gmail_read,
  GOOGLE_SCOPES.gmail_compose,
  GOOGLE_SCOPES.gmail_send,
  GOOGLE_SCOPES.contacts,
  'openid',
  'email',
];

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const PROVIDER = 'google';

interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
  scopes?: string[];
  email?: string;
}

export class GoogleAuth {
  constructor(private db: Db, private userId: string, private redirectUri: string) {}

  private row() {
    return this.db
      .select()
      .from(toolConnections)
      .where(and(eq(toolConnections.userId, this.userId), eq(toolConnections.provider, PROVIDER)))
      .get();
  }

  getConfig(): GoogleConfig | null {
    const row = this.row();
    if (!row?.config) return null;
    try {
      return JSON.parse(row.config) as GoogleConfig;
    } catch {
      return null;
    }
  }

  private saveConfig(config: GoogleConfig, status: 'connected' | 'disconnected' | 'error'): void {
    const now = new Date().toISOString();
    const existing = this.row();
    if (existing) {
      this.db
        .update(toolConnections)
        .set({ config: JSON.stringify(config), status, updatedAt: now })
        .where(eq(toolConnections.id, existing.id))
        .run();
    } else {
      this.db
        .insert(toolConnections)
        .values({
          id: uuid(),
          userId: this.userId,
          provider: PROVIDER,
          status,
          config: JSON.stringify(config),
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
  }

  connected(): boolean {
    const c = this.getConfig();
    return Boolean(c?.refreshToken);
  }

  status(): { connected: boolean; email?: string; scopes?: string[] } {
    const c = this.getConfig();
    return { connected: Boolean(c?.refreshToken), email: c?.email, scopes: c?.scopes };
  }

  /** クライアント資格情報を保存 (Google Cloud Consoleで発行したもの) */
  setCredentials(clientId: string, clientSecret: string): void {
    const c = this.getConfig() ?? { clientId: '', clientSecret: '' };
    this.saveConfig({ ...c, clientId, clientSecret }, c.refreshToken ? 'connected' : 'disconnected');
  }

  /** 同意画面のURLを組み立てる */
  authUrl(state: string, scopes: string[] = DEFAULT_SCOPES): string | null {
    const c = this.getConfig();
    if (!c?.clientId) return null;
    const params = new URLSearchParams({
      client_id: c.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: scopes.join(' '),
      access_type: 'offline', // リフレッシュトークンを得るため
      prompt: 'consent',
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  /** 認可コードをトークンに交換して保存 */
  async exchangeCode(code: string): Promise<void> {
    const c = this.getConfig();
    if (!c?.clientId || !c.clientSecret) throw new Error('Googleのクライアント資格情報が未設定です');
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: c.clientId,
        client_secret: c.clientSecret,
        redirect_uri: this.redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!res.ok) {
      throw new Error('Googleとの連携に失敗しました。設定をやり直してください');
    }
    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope?: string;
      id_token?: string;
    };
    const email = data.id_token ? decodeJwtEmail(data.id_token) : undefined;
    this.saveConfig(
      {
        ...c,
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? c.refreshToken,
        expiresAt: Date.now() + data.expires_in * 1000 - 60_000,
        scopes: data.scope?.split(' '),
        email: email ?? c.email,
      },
      'connected',
    );
  }

  /** 有効なアクセストークンを返す (必要ならリフレッシュ) */
  async accessToken(): Promise<string> {
    const c = this.getConfig();
    if (!c?.refreshToken) throw new Error('Googleが未接続です');
    if (c.accessToken && c.expiresAt && Date.now() < c.expiresAt) return c.accessToken;

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: c.clientId,
        client_secret: c.clientSecret,
        refresh_token: c.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) {
      this.saveConfig({ ...c, accessToken: undefined, expiresAt: undefined }, 'error');
      throw new Error('Googleの認証が切れました。設定画面から再接続してください');
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.saveConfig(
      { ...c, accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 - 60_000 },
      'connected',
    );
    return data.access_token;
  }

  disconnect(): void {
    const c = this.getConfig();
    if (!c) return;
    // クライアント資格情報は残し、ユーザートークンだけ捨てる
    this.saveConfig(
      { clientId: c.clientId, clientSecret: c.clientSecret },
      'disconnected',
    );
  }

  /** Google APIへの認証付きリクエスト */
  async api(path: string, init: RequestInit = {}): Promise<unknown> {
    const token = await this.accessToken();
    const res = await fetch(path.startsWith('http') ? path : `https://www.googleapis.com${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`[google] ${res.status} ${path}: ${detail.slice(0, 300)}`);
      if (res.status === 401 || res.status === 403) {
        throw new Error('Googleへのアクセス権限がありません。設定画面から再接続してください');
      }
      if (res.status === 404) throw new Error('対象が見つかりませんでした');
      throw new Error('Googleとの通信に失敗しました');
    }
    return res.json().catch(() => ({}));
  }
}

function decodeJwtEmail(idToken: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8')) as {
      email?: string;
    };
    return payload.email;
  } catch {
    return undefined;
  }
}
