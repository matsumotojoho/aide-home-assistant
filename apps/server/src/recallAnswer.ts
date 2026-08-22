// 「さっきの回答教えて」への即答。
// Alexaは8秒で打ち切るため、時間のかかる質問は「スマホに通知します」と返して
// バックグラウンドで処理する。その回答を後から口頭で聞き直せるようにする。
//
// 保存済みメッセージから組み立てるだけなのでClaudeを使わない (0.1秒程度)。

import type { Db } from './db/index.js';

interface Row {
  role: string;
  content: string;
  created_at: string;
}

export function answerRecall(db: Db, userId: string): string {
  const rows = db.$client
    .prepare(
      `SELECT m.role, m.content, m.created_at
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.user_id = ?
       ORDER BY m.created_at DESC, m.rowid DESC
       LIMIT 12`,
    )
    .all(userId) as Row[];

  // 先頭は今聞いている「さっきの回答教えて」自身なので飛ばす
  let i = 0;
  while (i < rows.length && rows[i].role === 'user') i++;

  const latest = rows[i];
  if (!latest || latest.role !== 'assistant') {
    // 直前の質問への回答がまだ保存されていない = バックグラウンド処理中
    return rows.length > 0
      ? 'まだ確認中です。もう少し待ってからもう一度聞いてください。'
      : '直前の回答が見つかりませんでした。';
  }
  // 「スマホに通知しますね」等は回答ではない。
  // ここで古い回答を遡って読み上げると、別の質問の答えを言ってしまうので待たせる。
  if (isPlaceholder(latest.content)) {
    return 'まだ確認中です。もう少し待ってからもう一度聞いてください。';
  }
  return latest.content;
}

/** 「確認しています。結果はスマホに通知しますね。」のような、回答ではない応答 */
function isPlaceholder(content: string): boolean {
  return /確認しています|スマホに通知|スマホで確認/.test(content);
}
