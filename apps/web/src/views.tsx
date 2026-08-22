import { useCallback, useEffect, useRef, useState } from 'react';
import { api, fmtJst, registerPush } from './api';
import type { Approval } from './App';

// ============ 承認バナー (仕様書16: 送信先・サービス・本文 + 修正/送信/キャンセル) ============
export function ApprovalBanner({ approval, onDone }: { approval: Approval; onDone: () => void }) {
  const input = approval.payload.input as Record<string, unknown>;
  const tool = approval.payload.tool;
  const isMessage = tool === 'message.send' || tool === 'mail.send';

  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(String(input.body ?? ''));
  const [inputJson, setInputJson] = useState(() => JSON.stringify(input, null, 2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const respond = async (action: 'approve' | 'reject') => {
    setBusy(true);
    setError('');
    try {
      let editedInput: Record<string, unknown> | undefined;
      if (action === 'approve' && editing) {
        // メッセージは本文だけ差し替え、それ以外はJSONをそのまま使う
        editedInput = isMessage ? { ...input, body } : (JSON.parse(inputJson) as Record<string, unknown>);
      }
      await api.post(`/approvals/${approval.id}/respond`, { action, editedInput });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : '失敗しました');
    } finally {
      setBusy(false);
    }
  };

  const serviceLabel =
    tool === 'mail.send' ? 'メール' : input.channel === 'line' ? 'LINE' : input.channel === 'slack' ? 'Slack' : '';

  return (
    <div className="card approval">
      <h3>
        確認してください{' '}
        <span className={`pill ${approval.payload.riskLabel === 'high' ? 'fail' : 'warn'}`}>
          {approval.payload.riskLabel === 'high' ? '重要' : '確認'}
        </span>
      </h3>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>{approval.title}</div>

      {isMessage ? (
        <div className="approval-detail">
          <div className="row">
            <span className="label">送信先</span>
            <span className="grow">{String(input.recipient_name ?? input.to ?? '')}</span>
          </div>
          {serviceLabel && (
            <div className="row">
              <span className="label">手段</span>
              <span className="grow">{serviceLabel}</span>
            </div>
          )}
          {Boolean(input.subject) && (
            <div className="row">
              <span className="label">件名</span>
              <span className="grow">{String(input.subject)}</span>
            </div>
          )}
          <div className="label" style={{ marginTop: 6 }}>
            本文
          </div>
          {editing ? (
            <textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} autoFocus />
          ) : (
            <div className="message-body">{body}</div>
          )}
          <div className="meta">送信すると取り消せません</div>
        </div>
      ) : editing ? (
        <textarea rows={5} value={inputJson} onChange={(e) => setInputJson(e.target.value)} />
      ) : (
        <pre className="approval-json">{JSON.stringify(input, null, 1)}</pre>
      )}

      <div className="actions">
        <button className="btn sm" disabled={busy} onClick={() => void respond('approve')}>
          送信
        </button>
        <button className="btn sm secondary" disabled={busy} onClick={() => setEditing(!editing)}>
          {editing ? '編集をやめる' : '修正'}
        </button>
        <button className="btn sm danger" disabled={busy} onClick={() => void respond('reject')}>
          キャンセル
        </button>
      </div>
      <div className="meta">{fmtJst(approval.createdAt)}</div>
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}

// ============ Chat ============
interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export function ChatView() {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [conversationId, setConversationId] = useState<string | undefined>(() => {
    return sessionStorage.getItem('aide.conversationId') ?? undefined;
  });
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!conversationId) return;
    api
      .get<ChatMsg[]>(`/conversations/${conversationId}/messages`)
      .then(setMsgs)
      .catch(() => setMsgs([]));
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [msgs]);

  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setText('');
    setBusy(true);
    setMsgs((m) => [...m, { role: 'user', content: t, createdAt: new Date().toISOString() }]);
    try {
      const res = await api.post<{ reply: string; conversationId: string }>('/chat', {
        text: t,
        conversationId,
        source: /iPhone|Android/i.test(navigator.userAgent) ? 'mobile' : 'web',
      });
      setConversationId(res.conversationId);
      sessionStorage.setItem('aide.conversationId', res.conversationId);
      setMsgs((m) => [...m, { role: 'assistant', content: res.reply, createdAt: new Date().toISOString() }]);
    } catch (err) {
      setMsgs((m) => [
        ...m,
        {
          role: 'assistant',
          content: `エラー: ${err instanceof Error ? err.message : '送信に失敗しました'}`,
          createdAt: new Date().toISOString(),
        },
      ]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="chat">
        {msgs.length === 0 && (
          <div className="empty">
            「寝室の電気つけて」「19時に帰るから快適にしといて」
            <br />
            のように話しかけてください
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.content}
            <span className="time">{fmtJst(m.createdAt)}</span>
          </div>
        ))}
        {busy && <div className="msg assistant">考えています...</div>}
        <div ref={bottomRef} />
        <div className="chat-pad" />
      </div>
      <div className="chat-input">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) void send();
          }}
          placeholder="メッセージを入力..."
          enterKeyHint="send"
        />
        <button className="btn" onClick={() => void send()} disabled={busy || !text.trim()}>
          送信
        </button>
      </div>
    </>
  );
}

