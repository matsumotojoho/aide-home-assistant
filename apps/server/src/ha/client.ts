// Home Assistant REST APIクライアント。
// 到達経路は2通り:
//  - direct: サーバーがHAと同一LAN (Mac miniローカル実行時)
//  - proxy : Railway等の外部実行時、Mac Agent経由でLAN内のHAへ中継
// AI側はhome.get_state / home.executeだけを意識し、経路は自動選択される。

export interface HaState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed?: string;
}

export type HaProxy = (params: {
  method: string;
  path: string;
  body?: unknown;
}) => Promise<{ status: number; body: unknown }>;

/**
 * HTTPステータスをユーザー向けの平易な日本語にする (仕様書34: Stack Trace/生エラーを返さない)。
 * 技術的な詳細は message ではなく detail に保持し、サーバーログ側で参照する。
 */
export class HaRequestError extends Error {
  constructor(
    public status: number,
    public detail: string,
    public path: string,
  ) {
    super(HaRequestError.userMessage(status));
    this.name = 'HaRequestError';
  }

  static userMessage(status: number): string {
    if (status === 401 || status === 403) return 'Home Assistantの認証に失敗しました。トークンを再設定してください';
    if (status === 404) return 'その機器が見つかりませんでした';
    if (status >= 500) {
      // HAは機器がオフライン等で操作できない場合も500を返す
      return '機器が応答しませんでした。電源が入っているか、ネットワークに繋がっているか確認してください';
    }
    return '操作を実行できませんでした';
  }
}

export class HomeAssistantClient {
  constructor(
    private baseUrl: string,
    private token: string,
    private proxy?: () => HaProxy | null,
  ) {}

  configured(): boolean {
    return Boolean(this.baseUrl && this.token) || Boolean(this.proxy?.());
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    // 直接アクセスできる設定があれば優先、なければMac Agentプロキシ
    if (this.baseUrl && this.token) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: ctrl.signal,
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          throw new HaRequestError(res.status, detail, path);
        }
        return await res.json().catch(() => ({}));
      } finally {
        clearTimeout(timer);
      }
    }
    const proxyFn = this.proxy?.();
    if (proxyFn) {
      const { status, body: resBody } = await proxyFn({ method, path, body });
      if (status < 200 || status >= 300) {
        throw new HaRequestError(status, JSON.stringify(resBody).slice(0, 300), path);
      }
      return resBody;
    }
    throw new Error('Home Assistantが未設定です (HA_BASE_URL/HA_TOKEN またはMac Agent接続が必要)');
  }

  async getStates(): Promise<HaState[]> {
    return (await this.request('GET', '/api/states')) as HaState[];
  }

  async getState(entityId: string): Promise<HaState | null> {
    try {
      return (await this.request('GET', `/api/states/${entityId}`)) as HaState;
    } catch {
      return null;
    }
  }

  async callService(domain: string, service: string, data: Record<string, unknown>): Promise<unknown> {
    return this.request('POST', `/api/services/${domain}/${service}`, data);
  }
}
