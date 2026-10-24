import type {
  BucketRow,
  ChunkRow,
  ForkRow,
  HistoryRow,
  IdleRow,
  InviteRow,
  JoinRow,
  LeaseRow,
  MeshStore,
  MessageRow,
  QueueItem,
  RoomRow,
  RosterRow,
  SessionRow,
  WaiterRow,
  WatchRow,
} from "./store.ts";

// Rows are copied in and out, so a caller that mutates a row it read cannot change the store
// behind its back (the SQL store behaves the same way by construction).
const copy = <T>(row: T): T => ({ ...row });

// Session ids, room names, lease keys and blob ids never contain a space, so pair keys are unambiguous.
const pair = (a: string, b: string | number): string => `${a} ${b}`;

/** An in-memory `MeshStore` for tests and for embedding a relay that needs no durability. */
export class MemoryStore implements MeshStore {
  private readonly rosters = new Map<number, RosterRow>();
  private readonly forkRows: ForkRow[] = [];
  private readonly invites = new Map<string, InviteRow>();
  private readonly joinRows = new Map<string, JoinRow>();
  private readonly sessionRows = new Map<string, SessionRow>();
  private items: QueueItem[] = [];
  private readonly messages = new Map<string, MessageRow>();
  private readonly idle = new Map<string, IdleRow>();
  private readonly buckets = new Map<string, BucketRow>();
  private readonly rooms = new Map<string, RoomRow>();
  private memberRows: { room: string; sid: string }[] = [];
  private historyRows: HistoryRow[] = [];
  private readonly leaseRows = new Map<string, LeaseRow>();
  private waiterRows: WaiterRow[] = [];
  private waiterSeq = 0;
  private readonly watches = new Map<string, WatchRow>();
  private token = 0;
  private readonly chunks = new Map<string, ChunkRow>();
  private readonly cardRows = new Map<string, string>();

  rosterHead(): number {
    // Rosters are stored only as the next seq of an unbroken chain from 1.
    return this.rosters.size;
  }

  getRoster(seq: number): RosterRow | undefined {
    const row = this.rosters.get(seq);
    return row && copy(row);
  }

  rosterRange(from: number, limit: number): RosterRow[] {
    const out: RosterRow[] = [];
    for (let seq = from; out.length < limit && this.rosters.has(seq); seq++) out.push(copy(this.rosters.get(seq)!));
    return out;
  }

  insertRoster(row: RosterRow): boolean {
    if (this.rosters.has(row.seq)) return false;
    this.rosters.set(row.seq, copy(row));
    return true;
  }

  addFork(row: ForkRow): void {
    this.forkRows.push(copy(row));
  }

  forks(): ForkRow[] {
    return this.forkRows.map(copy);
  }

  getInvite(id: string): InviteRow | undefined {
    const row = this.invites.get(id);
    return row && copy(row);
  }

  putInvite(row: InviteRow): void {
    this.invites.set(row.id, copy(row));
  }

  deleteInvite(id: string): void {
    this.invites.delete(id);
  }

  liveInviteCount(device: string, now: number): number {
    return [...this.invites.values()].filter((i) => i.device === device && i.joiner === null && i.exp > now).length;
  }

  expiredInvites(now: number): InviteRow[] {
    return [...this.invites.values()].filter((i) => i.exp <= now).map(copy);
  }

  invitesBy(device: string): InviteRow[] {
    return [...this.invites.values()].filter((i) => i.device === device).map(copy);
  }

  getJoin(invite: string): JoinRow | undefined {
    const row = this.joinRows.get(invite);
    return row && copy(row);
  }

  putJoin(row: JoinRow): void {
    this.joinRows.set(row.invite, copy(row));
  }

  deleteJoin(invite: string): void {
    this.joinRows.delete(invite);
  }

  joins(): JoinRow[] {
    return [...this.joinRows.values()].map(copy);
  }

  getSession(sid: string): SessionRow | undefined {
    const row = this.sessionRows.get(sid);
    return row && copy(row);
  }

  putSession(row: SessionRow): void {
    this.sessionRows.set(row.sid, copy(row));
  }

  deleteSession(sid: string): void {
    this.sessionRows.delete(sid);
    this.items = this.items.filter((i) => i.sid !== sid);
    for (const [k, row] of this.idle) if (row.sub === sid || row.target === sid) this.idle.delete(k);
    this.memberRows = this.memberRows.filter((m) => m.sid !== sid);
    for (const [k, row] of this.leaseRows) if (row.holder === sid) this.leaseRows.delete(k);
    this.waiterRows = this.waiterRows.filter((w) => w.sid !== sid);
    for (const [k, row] of this.watches) if (row.sid === sid) this.watches.delete(k);
    this.cardRows.delete(sid);
  }

