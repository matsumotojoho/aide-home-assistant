// APIクライアント (Cookieセッション)
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(res.status, String(data.error ?? `HTTP ${res.status}`));
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

export function fmtJst(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export async function registerPush(): Promise<string> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return 'このブラウザはWeb Push非対応です';
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return '通知が許可されませんでした';
  const reg = await navigator.serviceWorker.ready;
  const { key } = await api.get<{ key: string }>('/push/vapid-public-key');
  if (!key) return 'サーバーのVAPIDキーが未設定です';
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(key),
  });
  await api.post('/push/subscribe', sub.toJSON());
  return '通知を有効化しました';
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
