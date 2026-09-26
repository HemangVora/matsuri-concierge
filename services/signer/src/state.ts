import { DatabaseSync } from 'node:sqlite';

export type SignerState = ReturnType<typeof openState>;

// The signer's own source of truth, independent of anything the api reports:
//   - what it has actually sent today (for the daily-budget floor), keyed to a fixed Asia/Tokyo
//     calendar day so it agrees with services/api's own budget window regardless of host TZ;
//   - which proposal ids it has already executed (replay guard);
//   - which approval signatures it has already spent (replay guard, independent of proposal id).
// `path` is a file path or ':memory:' (used by tests). The caller is responsible for making sure the
// file lives somewhere gitignored (e.g. a `.sqlite` path — already covered by the repo's .gitignore).
export function openState(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS spends (id INTEGER PRIMARY KEY AUTOINCREMENT, amount_yen INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS consumed_proposals (proposal_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS used_signatures (signature TEXT PRIMARY KEY, created_at TEXT NOT NULL);
  `);

  return {
    // Same fixed Asia/Tokyo (+09:00, no DST) day boundary as services/api's store.spentTodayYen, so
    // the signer's own ledger and the api's daily-budget window always agree on what "today" means.
    spentTodayYen(now = new Date()): number {
      const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
      const shifted = new Date(now.getTime() + JST_OFFSET_MS);
      const jstMidnightInShiftedFrame = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), 0, 0, 0, 0);
      const start = new Date(jstMidnightInShiftedFrame - JST_OFFSET_MS);
      const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
      const r = db.prepare(`SELECT COALESCE(SUM(amount_yen), 0) AS s FROM spends WHERE created_at >= ? AND created_at < ?`)
        .get(start.toISOString(), end.toISOString()) as { s: number };
      return r.s;
    },
    recordSpend(amountYen: number, now = new Date()) {
      if (amountYen <= 0) return;
      db.prepare('INSERT INTO spends (amount_yen, created_at) VALUES (?, ?)').run(Math.trunc(amountYen), now.toISOString());
    },
    isConsumed(proposalId: string): boolean {
      return db.prepare('SELECT 1 FROM consumed_proposals WHERE proposal_id = ?').get(proposalId) !== undefined;
    },
    markConsumed(proposalId: string, now = new Date()) {
      db.prepare('INSERT OR IGNORE INTO consumed_proposals (proposal_id, created_at) VALUES (?, ?)').run(proposalId, now.toISOString());
    },
    isSignatureUsed(signature: string): boolean {
      return db.prepare('SELECT 1 FROM used_signatures WHERE signature = ?').get(signature) !== undefined;
    },
    markSignatureUsed(signature: string, now = new Date()) {
      db.prepare('INSERT OR IGNORE INTO used_signatures (signature, created_at) VALUES (?, ?)').run(signature, now.toISOString());
    },
  };
}