  sessions(): SessionRow[] {
    return [...this.sessionRows.values()].map(copy);
  }

  sessionsOf(device: string): SessionRow[] {
    return this.sessions().filter((s) => s.device === device);
  }

  rekeySession(from: string, to: string): void {
    const swap = (sid: string): string => (sid === from ? to : sid);
    const row = this.sessionRows.get(from)!;
    this.sessionRows.delete(from);
    this.sessionRows.set(to, { ...row, sid: to });
    for (const item of this.items) item.sid = swap(item.sid);
    for (const m of this.messages.values()) {
      m.sender = swap(m.sender);
      m.rcpts = m.rcpts.map(swap);
    }
    const idle = [...this.idle.values()];
    this.idle.clear();
    for (const r of idle) this.putIdle({ sub: swap(r.sub), target: swap(r.target), exp: r.exp });
    for (const m of this.memberRows) m.sid = swap(m.sid);
    for (const l of this.leaseRows.values()) l.holder = swap(l.holder);
    for (const w of this.waiterRows) w.sid = swap(w.sid);
    const watches = [...this.watches.values()];
    this.watches.clear();
    for (const w of watches) this.putWatch({ ...w, sid: swap(w.sid) });
    const card = this.cardRows.get(from);
    this.cardRows.delete(from);
    if (card !== undefined) this.cardRows.set(to, card);
  }

  enqueue(item: QueueItem): void {
    this.items.push(copy(item));
  }

  queue(sid: string, after: number): QueueItem[] {
    return this.items
      .filter((i) => i.sid === sid && i.cur > after)
      .sort((a, b) => a.cur - b.cur)
      .map(copy);
  }

  queueCount(sid: string): number {
    return this.items.filter((i) => i.sid === sid).length;
  }

  queueCountFrom(sid: string, fromDevice: string): number {
    return this.items.filter((i) => i.sid === sid && i.fromDevice === fromDevice).length;
  }

  dequeueThrough(sid: string, cur: number): void {
    this.items = this.items.filter((i) => i.sid !== sid || i.cur > cur);
  }

  expiredQueue(before: number): QueueItem[] {
    // Items are appended in time order, so the array order is already oldest first.
    return this.items.filter((i) => i.queuedAt <= before).map(copy);
  }

  dropQueueItem(sid: string, cur: number): void {
    this.items = this.items.filter((i) => i.sid !== sid || i.cur !== cur);
  }

  dropQueueFrom(device: string): void {
    this.items = this.items.filter((i) => i.fromDevice !== device);
  }

  putMessage(row: MessageRow): void {
    this.messages.set(row.id, { ...row, rcpts: [...row.rcpts] });
  }

  getMessage(id: string): MessageRow | undefined {
    const row = this.messages.get(id);
    return row && { ...row, rcpts: [...row.rcpts] };
  }

  pruneMessages(before: number): void {
    for (const [id, m] of this.messages) if (m.at <= before) this.messages.delete(id);
  }

  putIdle(row: IdleRow): void {
    this.idle.set(pair(row.sub, row.target), copy(row));
  }

  idleFor(target: string): IdleRow[] {
    return [...this.idle.values()].filter((r) => r.target === target).map(copy);
  }

  idleCount(sub: string): number {
    return [...this.idle.values()].filter((r) => r.sub === sub).length;
  }

  deleteIdle(sub: string, target: string): void {
    this.idle.delete(pair(sub, target));
  }

  pruneIdle(now: number): void {
    for (const [k, row] of this.idle) if (row.exp <= now) this.idle.delete(k);
  }

  getBucket(bkey: string): BucketRow | undefined {
    const row = this.buckets.get(bkey);
    return row && copy(row);
  }

  putBucket(row: BucketRow): void {
    this.buckets.set(row.bkey, copy(row));
  }

  pruneBuckets(before: number): void {
    for (const [k, row] of this.buckets) if (row.at <= before) this.buckets.delete(k);
  }

  getRoom(room: string): RoomRow | undefined {
    const row = this.rooms.get(room);
    return row && copy(row);
  }

  putRoom(row: RoomRow): void {
    this.rooms.set(row.room, copy(row));
  }

  roomCount(): number {
    return this.rooms.size;
  }

  pruneRooms(): void {
    for (const room of this.rooms.keys()) {
      if (!this.memberRows.some((m) => m.room === room) && !this.historyRows.some((h) => h.room === room)) this.rooms.delete(room);
    }
  }

  members(room: string): string[] {
    return this.memberRows.filter((m) => m.room === room).map((m) => m.sid);
  }

