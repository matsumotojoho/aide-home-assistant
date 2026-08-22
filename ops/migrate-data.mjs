#!/usr/bin/env node
// Aideのユーザーデータを別インスタンスへ移す (ローカル → Railway など)。
// APIを経由するので、DBの形式やホスティング先に依存しない。
//
// 使い方:
//   node ops/migrate-data.mjs <source-url> <target-url> <password>
//
// 移すもの: デバイス登録 / 設定 / 権限 / 記憶
// 移さないもの: 会話履歴 (量が多く、移行の主目的ではない)。必要なら --with-conversations を付ける。

const [, , sourceUrl, targetUrl, password, ...flags] = process.argv;
if (!sourceUrl || !targetUrl || !password) {
  console.error('使い方: node ops/migrate-data.mjs <source-url> <target-url> <password> [--with-conversations]');
  process.exit(1);
}
const withConversations = flags.includes('--with-conversations');

async function login(base) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw new Error(`${base} へのログインに失敗しました (${res.status})`);
  const cookie = res.headers.getSetCookie?.().join('; ') ?? res.headers.get('set-cookie') ?? '';
  if (!cookie) throw new Error(`${base} からセッションCookieを取得できませんでした`);
  return cookie;
}

const call = (base, cookie) => async (method, path, body) => {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} が失敗 (${res.status}): ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
};

const main = async () => {
  console.log(`移行元: ${sourceUrl}`);
  console.log(`移行先: ${targetUrl}`);
  const src = call(sourceUrl, await login(sourceUrl));
  const dst = call(targetUrl, await login(targetUrl));

  // --- デバイス ---
  const devices = await src('GET', '/devices');
  const existing = await dst('GET', '/devices');
  const existingIds = new Set(existing.map((d) => d.entityId));
  let added = 0;
  for (const d of devices) {
    if (existingIds.has(d.entityId)) continue;
    await dst('POST', '/devices', {
      entityId: d.entityId,
      name: d.name,
      room: d.room,
      type: d.type,
      aliases: d.aliases ?? [],
    });
    added++;
  }
  console.log(`デバイス: ${added}件を追加 (既存 ${existing.length}件はそのまま)`);

  // --- 設定 ---
  const settings = await src('GET', '/settings');
  await dst('PUT', '/settings', settings);
  console.log(`設定: ${Object.keys(settings).length}項目を反映`);

  // --- 権限 ---
  const perms = await src('GET', '/permissions');
  for (const p of perms) {
    await dst('PATCH', `/permissions/${p.category}`, { mode: p.mode });
  }
  console.log(`権限: ${perms.length}カテゴリを反映`);

  // --- 記憶 (好み・決定事項) ---
  const memories = await src('GET', '/memories');
  const targetMemories = await dst('GET', '/memories');
  const seen = new Set(targetMemories.map((m) => `${m.kind}:${m.title}`));
  let memAdded = 0;
  for (const m of memories) {
    // 会話由来の擬似行は移さない
    if (m.kind === 'conversation') continue;
    if (seen.has(`${m.kind}:${m.title}`)) continue;
    await dst('POST', '/memories', { kind: m.kind, title: m.title, content: m.content, tags: m.tags });
    memAdded++;
  }
  console.log(`記憶: ${memAdded}件を追加`);

  if (withConversations) {
    const conversations = await src('GET', '/conversations');
    console.log(`会話: ${conversations.length}件は移行対象外です (履歴は移行元に残ります)`);
  }

  console.log('\n完了しました。移行先の設定タブで内容を確認してください。');
};

main().catch((err) => {
  console.error('移行に失敗しました:', err.message);
  process.exit(1);
});
