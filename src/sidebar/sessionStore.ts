import { referenceDescriptor, referenceLimits, NxReferenceDescriptor } from '../runtime/references';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, constants } from 'node:fs';
import * as path from 'node:path';
import { parseSessionState } from '../sessionState';
import { workspaceIdentity, verificationLabel } from '../worker/toolActivity';
import { ChatMessage, ChatTurn, SidebarChatSession, ProviderSegment, ToolActivity, TurnStatus } from './session';

export const sessionSchemaVersion = 3;
export const validSessionId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(value);
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const string = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value);
const time = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const providerIdentity = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value);
const route = (value: unknown): value is 'LOW' | 'MEDIUM' | 'HIGH' => typeof value === 'string' && ['LOW', 'MEDIUM', 'HIGH'].includes(value);
const statuses = ['running', 'completed', 'partial', 'cancelled', 'failed', 'interrupted'];
const labels = ['Read', 'Search workspace', 'Check diagnostics', 'Check Git status', 'Read Git diff', 'Create', 'Edit', 'Move', 'Copy', 'Run verification', 'Check route', 'Workspace tool'];
const notices = ['The turn failed. Check connection and model setup, then retry.', 'Runtime or tool failure. Check connection and model setup, then retry.', 'Partially completed. Review the result before continuing.', 'Cancelled', 'Interrupted when the extension stopped.'];
export function sessionTitle(prompt: string): string {
  const text = prompt.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/gu, ' ').trim();
  const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(item => item.segment);
  return segments.length > 72 ? segments.slice(0, 71).join('') + '…' : text || 'New chat';
}
export function workspaceSessionKey(uri: string): string { return createHash('sha256').update(uri).digest('hex'); }
export interface SavedSession extends SidebarChatSession { schemaVersion: 3; title: string; createdAt: string; updatedAt: string }
export interface SessionSummary { sessionId: string; title: string; createdAt: string; updatedAt: string; providerId: string; status?: TurnStatus; snippet?: string }
export interface SessionPage { items: SessionSummary[]; offset: number; hasMore: boolean }
const maxBytes = 32 * 1024 * 1024;
const maxMessages = 20000;
function parseTool(value: unknown, recover: boolean): ToolActivity | undefined {
  const raw = object(value);
  if (!raw || !validSessionId(raw.id) || (typeof raw.state !== 'string' || !['running', 'success', 'failed', 'cancelled', 'rejected', 'interrupted'].includes(raw.state))) return;
  const command = verificationLabel(raw.command);
  return { id: raw.id, label: command ?? (labels.includes(String(raw.label)) ? String(raw.label) : 'Workspace tool'),
    state: (recover && raw.state === 'running' ? 'interrupted' : raw.state) as ToolActivity['state'],
    target: workspaceIdentity(raw.target), lineRange: typeof raw.lineRange === 'string' && /^\d{1,7}–\d{1,7}$/.test(raw.lineRange) ? raw.lineRange : undefined,
    command, durationMs: Number.isSafeInteger(raw.durationMs) && Number(raw.durationMs) >= 0 ? Number(raw.durationMs) : undefined };
}
function parseTurn(value: unknown, messageId: string, recover: boolean): ChatTurn | undefined {
  const raw = object(value);
  if (!raw || raw.messageId !== messageId || (typeof raw.mode !== 'string' || !['auto', 'manual'].includes(raw.mode)) || (typeof raw.status !== 'string' || !statuses.includes(raw.status))
    || !Array.isArray(raw.tools) || raw.tools.length > 1000 || !Array.isArray(raw.changedFiles) || raw.changedFiles.length > 2000) return;
  const escalation = object(raw.escalation);
  const status = (recover && raw.status === 'running' ? 'interrupted' : raw.status) as TurnStatus;
  return { providerId: providerIdentity(raw.providerId) ? raw.providerId : undefined, providerLabel: string(raw.providerLabel) ? raw.providerLabel : undefined, messageId, mode: raw.mode as ChatTurn['mode'], status, route: route(raw.route) ? raw.route : undefined,
    modelId: string(raw.modelId) ? raw.modelId : undefined, modelName: string(raw.modelName) ? raw.modelName : undefined,
    effort: string(raw.effort, 80) ? raw.effort : undefined,
    escalation: escalation && route(escalation.from) && route(escalation.to) && typeof escalation.completed === 'boolean'
      ? { from: escalation.from, to: escalation.to, completed: escalation.completed } : undefined,
    notice: status === 'interrupted' ? notices[4] : notices.includes(String(raw.notice)) ? String(raw.notice) : undefined,
    tools: raw.tools.map(tool => parseTool(tool, recover)).filter((tool): tool is ToolActivity => !!tool),
    changedFiles: [...new Set(raw.changedFiles.map(workspaceIdentity).filter((file): file is string => !!file))] };
}
/** Reconstruct an allowlisted object. Runtime continuity can fail independently of the transcript. */
export function parseSavedSession(value: unknown, recover = true): SavedSession | undefined {
  const raw = object(value), execution = object(raw?.execution);
  if (!raw || (raw.schemaVersion !== 1 && raw.schemaVersion !== 2 && raw.schemaVersion !== 3) || !validSessionId(raw.sessionId) || !providerIdentity(raw.providerId)
    || !string(raw.title, 1000) || !time(raw.createdAt) || !time(raw.updatedAt) || raw.updatedAt < raw.createdAt
    || !execution || typeof execution.autoOn !== 'boolean' || !Array.isArray(raw.messages) || raw.messages.length > maxMessages) return;
  const manual = object(execution.manual);
  if (execution.manual !== undefined && (!manual || !string(manual.modelId) || (manual.effort !== undefined && !string(manual.effort, 80)))) return;
  const messages: ChatMessage[] = [];
  const ids = new Set<string>();
  for (const value of raw.messages) {
    const message = object(value);
    if (!message || !validSessionId(message.id) || ids.has(message.id) || (typeof message.role !== 'string' || !['user', 'assistant'].includes(message.role))
      || typeof message.text !== 'string' || message.text.length > 1000000 || !time(message.createdAt)
      || (message.role === 'assistant' && (typeof message.status !== 'string' || !statuses.includes(message.status)))) return;
    ids.add(message.id);
    const turn = message.turn === undefined ? undefined : parseTurn(message.turn, message.id, recover);
    if (message.turn !== undefined && (!turn || message.role !== 'assistant' || turn.status !== (recover && message.status === 'running' ? 'interrupted' : message.status))) return;
    messages.push({ id: message.id, ...(validSessionId(message.segmentId) ? { segmentId: message.segmentId } : {}), role: message.role as ChatMessage['role'], text: message.text, createdAt: message.createdAt,
      ...(raw.schemaVersion >= 2 && message.role === 'user' && Array.isArray(message.references) ? { references: message.references.slice(0, referenceLimits.count).map(referenceDescriptor).filter((ref): ref is NxReferenceDescriptor => !!ref) } : {}),
      ...(message.role === 'assistant' ? { status: (recover && message.status === 'running' ? 'interrupted' : message.status) as TurnStatus } : {}), ...(turn ? { turn } : {}) });
  }
  if (!messages.some(message => message.role === 'user' && message.text.trim())) return;
  const fallbackId = validSessionId(raw.segmentId) ? raw.segmentId : `${raw.sessionId}-segment`.slice(0,80);
  let segments: ProviderSegment[] = [];
  let repaired = false;
  if (raw.schemaVersion === 3 && Array.isArray(raw.segments) && raw.segments.length > 0 && raw.segments.length <= maxMessages) {
    for (const value of raw.segments) {
      const seg = object(value);
      if (!seg || !validSessionId(seg.id) || seg.sessionId !== raw.sessionId || !providerIdentity(seg.providerId)
        || !string(seg.providerLabel) || !time(seg.createdAt) || !Number.isSafeInteger(seg.startIndex) || Number(seg.startIndex) < 0 || Number(seg.startIndex) > messages.length
        || !['fresh', 'selected'].includes(String(seg.contextCarryMode)) || segments.some(item => item.id === seg.id)
        || (segments.length ? Number(seg.startIndex) < segments.at(-1)!.startIndex : seg.startIndex !== 0)) { repaired = true; break; }
      segments.push({ id: seg.id, sessionId: raw.sessionId, providerId: seg.providerId, providerLabel: seg.providerLabel,
        startIndex: Number(seg.startIndex), createdAt: seg.createdAt, contextCarryMode: seg.contextCarryMode as 'fresh' | 'selected',
        carryCount: Number.isSafeInteger(seg.carryCount) && Number(seg.carryCount) >= 0 && Number(seg.carryCount) <= referenceLimits.count ? Number(seg.carryCount) : 0 });
    }
    if (segments.at(-1)?.id !== raw.segmentId || segments.at(-1)?.providerId !== raw.providerId) repaired = true;
    for (let i = 0; i < messages.length && !repaired; i++) {
      const seg = [...segments].reverse().find(item => item.startIndex <= i)!;
      if ((messages[i].segmentId && messages[i].segmentId !== seg.id) || (messages[i].turn?.providerId && messages[i].turn!.providerId !== seg.providerId)) repaired = true;
    }
  } else if (raw.schemaVersion === 3) repaired = true;
  if (repaired) {
    // Only factual captured per-turn provider identities can reconstruct switches.
    segments = [];
    for (let i = 0; i < messages.length; i++) {
      const turn = messages[i].turn;
      if (!turn?.providerId) continue;
      if (segments.at(-1)?.providerId === turn.providerId) continue;
      const startIndex = segments.length ? (i > 0 && messages[i-1].role === 'user' ? i-1 : i) : 0;
      const id = validSessionId(messages[i].segmentId) && !segments.some(seg => seg.id === messages[i].segmentId) ? messages[i].segmentId! : `${raw.sessionId}-${i}`.slice(0,80);
      segments.push({ id, sessionId: raw.sessionId, providerId: turn.providerId, providerLabel: turn.providerLabel ?? turn.providerId,
        startIndex, contextCarryMode: 'fresh', createdAt: messages[i].createdAt! });
    }
  }
  if (!segments.length) segments = [{ id: fallbackId, sessionId: raw.sessionId, providerId: raw.providerId,
    providerLabel: raw.providerId === 'openai' ? 'OpenAI' : raw.providerId, startIndex: 0, contextCarryMode: 'fresh', createdAt: raw.createdAt }];
  for (let i = 0; i < messages.length; i++) {
    const seg = [...segments].reverse().find(item => item.startIndex <= i)!;
    messages[i].segmentId = seg.id;
    if (messages[i].turn) { messages[i].turn!.providerId ??= seg.providerId; messages[i].turn!.providerLabel ??= seg.providerLabel; }
  }
  const current = segments.at(-1)!;
  const rollingRaw = object(raw.rolling);
  const rolling = rollingRaw && time(rollingRaw.updatedAt) && rollingRaw.sessionId === raw.sessionId
    && Array.isArray(rollingRaw.activeTargets) && rollingRaw.activeTargets.length <= 4
    && rollingRaw.activeTargets.every(target => workspaceIdentity(target) !== undefined)
    && Array.isArray(rollingRaw.recentActions) && rollingRaw.recentActions.length <= 4 && rollingRaw.recentActions.every(action => string(action, 180))
    && (rollingRaw.phase === undefined || (typeof rollingRaw.phase === 'string' && ['plan', 'implement', 'debug', 'test', 'review', 'investigate'].includes(rollingRaw.phase)))
    && (rollingRaw.route === undefined || route(rollingRaw.route))
    && Object.entries({ currentObjective: 700, lastOutcome: 400, recentError: 400, pendingNextStep: 400 }).every(([key, max]) => rollingRaw[key] === undefined || string(rollingRaw[key], max)) ? parseSessionState(rollingRaw) : undefined;
  return { schemaVersion: 3, sessionId: raw.sessionId, segmentId: current.id, providerId: current.providerId, title: raw.title,
    createdAt: raw.createdAt, updatedAt: raw.updatedAt, execution: { autoOn: execution.autoOn,
      ...(manual ? { manual: { modelId: manual.modelId as string, ...(manual.effort ? { effort: manual.effort as string } : {}) } } : {}) },
    segments, messages, rolling: repaired ? undefined : rolling, turn: [...messages].reverse().find(message => message.turn)?.turn };
}
const summary = (session: SavedSession): SessionSummary => ({ sessionId: session.sessionId, title: session.title, createdAt: session.createdAt,
  updatedAt: session.updatedAt, providerId: session.providerId, status: session.turn?.status });