  roomsOf(sid: string): string[] {
    return this.memberRows
      .filter((m) => m.sid === sid)
      .map((m) => m.room)
      .sort();
  }

  addMember(room: string, sid: string): void {
    if (!this.memberRows.some((m) => m.room === room && m.sid === sid)) this.memberRows.push({ room, sid });
  }

  removeMember(room: string, sid: string): void {
    this.memberRows = this.memberRows.filter((m) => m.room !== room || m.sid !== sid);
  }

  addHistory(row: HistoryRow, keep: number): void {
    this.historyRows.push(copy(row));
    const mine = this.historyRows.filter((h) => h.room === row.room);
    const cutoff = mine.length > keep ? mine[mine.length - keep]!.cur : 0;
    this.historyRows = this.historyRows.filter((h) => h.room !== row.room || h.cur >= cutoff);
  }

  history(room: string, before: number, limit: number): HistoryRow[] {
    return this.historyRows
      .filter((h) => h.room === room && h.cur < before)
      .sort((a, b) => b.cur - a.cur)
      .slice(0, limit)
      .map(copy);
  }

  pruneHistory(before: number): void {
    this.historyRows = this.historyRows.filter((h) => h.at > before);
  }

  historyBytes(): number {
    let total = 0;
    for (const h of this.historyRows) total += h.msg.length;
    return total;
  }

  dropOldestHistory(): void {
    // Rows are appended in time order, so the first is the oldest.
    this.historyRows.shift();
  }

  getLease(key: string): LeaseRow | undefined {
    const row = this.leaseRows.get(key);
    return row && copy(row);
  }

  putLease(row: LeaseRow): void {
    this.leaseRows.set(row.key, copy(row));
  }

  deleteLease(key: string): void {
    this.leaseRows.delete(key);
  }

  leases(): LeaseRow[] {
    return [...this.leaseRows.values()].map(copy);
  }

  leasesHeldBy(sid: string): number {
    return [...this.leaseRows.values()].filter((l) => l.holder === sid).length;
  }

  expiredLeases(now: number): LeaseRow[] {
    return [...this.leaseRows.values()].filter((l) => l.until <= now).map(copy);
  }

  nextToken(): number {
    return ++this.token;
  }

  addWaiter(row: Omit<WaiterRow, "seq">): void {
    // One wait per session and key: asking again keeps the place already held in the line.
    if (this.waiterRows.some((w) => w.key === row.key && w.sid === row.sid)) return;
    this.waiterRows.push({ ...row, seq: ++this.waiterSeq });
  }

  waiters(key: string): WaiterRow[] {
    return this.waiterRows.filter((w) => w.key === key).map(copy);
  }

  deleteWaiter(key: string, sid: string): void {
    this.waiterRows = this.waiterRows.filter((w) => w.key !== key || w.sid !== sid);
  }

  waitsBy(sid: string): number {
    return this.waiterRows.filter((w) => w.sid === sid).length;
  }

  expiredWaiters(now: number): WaiterRow[] {
    return this.waiterRows.filter((w) => w.exp <= now).map(copy);
  }

  putWatch(row: WatchRow): void {
    this.watches.set(pair(row.key, row.sid), copy(row));
  }

  watchesFor(key: string): WatchRow[] {
    return [...this.watches.values()].filter((w) => w.key === key).map(copy);
  }

  watchesBy(sid: string): number {
    return [...this.watches.values()].filter((w) => w.sid === sid).length;
  }

  deleteWatch(key: string, sid: string): void {
    this.watches.delete(pair(key, sid));
  }

  pruneWatches(now: number): void {
    for (const [k, w] of this.watches) if (w.exp <= now) this.watches.delete(k);
  }

  getChunk(blob: string, idx: number): ChunkRow | undefined {
    const row = this.chunks.get(pair(blob, idx));
    return row && copy(row);
  }

  putChunk(row: ChunkRow): void {
    this.chunks.set(pair(row.blob, row.idx), copy(row));
  }

  blobBytes(): number {
    let total = 0;
    for (const c of this.chunks.values()) total += c.bytes;
    return total;
  }

  pruneChunks(before: number): void {
    for (const [k, c] of this.chunks) if (c.at <= before) this.chunks.delete(k);
  }

  dropChunksFrom(device: string): void {
    for (const [k, c] of this.chunks) if (c.device === device) this.chunks.delete(k);
  }

  putCard(sid: string, msg: string): void {
    this.cardRows.set(sid, msg);
  }

  deleteCard(sid: string): void {
    this.cardRows.delete(sid);
  }

  cards(): { sid: string; msg: string }[] {
    return [...this.cardRows].map(([sid, msg]) => ({ sid, msg }));
  }
}
