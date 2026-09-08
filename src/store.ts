import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Delivery, Message, RoomState, Session, Snapshot, Target } from './model.js';
import type { Transition } from './state.js';
import { advance, resetDebounce } from './state.js';
import { eventMessage } from './format.js';

export class Store {
  readonly db: Database.Database;
  private statements = new Map<string, Database.Statement>();
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    if (Number(this.db.pragma('user_version', { simple: true })) > 1) {
      this.db.close(); throw new Error('数据库版本比程序新，拒绝降级打开');
    }
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 3000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rooms (uid TEXT PRIMARY KEY, room_id TEXT NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS subscriptions (
        platform TEXT NOT NULL, target TEXT NOT NULL, uid TEXT NOT NULL REFERENCES rooms(uid),
        PRIMARY KEY(platform,target,uid));
      CREATE INDEX IF NOT EXISTS subscriptions_uid ON subscriptions(uid);
      CREATE INDEX IF NOT EXISTS rooms_room_id ON rooms(room_id);
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, uid TEXT NOT NULL, started_at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_history ON sessions(uid,started_at DESC);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, uid TEXT NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (
        id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id), uid TEXT NOT NULL,
        platform TEXT NOT NULL, target TEXT NOT NULL, message TEXT NOT NULL,
        created_at INTEGER NOT NULL, next_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending', error TEXT,
        UNIQUE(event_id,platform,target));
      CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(status,next_at);
      CREATE INDEX IF NOT EXISTS deliveries_pending_order ON deliveries(platform,target,uid,id) WHERE status='pending';
      CREATE INDEX IF NOT EXISTS deliveries_pending_expiry ON deliveries(created_at) WHERE status='pending';
      CREATE INDEX IF NOT EXISTS deliveries_event ON deliveries(event_id);
      PRAGMA user_version = 1;
    `);
  }
  private prepare(sql: string): Database.Statement {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
  monitoredUids(): string[] {
    return (this.prepare('SELECT DISTINCT uid FROM subscriptions ORDER BY uid').all() as { uid: string }[])
      .map(row => row.uid);
  }
  applySnapshots(snapshots: Iterable<Snapshot>, timezone: string, maxGapMs: number) {
    this.db.transaction(() => {
      for (const snapshot of snapshots) {
        if (!this.hasSubscriptions(snapshot.uid)) continue;
        const state = this.state(snapshot.uid);
        if (state && snapshot.observedAt <= state.lastObservedAt) continue;
        this.writeTransition(advance(state, snapshot, maxGapMs), timezone);
      }
    })();
  }
  private hasSubscriptions(uid: string): boolean {
    return !!this.prepare('SELECT 1 FROM subscriptions WHERE uid=? LIMIT 1').get(uid);
  }
  getMeta(key: string): string | undefined {
    return (this.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined)?.value;
  }
  setMeta(key: string, value: string) {
    this.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, value);
  }
  state(uid: string): RoomState | null {
    const row = this.prepare('SELECT state FROM rooms WHERE uid=?').get(uid) as { state: string } | undefined;
    return row ? JSON.parse(row.state) as RoomState : null;
  }
  states(target?: Target): RoomState[] {
    const rows = (target ? this.prepare(`SELECT r.state FROM rooms r JOIN subscriptions s ON r.uid=s.uid
      WHERE s.platform=? AND s.target=? ORDER BY r.uid`).all(target.platform, target.id)
      : this.prepare('SELECT state FROM rooms WHERE uid IN (SELECT uid FROM subscriptions)').all()) as { state: string }[];
    return rows.map(r => JSON.parse(r.state) as RoomState);
  }
  knownUid(type: 'uid' | 'room', id: string): string | null {
    const row = this.prepare(`SELECT uid FROM rooms WHERE ${type === 'uid' ? 'uid' : 'room_id'}=?`).get(id) as { uid: string } | undefined;
    return row?.uid ?? null;
  }
  saveSession(session: Session) {
    this.prepare('INSERT OR REPLACE INTO sessions VALUES (?,?,?,?)')
      .run(session.id, session.uid, session.startedAt, JSON.stringify(session));
  }
  private saveState(state: RoomState) {
    this.prepare('INSERT INTO rooms VALUES (?,?,?) ON CONFLICT(uid) DO UPDATE SET room_id=excluded.room_id,state=excluded.state')
      .run(state.uid, state.snapshot.roomId, JSON.stringify(state));
  }
  commit(change: Transition, timezone: string) {
    this.db.transaction(() => this.writeTransition(change, timezone))();
  }
  private writeTransition(change: Transition, timezone: string) {
    this.saveState(change.state);
    for (const session of change.sessions) this.saveSession(session);
    for (const event of change.events) {
      const createdAt = event.snapshot.observedAt;
      const uid = event.snapshot.uid;
      const id = this.prepare('INSERT INTO events(uid,created_at,data) VALUES (?,?,?)')
        .run(uid, createdAt, JSON.stringify(event)).lastInsertRowid;
      this.prepare(`INSERT INTO deliveries(event_id,uid,platform,target,message,created_at,next_at)
        SELECT ?,uid,platform,target,?,?,? FROM subscriptions WHERE uid=?`)
        .run(id, JSON.stringify(eventMessage(event, timezone)), createdAt, createdAt, uid);
    }
  }
  subscribe(target: Target, snapshot: Snapshot): boolean {
    return this.db.transaction(() => {
      if (!this.hasSubscriptions(snapshot.uid)) {
        if (this.monitoredUids().length >= 50) throw new Error('当前最多同时监测 50 位主播');
        const baseline = advance(null, snapshot);
        const last = this.history(snapshot.uid, 1)[0];
        if (baseline.state.session && last?.status === 'incomplete' && last.endedAt === null &&
            snapshot.startedAt !== null && snapshot.startedAt === last.upstreamStart) {
          const resumed: Session = { ...last, status: 'live', endSource: null, firstOfflineAt: null,
            lastLiveAt: snapshot.observedAt, finalTitle: snapshot.title, interrupted: true,
            finalArea: structuredClone(snapshot.area) };
          baseline.state.session = resumed; baseline.sessions = [resumed];
        }
        this.writeTransition(baseline, 'Asia/Shanghai'); // baseline emits no notifications
      }
      return this.prepare('INSERT OR IGNORE INTO subscriptions VALUES (?,?,?)')
        .run(target.platform, target.id, snapshot.uid).changes > 0;
    })();
  }
  unsubscribe(target: Target, uid: string): boolean {
    return this.db.transaction(() => {
      const removed = this.prepare('DELETE FROM subscriptions WHERE platform=? AND target=? AND uid=?')
        .run(target.platform, target.id, uid).changes > 0;
      this.prepare(`UPDATE deliveries SET status='cancelled' WHERE platform=? AND target=? AND uid=? AND status='pending'`)
        .run(target.platform, target.id, uid);
      if (!this.hasSubscriptions(uid)) {
        const state = this.state(uid);
        if (state?.session) {
          state.session.status = 'incomplete'; state.session.interrupted = true; state.session.endSource = 'unknown';
          this.saveSession(state.session);
          state.session = null; state.live = false; state.offlineSince = null; state.titleCandidate = null;
          this.saveState(state);
        }
      }
      return removed;
    })();
  }
  resetDebounce() {
    this.db.transaction(() => { for (const state of this.states()) this.saveState(resetDebounce(state)); })();
  }
  history(uid: string, page: number): Session[] {
    return (this.prepare('SELECT data FROM sessions WHERE uid=? ORDER BY started_at DESC,id DESC LIMIT 10 OFFSET ?')
      .all(uid, (page - 1) * 10) as { data: string }[]).map(r => JSON.parse(r.data) as Session);
  }
  due(now: number, platform?: Target['platform']): Delivery[] {
    this.prepare(`UPDATE deliveries SET status='expired',error='通知已超过10分钟' WHERE status='pending' AND created_at<=?`)
      .run(now - 600_000);
    const rows = this.prepare(`SELECT d.id,d.platform,d.target,d.uid,d.message,d.attempts FROM deliveries d WHERE status='pending' AND next_at<=?
      ${platform ? 'AND d.platform=?' : ''}
      AND NOT EXISTS (SELECT 1 FROM deliveries p WHERE p.status='pending' AND p.platform=d.platform
        AND p.target=d.target AND p.uid=d.uid AND p.id<d.id) ORDER BY id LIMIT 10`).all(...(platform ? [now, platform] : [now])) as
      { id: number; platform: Target['platform']; target: string; uid: string; message: string; attempts: number }[];
    return rows.map(r => ({ id: r.id, target: { platform: r.platform, id: r.target }, uid: r.uid,
      message: JSON.parse(r.message) as Message, attempts: r.attempts }));
  }
  pending(id: number): boolean {
    return !!this.prepare("SELECT 1 FROM deliveries WHERE id=? AND status='pending'").get(id);
  }
  delivered(id: number) { this.prepare("UPDATE deliveries SET status='sent',error=NULL WHERE id=? AND status='pending'").run(id); }
  failed(id: number, error: string, nextAt: number, permanent: boolean) {
    this.prepare("UPDATE deliveries SET status=?,error=?,next_at=?,attempts=attempts+1 WHERE id=? AND status='pending'")
      .run(permanent ? 'failed' : 'pending', error, nextAt, id);
  }
  deliveryStats(): string {
    const rows = this.prepare(`SELECT status,COUNT(*) AS count FROM deliveries WHERE status IN ('pending','failed','expired') GROUP BY status`)
      .all() as { status: string; count: number }[];
    return rows.map(r => `${r.status}: ${r.count}`).join('，') || '无积压或失败';
  }
  cleanup(now: number) {
    this.db.transaction(() => {
      this.prepare("DELETE FROM deliveries WHERE status!='pending' AND created_at<?").run(now - 7 * 86400_000);
      this.prepare('DELETE FROM events WHERE id NOT IN (SELECT event_id FROM deliveries) AND created_at<?').run(now - 7 * 86400_000);
    })();
  }
  healthy(): boolean { return !!this.prepare('SELECT 1').get(); }
  lease(owner: string, now = Date.now()): boolean {
    return this.db.transaction(() => {
      const lease = JSON.parse(this.getMeta('lease') ?? 'null') as { owner: string; until: number } | null;
      if (lease && lease.owner !== owner && lease.until > now) return false;
      this.setMeta('lease', JSON.stringify({ owner, until: now + 15_000 }));
      return true;
    }).immediate();
  }
  release(owner: string) {
    this.db.transaction(() => {
      const lease = JSON.parse(this.getMeta('lease') ?? 'null') as { owner: string } | null;
      if (lease?.owner === owner) this.prepare("DELETE FROM meta WHERE key='lease'").run();
    }).immediate();
  }
  close() { this.db.close(); }
}