function parseSummary(value: unknown): SessionSummary | undefined {
  const raw = object(value);
  if (!raw || !validSessionId(raw.sessionId) || !string(raw.title, 1000) || !time(raw.createdAt) || !time(raw.updatedAt)
    || raw.updatedAt < raw.createdAt || !providerIdentity(raw.providerId) || (raw.status !== undefined && (typeof raw.status !== 'string' || !statuses.includes(raw.status)))) return;
  return { sessionId: raw.sessionId, title: raw.title, createdAt: raw.createdAt, updatedAt: raw.updatedAt, providerId: raw.providerId,
    status: raw.status === 'running' ? 'interrupted' : raw.status as TurnStatus | undefined };
}
/** One workspace, one serialized writer. No settings, telemetry, raw payloads or automatic retention. */
export class ChatSessionStore {
  private rows = new Map<string, SessionSummary>();
  private queue: Promise<unknown> = Promise.resolve();
  lastActive?: string;
  constructor(private readonly directory: string, private readonly diagnostic: (category: string) => void = () => {}) {}
  private file(id: string): string { if (!validSessionId(id)) throw new Error('Invalid chat identity'); return path.join(this.directory, `${id}.json`); }
  private async read(file: string): Promise<unknown> {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > maxBytes) throw new Error('Invalid chat file size');
      const bytes = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < bytes.length) { const result = await handle.read(bytes, length, bytes.length - length, length); if (!result.bytesRead) break; length += result.bytesRead; }
      if (length !== stat.size) throw new Error('Chat file changed during read');
      return JSON.parse(bytes.subarray(0, length).toString('utf8')); }
    finally { await handle.close(); }
  }
  private async atomic(file: string, data: unknown): Promise<void> {
    const bytes = JSON.stringify(data, null, 2) + '\n';
    if (Buffer.byteLength(bytes) > maxBytes) throw new Error('Chat file size limit');
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try { await fs.rename(temp, file); } finally { await fs.rm(temp, { force: true }); }
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work); this.queue = result.catch(() => {}); return result;
  }
  private async index(): Promise<void> { await this.atomic(path.join(this.directory, 'index.json'), { schemaVersion: 3, lastActive: this.lastActive,
    sessions: this.list(Number.MAX_SAFE_INTEGER) }); }
  async initialize(): Promise<void> {
    try {
      let indexValid = false, indexModified = 0;
      try {
        indexModified = (await fs.stat(path.join(this.directory, 'index.json'))).mtimeMs;
        const index = object(await this.read(path.join(this.directory, 'index.json')));
        if ((index?.schemaVersion === 1 || index?.schemaVersion === 2 || index?.schemaVersion === 3) && Array.isArray(index.sessions) && index.sessions.length <= 100000
          && (index.lastActive === undefined || validSessionId(index.lastActive))) {
          const parsed = index.sessions.map(parseSummary);
          if (parsed.every((row): row is SessionSummary => !!row) && new Set(parsed.map(row => row.sessionId)).size === parsed.length) {
            this.rows = new Map(parsed.map(row => [row.sessionId, row])); this.lastActive = index.lastActive as string | undefined; indexValid = true;
          }
        }
      } catch { /* Recover known files; a missing index is normal on first use. */ }
      let entries;
      try { entries = await fs.readdir(this.directory, { withFileTypes: true }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error;
      }
      if (!indexValid && entries.length) this.diagnostic('History index rebuilt');
      const ids = new Set(entries.filter(entry => entry.isFile() && entry.name.endsWith('.json') && validSessionId(entry.name.slice(0, -5))).map(entry => entry.name.slice(0, -5)));
      for (const id of this.rows.keys()) if (!ids.has(id)) this.rows.delete(id);
      for (const id of ids) {
        // Normal startup uses summaries. Rebuild orphans and records newer than the crash-resistant index.
        const row = this.rows.get(id);
        try {
          const stat = await fs.stat(this.file(id));
          if (!indexValid || !row || stat.mtimeMs >= indexModified) {
            const session = await this.load(id); if (session) this.rows.set(id, summary(session));
          }
        } catch { this.rows.delete(id); this.diagnostic('Chat could not be loaded'); }
      }
      if (!this.lastActive || !this.rows.has(this.lastActive)) this.lastActive = this.list(1)[0]?.sessionId;
      await this.index();
    } catch { this.diagnostic('History initialization failed'); }
  }
  list(limit = 6, offset = 0): SessionSummary[] {
    return [...this.rows.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.sessionId.localeCompare(b.sessionId)).slice(offset, offset + limit).map(row => ({ ...row }));
  }
  async load(id: string): Promise<SavedSession | undefined> {
    if (!validSessionId(id)) return;
    try { const raw = await this.read(this.file(id)); const session = parseSavedSession(raw);
      if (!session || session.sessionId !== id) throw new Error('Invalid chat');
      if (object(raw)?.rolling !== undefined && !session.rolling) this.diagnostic('Chat runtime continuity reset');
      return session; }
    catch { this.rows.delete(id); if (this.lastActive === id) this.lastActive = undefined; this.diagnostic('Chat could not be loaded'); }
  }
  save(session: SidebarChatSession): Promise<boolean> {
    if (!session.messages.some(message => message.role === 'user' && message.text.trim())) return Promise.resolve(false);
    const normalized = parseSavedSession({ ...session, schemaVersion: 3 }, false);
    if (!normalized) return Promise.reject(new Error('Chat could not be serialized'));
    // Capture now, before another streaming delta or session switch can mutate the input.
    return this.serial(async () => { const { turn: _turn, ...stored } = normalized;
      await this.atomic(this.file(normalized.sessionId), stored); this.rows.set(normalized.sessionId, summary(normalized));
      this.lastActive = normalized.sessionId;
      // The flushed session replacement is the commit point. A stale index is recoverable
      // from the newer session file; it must not make a committed boundary appear failed.
      try { await this.index(); } catch { this.diagnostic('History index update deferred'); }
      return true; });
  }
  activate(id?: string): Promise<void> { return this.serial(async () => { this.lastActive = id && this.rows.has(id) ? id : undefined; await this.index(); }); }
  delete(id: string): Promise<void> { return this.serial(async () => {
    await fs.rm(this.file(id), { force: true }); this.rows.delete(id); if (this.lastActive === id) this.lastActive = undefined; await this.index();
  }); }
  async search(query: string, offset = 0): Promise<SessionPage> {
    await this.flush();
    const normalized = query.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim();
    const matches: SessionSummary[] = [];
    for (const row of this.list(Number.MAX_SAFE_INTEGER)) {
      if (!normalized) { matches.push(row); }
      else {
        const session = await this.load(row.sessionId); if (!session) continue;
        const text = [session.title, ...session.messages.filter(message => message.role === 'user').map(message => message.text)].find(text => text.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').includes(normalized));
        if (text !== undefined) {
          const clean = text.replace(/\s+/gu, ' ').trim();
          const at = clean.normalize('NFC').toLowerCase().indexOf(normalized);
          matches.push({ ...row, snippet: sessionTitle([...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(clean)].filter(part => part.index >= Math.max(0, at - 30)).map(part => part.segment).join('')) });
        }
      }
      if (matches.length > offset + 50) break;
    }
    return { items: matches.slice(offset, offset + 50), offset, hasMore: matches.length > offset + 50 };
  }
  async flush(): Promise<void> { await this.queue; }
}
