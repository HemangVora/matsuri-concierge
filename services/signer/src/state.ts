import { DatabaseSync } from 'node:sqlite';

export type SignerState = ReturnType<typeof openState>;

// The signer's own source of truth, independent of anything the api reports:
//   - what it has actually sent today (for the daily-budget floor), keyed to a fixed Asia/Tokyo
//     calendar day so it agrees with services/api's own budget window regardless of host TZ;
//   - which proposal ids it has already executed (replay guard);
//   - which approvals (keyed by approved content, not signature encoding — see verify.ts's
//     approvalKey) it has already spent (replay guard, independent of proposal id).
// `path` is a file path or ':memory:' (used by tests). The caller is responsible for making sure the
// file lives somewhere gitignored (e.g. a `.sqlite` path — already covered by the repo's .gitignore).
export function openState(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS spends (id INTEGER PRIMARY KEY AUTOINCREMENT, amount_yen INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS consumed_proposals (proposal_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS used_approvals (approval_key TEXT PRIMARY KEY, created_at TEXT NOT NULL);
  `);

  const insertProposal = db.prepare('INSERT OR IGNORE INTO consumed_proposals (proposal_id, created_at) VALUES (?, ?)');
  const deleteProposal = db.prepare('DELETE FROM consumed_proposals WHERE proposal_id = ?');
  const insertApproval = db.prepare('INSERT OR IGNORE INTO used_approvals (approval_key, created_at) VALUES (?, ?)');
  const insertSpend = db.prepare('INSERT INTO spends (amount_yen, created_at) VALUES (?, ?)');

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
      insertSpend.run(Math.trunc(amountYen), now.toISOString());
    },
    isConsumed(proposalId: string): boolean {
      return db.prepare('SELECT 1 FROM consumed_proposals WHERE proposal_id = ?').get(proposalId) !== undefined;
    },
    isApprovalUsed(key: string): boolean {
      return db.prepare('SELECT 1 FROM used_approvals WHERE approval_key = ?').get(key) !== undefined;
    },
    // The single enforcement point for replay-safety. Synchronous end-to-end (node:sqlite's
    // DatabaseSync is synchronous, and there is no `await` anywhere in this function), so on a
    // single-threaded Node process no other request can interleave between the check and the mark:
    // either this call wins the claim outright, or it observes a claim that fully happened before
    // it started. Claims the proposal id and (if present) the approval key, and reserves the spend
    // for today, all atomically — if the approval key was already used, the proposal-id claim is
    // rolled back too, so a losing call leaves no trace. Returns false when it loses the race,
    // meaning the caller must refuse to send anything.
    tryClaim(proposalId: string, approvalKeyValue: string | null, spendYen: number, now = new Date()): boolean {
      const nowIso = now.toISOString();
      if (Number(insertProposal.run(proposalId, nowIso).changes) !== 1) return false;
      if (approvalKeyValue !== null && Number(insertApproval.run(approvalKeyValue, nowIso).changes) !== 1) {
        deleteProposal.run(proposalId);
        return false;
      }
      if (spendYen > 0) insertSpend.run(Math.trunc(spendYen), nowIso);
      return true;
    },
  };
}
