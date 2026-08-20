import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';
import { ChatView, HomeView, TasksView, HistoryView, MemoryView, SettingsView, ApprovalBanner } from './views';

type Tab = 'chat' | 'home' | 'tasks' | 'history' | 'memory' | 'settings';

const TABS: Array<{ id: Tab; label: string; ico: string }> = [
  { id: 'chat', label: 'チャット', ico: '💬' },
  { id: 'home', label: 'ホーム', ico: '🏠' },
  { id: 'tasks', label: 'タスク', ico: '⏰' },
  { id: 'history', label: '履歴', ico: '📋' },
  { id: 'memory', label: 'メモリ', ico: '🧠' },
  { id: 'settings', label: '設定', ico: '⚙️' },
];

export interface Approval {
  id: string;
  title: string;
  payload: { tool: string; input: Record<string, unknown>; category: string; riskLabel: string };
  createdAt: string;
}

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>('chat');
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [agentOnline, setAgentOnline] = useState(false);

  const refreshApprovals = useCallback(async () => {
    try {
      const rows = await api.get<Approval[]>('/approvals?status=pending');
      setApprovals(rows);
    } catch {
      /* 未ログイン等 */
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await api.get<{ macAgent: { connected: boolean } }>('/status');
      setAgentOnline(s.macAgent.connected);
    } catch {
      /* noop */
    }
  }, []);

  useEffect(() => {
    api
      .get('/auth/me')
      .then(() => setAuthed(true))
      .catch(() => setAuthed(false));
  }, []);

  useEffect(() => {
    if (!authed) return;
    void refreshApprovals();
    void refreshStatus();
    const t = setInterval(() => {
      void refreshApprovals();
      void refreshStatus();
    }, 30_000);
    return () => clearInterval(t);
  }, [authed, refreshApprovals, refreshStatus]);

  if (authed === null) return <div className="empty">読み込み中...</div>;
  if (!authed) return <Login onLogin={() => setAuthed(true)} />;

  return (
    <div className="app">
      <header className="topbar">
        <h1>Aide</h1>
        <span className={`status-dot ${agentOnline ? 'on' : ''}`} title="Mac Agent" />
        <span className="hint">{agentOnline ? 'Mac接続中' : 'Mac未接続'}</span>
        <div className="spacer" />
      </header>

      <main className="content">
        {approvals.map((a) => (
          <ApprovalBanner key={a.id} approval={a} onDone={refreshApprovals} />
        ))}
        {tab === 'chat' && <ChatView />}
        {tab === 'home' && <HomeView />}
        {tab === 'tasks' && <TasksView />}
        {tab === 'history' && <HistoryView />}
        {tab === 'memory' && <MemoryView />}
        {tab === 'settings' && <SettingsView />}
      </main>

      <nav className="tabbar">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
            <span className="ico">
              {t.ico}
              {t.id === 'settings' && approvals.length > 0 && <span className="badge">{approvals.length}</span>}
            </span>
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/auth/login', { password });
      onLogin();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'ログインに失敗しました');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <h1>Aide</h1>
      <p className="hint">自分専用AI生活アシスタント</p>
      <form onSubmit={submit}>
        <input
          type="password"
          placeholder="パスワード"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
        />
        <button className="btn" disabled={busy || !password}>
          ログイン
        </button>
        {error && <div className="error-text">{error}</div>}
      </form>
    </div>
  );
}
