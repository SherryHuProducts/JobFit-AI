// Server-only durable orchestration store. Node >=22.13 (node:sqlite).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export class ScanError extends Error {
  constructor(code, status = 409) { super(code); this.code = code; this.status = status; }
}
export class ScanStore {
  constructor(filename) {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    chmodSync(filename, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS scans (
        id TEXT PRIMARY KEY, tenant TEXT NOT NULL, request_id TEXT NOT NULL,
        created INTEGER NOT NULL, state TEXT NOT NULL,
        lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
        UNIQUE(tenant,request_id));
      CREATE INDEX IF NOT EXISTS scan_tenant ON scans(tenant,created);`);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  row(tenant, id) {
    const row = this.db.prepare('SELECT * FROM scans WHERE tenant=? AND id=?').get(tenant, id);
    if (!row) throw new ScanError('SCAN_NOT_FOUND', 404);
    return { ...row, state: JSON.parse(row.state) };
  }
  save(row) { this.db.prepare('UPDATE scans SET state=? WHERE tenant=? AND id=?').run(JSON.stringify(row.state), row.tenant, row.id); }
  close() { this.db.close(); }
}
