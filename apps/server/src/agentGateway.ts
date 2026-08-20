// Mac Agent との常時接続ハブ。
// Mac側からのOutbound WebSocket接続のみを受け付ける (自宅のポート開放不要)。
// 認証: 接続時の Authorization: Bearer <AGENT_TOKEN> (定数時間比較)

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuid } from 'uuid';
import type { AgentMessage, AgentRpcMethod, AgentStatusPush } from '@aide/shared';

interface PendingCall {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class AgentGateway {
  private wss: WebSocketServer;
  private conn: WebSocket | null = null;
  private pending = new Map<string, PendingCall>();
  private lastStatus: AgentStatusPush | null = null;
  private lastSeenAt: number | null = null;

  constructor(private token: string) {
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on('connection', (ws) => this.onConnection(ws));
  }

  /** HTTPサーバーのupgradeイベントから呼ぶ */
  handleUpgrade(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
    const auth = req.headers.authorization ?? '';
    const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!this.token || !safeEqual(presented, this.token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req);
    });
  }

  private onConnection(ws: WebSocket): void {
    // 単一Agent前提: 新接続が来たら旧接続を閉じる (再接続時の重複防止)
    if (this.conn && this.conn.readyState === WebSocket.OPEN) {
      this.conn.close(4000, 'replaced');
    }
    this.conn = ws;
    this.lastSeenAt = Date.now();
    console.log('[agent] Mac Agent接続');

    ws.on('message', (raw) => {
      this.lastSeenAt = Date.now();
      let msg: AgentMessage;
      try {
        msg = JSON.parse(String(raw)) as AgentMessage;
      } catch {
        return;
      }
      if (msg.type === 'rpc_result') {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg.result);
          else p.reject(new Error(msg.error ?? 'agent error'));
        }
      } else if (msg.type === 'status') {
        this.lastStatus = msg;
      } else if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    });

    ws.on('close', () => {
      if (this.conn === ws) this.conn = null;
      console.log('[agent] Mac Agent切断');
    });
    ws.on('error', () => {
      /* closeで処理 */
    });
  }

  connected(): boolean {
    return this.conn !== null && this.conn.readyState === WebSocket.OPEN;
  }

  status(): { connected: boolean; lastSeenAt: number | null; agent: AgentStatusPush | null } {
    return { connected: this.connected(), lastSeenAt: this.lastSeenAt, agent: this.lastStatus };
  }

  async call<T = unknown>(method: AgentRpcMethod, params: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    const ws = this.conn;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('Mac Agentが接続されていません');
    }
    const id = uuid();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Mac Agentの応答がタイムアウトしました'));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ type: 'rpc', id, method, params }));
    });
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
