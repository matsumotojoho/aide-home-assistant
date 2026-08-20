// 認証: 単一ユーザーのパスワードログイン + 署名付きセッションCookie。
// 外部公開Webアプリのため認証必須 (仕様書25)。DBは将来のマルチユーザーに対応済み。
// Google OAuthはPhase 2以降の選択肢 (docs/architecture.md参照)。

import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import type { Context, Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

const COOKIE_NAME = 'aide_session';
const SESSION_DAYS = 30;

export class AuthService {
  private secret: Uint8Array;

  constructor(
    secretString: string,
    private passwordHash: string,
    private isProd: boolean,
  ) {
    this.secret = new TextEncoder().encode(secretString);
  }

  async verifyPassword(password: string): Promise<boolean> {
    if (!this.passwordHash) return false;
    return bcrypt.compare(password, this.passwordHash);
  }

  async issueSession(c: Context, userId: string): Promise<void> {
    const token = await new SignJWT({ sub: userId })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(`${SESSION_DAYS}d`)
      .sign(this.secret);
    setCookie(c, COOKIE_NAME, token, {
      httpOnly: true,
      secure: this.isProd,
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_DAYS * 86400,
    });
  }

  clearSession(c: Context): void {
    deleteCookie(c, COOKIE_NAME, { path: '/' });
  }

  async verifySession(c: Context): Promise<string | null> {
    const token = getCookie(c, COOKIE_NAME);
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, this.secret);
      return typeof payload.sub === 'string' ? payload.sub : null;
    } catch {
      return null;
    }
  }

  middleware() {
    return async (c: Context, next: Next) => {
      const userId = await this.verifySession(c);
      if (!userId) {
        return c.json({ error: 'unauthorized' }, 401);
      }
      c.set('userId', userId);
      await next();
    };
  }
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}