// ============ Home ============
interface HaStateRow {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
}
interface DeviceRow {
  id: string;
  entityId: string;
  name: string;
  room: string | null;
  type: string;
}

export function HomeView() {
  const [data, setData] = useState<{ configured: boolean; error: string | null; devices: DeviceRow[]; states: HaStateRow[] } | null>(null);
  const [busyId, setBusyId] = useState('');

  const refresh = useCallback(async () => {
    try {
      setData(await api.get('/home'));
    } catch {
      /* noop */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 20_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (!data) return <div className="empty">読み込み中...</div>;
  if (!data.configured || data.error) {
    return (
      <div className="card">
        <h3>Home Assistant未接続</h3>
        <div className="meta">{data.error ?? 'HA_BASE_URL / HA_TOKEN を設定してください (docs/setup.md)'}</div>
      </div>
    );
  }

  const stateOf = (entityId: string) => data.states.find((s) => s.entity_id === entityId);
  const rooms = [...new Set(data.devices.map((d) => d.room ?? 'その他'))];

  const toggle = async (d: DeviceRow, on: boolean) => {
    setBusyId(d.id);
    try {
      await api.post('/home/execute', { entityId: d.entityId, service: on ? 'turn_on' : 'turn_off' });
      setTimeout(() => void refresh(), 800);
    } finally {
      setBusyId('');
    }
  };

  const setTemp = async (d: DeviceRow, delta: number) => {
    const st = stateOf(d.entityId);
    const current = Number(st?.attributes.temperature ?? 25);
    setBusyId(d.id);
    try {
      await api.post('/home/execute', {
        entityId: d.entityId,
        service: 'set_temperature',
        data: { temperature: current + delta },
      });
      setTimeout(() => void refresh(), 800);
    } finally {
      setBusyId('');
    }
  };

  return (
    <>
      {data.devices.length === 0 && (
        <div className="card">
          <h3>デバイス未登録</h3>
          <div className="meta">
            設定タブ→デバイス登録から、Home Assistantのentity_idと日本語名を登録すると音声・チャットで操作できます。
          </div>
        </div>
      )}
      {rooms.map((room) => (
        <div key={room}>
          <h2 className="section">{room}</h2>
          {data.devices
            .filter((d) => (d.room ?? 'その他') === room)
            .map((d) => {
              const st = stateOf(d.entityId);
              const isOn = st ? !['off', 'unavailable', 'standby', 'unknown'].includes(st.state) : false;
              return (
                <div key={d.id} className="card row">
                  <div className="grow">
                    <h3>{d.name}</h3>
                    <div className="meta">
                      {st ? st.state : '状態不明'}
                      {d.type === 'climate' && st?.attributes.temperature != null && (
                        <> ・設定 {String(st.attributes.temperature)}℃</>
                      )}
                      {d.type === 'climate' && st?.attributes.current_temperature != null && (
                        <> ・室温 {String(st.attributes.current_temperature)}℃</>
                      )}
                    </div>
                  </div>
                  {d.type === 'climate' && isOn && (
                    <>
                      <button className="btn sm secondary" disabled={busyId === d.id} onClick={() => void setTemp(d, -1)}>
                        −
                      </button>
                      <button className="btn sm secondary" disabled={busyId === d.id} onClick={() => void setTemp(d, 1)}>
                        ＋
                      </button>
                    </>
                  )}
                  <label className="switch">
                    <input type="checkbox" checked={isOn} disabled={busyId === d.id} onChange={(e) => void toggle(d, e.target.checked)} />
                    <span className="track" />
                  </label>
                </div>
              );
            })}
        </div>
      ))}
    </>
  );
}

// ============ Tasks ============
interface TaskRow {
  id: string;
  title: string;
  runAt: string;
  status: string;
  reevaluate: number;
}

export function TasksView() {
  const [rows, setRows] = useState<TaskRow[]>([]);

  const refresh = useCallback(async () => {
    try {
      setRows(await api.get('/tasks'));
    } catch {
      /* noop */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  const cancel = async (id: string) => {
    await api.post(`/tasks/${id}/cancel`);
    void refresh();
  };

  const statusPill = (s: string) =>
    s === 'scheduled' ? 'warn' : s === 'done' ? 'ok' : s === 'failed' ? 'fail' : '';

  return (
    <>
      {rows.length === 0 && <div className="empty">予約タスクはありません</div>}
      {rows.map((t) => (
        <div key={t.id} className="card row">
          <div className="grow">
            <h3>{t.title}</h3>
            <div className="meta">
              {fmtJst(t.runAt)} 実行予定
              {t.reevaluate === 1 && ' ・実行前に状況再確認'}
            </div>
          </div>
          <span className={`pill ${statusPill(t.status)}`}>{t.status}</span>
          {(t.status === 'scheduled' || t.status === 'running') && (
            <button className="btn sm danger" onClick={() => void cancel(t.id)}>
              取消
            </button>
          )}
        </div>
      ))}
    </>
  );
}

// ============ History ============
interface ActionRow {
  id: string;
  tool: string;
  operation: string | null;
  target: string | null;
  status: string;
  resultSummary: string | null;
  undoAvailable: number;
  error: string | null;
  source: string;
  createdAt: string;
}

export function HistoryView() {
  const [rows, setRows] = useState<ActionRow[]>([]);
  const [msg, setMsg] = useState('');

  const refresh = useCallback(async () => {
    try {
      setRows(await api.get('/actions?limit=100'));
    } catch {
      /* noop */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const undo = async (id: string) => {
    try {
      const r = await api.post<{ ok: boolean; message: string }>(`/actions/${id}/undo`);
      setMsg(r.message);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '失敗しました');
    }
    void refresh();
  };

  return (
    <>
      {msg && (
        <div className="card">
          <div className="meta">{msg}</div>
        </div>
      )}
      {rows.length === 0 && <div className="empty">履歴はまだありません</div>}
      {rows.map((a) => (
        <div key={a.id} className="card row">
          <div className="grow">
            <h3>
              {a.tool}
              {a.operation ? `.${a.operation}` : ''}
            </h3>
            <div className="meta">
              {a.resultSummary ?? a.error ?? a.target ?? ''}
              <br />
              {fmtJst(a.createdAt)} ・{a.source}
            </div>
          </div>
          <span className={`pill ${a.status === 'success' ? 'ok' : a.status === 'failed' ? 'fail' : 'warn'}`}>
            {a.status === 'success' ? '成功' : a.status === 'failed' ? '失敗' : a.status}
          </span>
          {a.undoAvailable === 1 && (
            <button className="btn sm secondary" onClick={() => void undo(a.id)}>
              元に戻す
            </button>
          )}
        </div>
      ))}
    </>
  );
}

// ============ Memory ============
interface MemoryRowUi {
  id: string;
  kind: string;
  title: string;
  content: string;
  updatedAt: string;
}

export function MemoryView() {
  const [rows, setRows] = useState<MemoryRowUi[]>([]);
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const [editId, setEditId] = useState('');
  const [editContent, setEditContent] = useState('');

  const refresh = useCallback(async () => {
    const path = q ? `/memories?q=${encodeURIComponent(q)}` : kind ? `/memories?kind=${kind}` : '/memories';
    try {
      setRows(await api.get(path));
    } catch {
      /* noop */
    }
  }, [kind, q]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async (id: string) => {
    await api.patch(`/memories/${id}`, { content: editContent });
    setEditId('');
    void refresh();
  };

  const remove = async (id: string) => {
    await api.del(`/memories/${id}`);
    void refresh();
  };

  const kindLabel: Record<string, string> = {
    preference: '好み',
    memory: '記憶',
    decision: '決定',
    imported: 'インポート',
  };

  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <input placeholder="検索..." value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: 130 }}>
          <option value="">すべて</option>
          <option value="preference">好み</option>
          <option value="memory">記憶</option>
          <option value="decision">決定</option>
          <option value="imported">インポート</option>
        </select>
      </div>
      {rows.length === 0 && <div className="empty">記憶はまだありません</div>}
      {rows.map((m) => (
        <div key={m.id} className="card">
          <div className="row">
            <div className="grow">
              <h3>
                {m.title} <span className="pill">{kindLabel[m.kind] ?? m.kind}</span>
              </h3>
            </div>
            <button
              className="btn sm secondary"
              onClick={() => {
                setEditId(m.id);
                setEditContent(m.content);
              }}
            >
              編集
            </button>
            <button className="btn sm danger" onClick={() => void remove(m.id)}>
              削除
            </button>
          </div>
          {editId === m.id ? (
            <>
              <textarea rows={4} value={editContent} onChange={(e) => setEditContent(e.target.value)} />
              <div className="row" style={{ marginTop: 6 }}>
                <button className="btn sm" onClick={() => void save(m.id)}>
                  保存
                </button>
                <button className="btn sm secondary" onClick={() => setEditId('')}>
                  取消
                </button>
              </div>
            </>
          ) : (
            <div style={{ fontSize: 13.5, whiteSpace: 'pre-wrap' }}>{m.content.slice(0, 400)}</div>
          )}
          <div className="meta">{fmtJst(m.updatedAt)}</div>
        </div>
      ))}
    </>
  );
}

// ============ Settings ============
interface PermissionRow {
  category: string;
  mode: string;
  grantedOnce: boolean;
}

const CATEGORY_LABELS: Record<string, string> = {
  payment: '決済',
  purchase: '商品購入',
  subscription: '有料契約',
  money_transfer: '送金',
  account_delete: 'アカウント削除',
  mass_delete: '大量削除',
  destructive: '破壊的操作',
  security_change: 'セキュリティ変更',
  messaging_send: 'メッセージ送信',
  mail_send: 'メール送信',
  mac_shell: 'Mac shell操作',
  mac_gui: 'Mac GUI操作',
  home_control: '家電操作',
  memory: '記憶の読み書き',
  tasks: '予約タスク',
  calendar_write: 'カレンダー変更',
  notification: '通知送信',
  web: 'Web閲覧',
  system: 'システム情報',
};

function ConnectionsSection() {
  const [google, setGoogle] = useState<{ connected: boolean; email?: string } | null>(null);
  const [msg, setMsg] = useState<{ line: boolean; slack: boolean; slackDefaultTo?: string } | null>(null);
  const [creds, setCreds] = useState({ clientId: '', clientSecret: '' });
  const [line, setLine] = useState({ lineToken: '', lineDefaultTo: '' });
  const [slack, setSlack] = useState({ slackToken: '', slackDefaultTo: '' });
  const [note, setNote] = useState('');

  const refresh = useCallback(async () => {
    try {
      setGoogle(await api.get('/google/status'));
      setMsg(await api.get('/messaging/status'));
    } catch {
      /* noop */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connectGoogle = async () => {
    setNote('');
    try {
      if (creds.clientId && creds.clientSecret) {
        await api.post('/google/credentials', creds);
      }
      const { url } = await api.get<{ url: string }>('/google/auth-url');
      // 同意画面へ移動 (完了後 /api/google/callback に戻る)
      location.href = url;
    } catch (err) {
      setNote(err instanceof Error ? err.message : '接続に失敗しました');
    }
  };

  const saveMessaging = async (patch: Record<string, string>) => {
    setNote('');
    try {
      await api.post('/messaging/config', patch);
      setLine({ lineToken: '', lineDefaultTo: line.lineDefaultTo });
      setSlack({ slackToken: '', slackDefaultTo: slack.slackDefaultTo });
      setNote('保存しました');
      void refresh();
    } catch (err) {
      setNote(err instanceof Error ? err.message : '保存に失敗しました');
    }
  };

  return (
    <>
      <h2 className="section">外部サービス連携</h2>

      <div className="card">
        <div className="row">
          <div className="grow">
            <h3>Google (カレンダー・Gmail・連絡先)</h3>
            <div className={`conn-status ${google?.connected ? 'on' : 'off'}`}>
              {google?.connected ? `接続済み ${google.email ?? ''}` : '未接続'}
            </div>
          </div>
          {google?.connected && (
            <button
              className="btn sm danger"
              onClick={() => api.post('/google/disconnect').then(refresh)}
            >
              解除
            </button>
          )}
        </div>
        {!google?.connected && (
          <>
            <div className="meta" style={{ marginTop: 8 }}>
              Google Cloud ConsoleでOAuthクライアント(ウェブアプリ)を作り、IDとシークレットを入力してください。
              リダイレクトURIは下のURLをそのまま登録します。
            </div>
            <div className="message-body" style={{ fontSize: 12.5 }}>{`${location.origin}/api/google/callback`}</div>
            <label className="field" style={{ marginTop: 8 }}>
              <span>クライアントID</span>
              <input
                value={creds.clientId}
                onChange={(e) => setCreds({ ...creds, clientId: e.target.value })}
                placeholder="xxxxx.apps.googleusercontent.com"
              />
            </label>
            <label className="field">
              <span>クライアントシークレット</span>
              <input
                type="password"
                value={creds.clientSecret}
                onChange={(e) => setCreds({ ...creds, clientSecret: e.target.value })}
              />
            </label>
            <button className="btn sm" onClick={() => void connectGoogle()}>
              Googleと連携する
            </button>
          </>
        )}
      </div>

      <div className="card">
        <h3>
          LINE <span className={`conn-status ${msg?.line ? 'on' : 'off'}`}>{msg?.line ? '接続済み' : '未接続'}</span>
        </h3>
        <div className="meta">
          LINE Developersで Messaging API チャネルを作り、チャネルアクセストークンを入力します。
        </div>
        <label className="field" style={{ marginTop: 8 }}>
          <span>チャネルアクセストークン{msg?.line ? ' (変更する場合のみ)' : ''}</span>
          <input
            type="password"
            value={line.lineToken}
            onChange={(e) => setLine({ ...line, lineToken: e.target.value })}
          />
        </label>
        <label className="field">
          <span>既定の送信先 (自分のuserId)</span>
          <input
            value={line.lineDefaultTo}
            onChange={(e) => setLine({ ...line, lineDefaultTo: e.target.value })}
            placeholder="Uxxxxxxxx"
          />
        </label>
        <div className="row">
          <button
            className="btn sm"
            onClick={() =>
              void saveMessaging(
                line.lineToken ? line : { lineDefaultTo: line.lineDefaultTo },
              )
            }
          >
            保存
          </button>
          {msg?.line && (
            <button className="btn sm danger" onClick={() => void saveMessaging({ lineToken: '' })}>
              解除
            </button>
          )}
        </div>
      </div>

      <div className="card">
        <h3>
          Slack <span className={`conn-status ${msg?.slack ? 'on' : 'off'}`}>{msg?.slack ? '接続済み' : '未接続'}</span>
        </h3>
        <div className="meta">Slack Appを作り、Bot User OAuth Token (xoxb-) を入力します。</div>
        <label className="field" style={{ marginTop: 8 }}>
          <span>Bot Token{msg?.slack ? ' (変更する場合のみ)' : ''}</span>
          <input
            type="password"
            value={slack.slackToken}
            onChange={(e) => setSlack({ ...slack, slackToken: e.target.value })}
            placeholder="xoxb-..."
          />
        </label>
        <label className="field">
          <span>既定の送信先チャンネル</span>
          <input
            value={slack.slackDefaultTo || (msg?.slackDefaultTo ?? '')}
            onChange={(e) => setSlack({ ...slack, slackDefaultTo: e.target.value })}
            placeholder="#general"
          />
        </label>
        <div className="row">
          <button
            className="btn sm"
            onClick={() =>
              void saveMessaging(
                slack.slackToken ? slack : { slackDefaultTo: slack.slackDefaultTo },
              )
            }
          >
            保存
          </button>
          {msg?.slack && (
            <button className="btn sm danger" onClick={() => void saveMessaging({ slackToken: '' })}>
              解除
            </button>
          )}
        </div>
      </div>

      {note && <div className="meta">{note}</div>}
    </>
  );
}

function DeviceRowEditor({ device, onChanged }: { device: DeviceRow; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(device.name);
  const [room, setRoom] = useState(device.room ?? '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/devices/${device.id}`, { name, room: room.trim() || null });
      setEditing(false);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <div className="row" style={{ marginBottom: 6 }}>
        <div className="grow">
          <b>{device.name}</b>{' '}
          <span className="meta">
            {device.room ?? '部屋未設定'} / {device.type} / {device.entityId}
          </span>
        </div>
        <button className="btn sm secondary" onClick={() => setEditing(true)}>
          編集
        </button>
        <button className="btn sm danger" onClick={() => api.del(`/devices/${device.id}`).then(onChanged)}>
          削除
        </button>
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 10, paddingBottom: 10, borderBottom: '1px solid var(--border)' }}>
      <label className="field">
        <span>名前</span>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span>部屋 (空欄で未設定)</span>
        <input value={room} onChange={(e) => setRoom(e.target.value)} placeholder="例: 寝室" />
      </label>
      <div className="row">
        <button className="btn sm" disabled={busy} onClick={() => void save()}>
          保存
        </button>
        <button
          className="btn sm secondary"
          onClick={() => {
            setName(device.name);
            setRoom(device.room ?? '');
            setEditing(false);
          }}
        >
          取消
        </button>
      </div>
    </div>
  );
}

export function SettingsView() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [perms, setPerms] = useState<PermissionRow[]>([]);
  const [pushMsg, setPushMsg] = useState('');
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [newDevice, setNewDevice] = useState({ entityId: '', name: '', room: '', type: 'light' });

  const refresh = useCallback(async () => {
    try {
      setSettings(await api.get('/settings'));
      setPerms(await api.get('/permissions'));
      setDevices(await api.get('/devices'));
    } catch {
      /* noop */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setSetting = async (key: string, value: string) => {
    setSettings((s) => ({ ...s, [key]: value }));
    await api.put('/settings', { [key]: value });
  };

  const setPerm = async (category: string, mode: string) => {
    setPerms(await api.patch(`/permissions/${category}`, { mode }));
  };

  const addDevice = async () => {
    if (!newDevice.entityId || !newDevice.name) return;
    await api.post('/devices', { ...newDevice, room: newDevice.room || null });
    setNewDevice({ entityId: '', name: '', room: '', type: 'light' });
    void refresh();
  };

  const sel = (key: string, options: Array<[string, string]>) => (
    <label className="field" key={key}>
      <span>{key}</span>
      <select value={settings[key] ?? ''} onChange={(e) => void setSetting(key, e.target.value)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <>
      <h2 className="section">通知</h2>
      <div className="card">
        {sel('notifications.level', [
          ['all', 'すべて通知'],
          ['important', '重要のみ'],
          ['failure', '失敗のみ'],
          ['none', '通知なし'],
        ])}
        <button className="btn sm" onClick={() => registerPush().then(setPushMsg)}>
          このデバイスでプッシュ通知を有効化
        </button>
        {pushMsg && <div className="meta">{pushMsg}</div>}
      </div>

      <h2 className="section">AI</h2>
      <div className="card">
        {sel('ai.provider', [
          ['auto', '自動 (Claude CLI → Mac Agent経由)'],
          ['claude-cli-local', 'Claude Code CLI (ローカル)'],
          ['claude-via-mac', 'Claude (Mac Agent経由)'],
          ['anthropic-api', 'Anthropic API (有料)'],
        ])}
        {sel('ai.paid_api_fallback', [
          ['off', '有料APIフォールバック: OFF'],
          ['on', '有料APIフォールバック: ON'],
        ])}
        {sel('learning.enabled', [
          ['on', '好みの学習: ON'],
          ['off', '好みの学習: OFF'],
        ])}
        {sel('memory.retention', [
          ['unlimited', '記憶の保存: 無期限'],
          ['30d', '30日'],
          ['90d', '90日'],
          ['1y', '1年'],
        ])}
      </div>

      <h2 className="section">Alexa / ホーム</h2>
      <div className="card">
        {sel('alexa.verbosity', [
          ['short', 'Alexa応答: 短く'],
          ['standard', '標準'],
          ['detailed', '詳しく'],
          ['full', '全文'],
        ])}
        <label className="field">
          <span>router.default_room (部屋省略時の既定)</span>
          <input
            value={settings['router.default_room'] ?? ''}
            onChange={(e) => setSettings((s) => ({ ...s, 'router.default_room': e.target.value }))}
            onBlur={(e) => void setSetting('router.default_room', e.target.value)}
            placeholder="例: リビング"
          />
        </label>
        <label className="field">
          <span>home.location (天気用 緯度,経度)</span>
          <input
            value={settings['home.location'] ?? ''}
            onChange={(e) => setSettings((s) => ({ ...s, 'home.location': e.target.value }))}
            onBlur={(e) => void setSetting('home.location', e.target.value)}
            placeholder="例: 35.68,139.76"
          />
        </label>
      </div>

      <h2 className="section">Mac</h2>
      <div className="card">
        {sel('mac.busy_mode', [
          ['auto', '使用中判定: 自動 (入力アイドル)'],
          ['busy', '常に使用中扱い (GUIキュー)'],
          ['free', 'AI操作可能'],
        ])}
      </div>

      <ConnectionsSection />

      <h2 className="section">権限 (Permissions)</h2>
      <div className="card">
        {perms.map((p) => (
          <label className="field" key={p.category}>
            <span>
              {CATEGORY_LABELS[p.category] ?? p.category}
              {p.grantedOnce && ' (初回許可済み)'}
            </span>
            <select value={p.mode} onChange={(e) => void setPerm(p.category, e.target.value)}>
              <option value="always_allow">常に許可</option>
              <option value="ask_once">初回のみ確認</option>
              <option value="always_ask">毎回確認</option>
              <option value="deny">禁止</option>
            </select>
          </label>
        ))}
      </div>

      <h2 className="section">デバイス登録</h2>
      <div className="card">
        {devices.map((d) => (
          <DeviceRowEditor key={d.id} device={d} onChanged={refresh} />
        ))}
        <label className="field">
          <span>entity_id (Home Assistant)</span>
          <input value={newDevice.entityId} onChange={(e) => setNewDevice({ ...newDevice, entityId: e.target.value })} placeholder="light.bedroom" />
        </label>
        <label className="field">
          <span>名前 (日本語)</span>
          <input value={newDevice.name} onChange={(e) => setNewDevice({ ...newDevice, name: e.target.value })} placeholder="寝室の照明" />
        </label>
        <div className="row">
          <input value={newDevice.room} onChange={(e) => setNewDevice({ ...newDevice, room: e.target.value })} placeholder="部屋 (例: 寝室)" />
          <select value={newDevice.type} onChange={(e) => setNewDevice({ ...newDevice, type: e.target.value })} style={{ width: 140 }}>
            <option value="light">照明</option>
            <option value="climate">エアコン</option>
            <option value="tv">テレビ</option>
            <option value="switch">スイッチ</option>
            <option value="sensor">センサー</option>
          </select>
        </div>
        <button className="btn sm" style={{ marginTop: 8 }} onClick={() => void addDevice()}>
          追加
        </button>
      </div>

      <h2 className="section">セッション</h2>
      <div className="card">
        <button
          className="btn sm secondary"
          onClick={() => api.post('/auth/logout').then(() => location.reload())}
        >
          ログアウト
        </button>
      </div>
    </>
  );
}
