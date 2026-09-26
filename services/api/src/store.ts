import { DatabaseSync } from 'node:sqlite';
import type { ApprovalRecord, ProposalKind, Screening, UnsignedTx } from '@mc/core';

export type ProposalStatus = 'proposed' | 'awaiting_approval' | 'approved' | 'executed' | 'refused' | 'held' | 'failed';
export interface ProposalRow {
  id: string; kind: ProposalKind; status: ProposalStatus; hash: string; totalYen: number;
  requiresApproval: boolean; decision: unknown; txs: UnsignedTx[]; approval: ApprovalRecord | null;
  txHashes: string[]; meta: Record<string, unknown>; createdAt: string;
}
export type Store = ReturnType<typeof openStore>;

export function openStore(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, kind TEXT, status TEXT, hash TEXT, total_yen INTEGER,
      requires_approval INTEGER, decision TEXT, txs TEXT, approval TEXT, tx_hashes TEXT, meta TEXT, created_at TEXT);
    CREATE TABLE IF NOT EXISTS screenings (address TEXT PRIMARY KEY, body TEXT, fetched_at TEXT);
    CREATE TABLE IF NOT EXISTS bills (id TEXT PRIMARY KEY, body TEXT);
    CREATE TABLE IF NOT EXISTS shares (bill_id TEXT, payer TEXT, PRIMARY KEY (bill_id, payer));
  `);
  const row = (r: any): ProposalRow => ({
    id: r.id, kind: r.kind, status: r.status, hash: r.hash, totalYen: r.total_yen,
    requiresApproval: !!r.requires_approval, decision: JSON.parse(r.decision), txs: JSON.parse(r.txs),
    approval: r.approval ? JSON.parse(r.approval) : null, txHashes: JSON.parse(r.tx_hashes), meta: JSON.parse(r.meta),
    createdAt: r.created_at,
  });
  return {
    insertProposal(p: Omit<ProposalRow, 'createdAt' | 'txHashes' | 'approval'> & { createdAt?: string }): ProposalRow {
      // createdAt is optional and test-only: production callers omit it and get the real insert time.
      db.prepare(`INSERT INTO proposals VALUES (?,?,?,?,?,?,?,?,NULL,'[]',?,?)`).run(
        p.id, p.kind, p.status, p.hash, p.totalYen, p.requiresApproval ? 1 : 0,
        JSON.stringify(p.decision), JSON.stringify(p.txs), JSON.stringify(p.meta), p.createdAt ?? new Date().toISOString());
      return this.getProposal(p.id)!;
    },
    getProposal(id: string): ProposalRow | null {
      const r = db.prepare('SELECT * FROM proposals WHERE id = ?').get(id);
      return r ? row(r) : null;
    },
    setApproval(id: string, a: ApprovalRecord) {
      db.prepare(`UPDATE proposals SET approval = ?, status = 'approved' WHERE id = ?`).run(JSON.stringify(a), id);
    },
    setStatus(id: string, status: ProposalStatus, txHashes?: string[]) {
      if (txHashes) db.prepare('UPDATE proposals SET status = ?, tx_hashes = ? WHERE id = ?').run(status, JSON.stringify(txHashes), id);
      else db.prepare('UPDATE proposals SET status = ? WHERE id = ?').run(status, id);
    },
    spentTodayYen(now = new Date()): number {
      // Budget day is anchored to a fixed Asia/Tokyo (+09:00, no DST) calendar day, independent of the
      // host process's TZ. Shift `now` by +9h, floor to a UTC-midnight in that shifted frame (which is
      // JST midnight), then shift back by -9h to get the UTC instant where the JST day actually starts.
      const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
      const shifted = new Date(now.getTime() + JST_OFFSET_MS);
      const jstMidnightInShiftedFrame = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), 0, 0, 0, 0);
      const start = new Date(jstMidnightInShiftedFrame - JST_OFFSET_MS);
      const r = db.prepare(`SELECT COALESCE(SUM(total_yen),0) AS s FROM proposals
        WHERE status = 'executed' AND kind IN ('order','transfer') AND created_at >= ?`).get(start.toISOString()) as { s: number };
      return r.s;
    },
    listProposals(limit = 50): ProposalRow[] {
      return db.prepare('SELECT * FROM proposals ORDER BY created_at DESC LIMIT ?').all(limit).map(row);
    },
    cacheScreening(s: Screening) {
      db.prepare('INSERT OR REPLACE INTO screenings VALUES (?,?,?)').run(s.address.toLowerCase(), JSON.stringify(s), s.fetchedAt);
    },
    getScreening(address: string, maxAgeMs: number): Screening | null {
      const r = db.prepare('SELECT body, fetched_at FROM screenings WHERE address = ?').get(address.toLowerCase()) as any;
      if (!r || Date.now() - Date.parse(r.fetched_at) > maxAgeMs) return null;
      return JSON.parse(r.body);
    },
    putBill(id: string, bill: unknown) { db.prepare('INSERT OR REPLACE INTO bills VALUES (?,?)').run(id, JSON.stringify(bill)); },
    getBill(id: string): unknown | null {
      const r = db.prepare('SELECT body FROM bills WHERE id = ?').get(id) as any;
      return r ? JSON.parse(r.body) : null;
    },
    markShare(billId: string, from: string): boolean {
      const r = db.prepare('INSERT OR IGNORE INTO shares VALUES (?,?)').run(billId, from.toLowerCase());
      return r.changes === 1;
    },
  };
}
