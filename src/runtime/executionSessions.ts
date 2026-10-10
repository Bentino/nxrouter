import { NxModelSelection } from './providers';

export interface SessionExecutionState { autoOn: boolean; manual?: NxModelSelection }

/** Live execution choices; Sidebar persistence restores them through current availability. */
export class ExecutionSessions {
  private readonly sessions = new Map<string, SessionExecutionState>();
  private readonly providers = new Map<string, string>();
  bind(sessionId: string, providerId: string): void { this.providers.set(sessionId, providerId); }
  has(sessionId: string): boolean { return this.sessions.has(sessionId); }
  delete(sessionId: string): void { this.sessions.delete(sessionId); this.providers.delete(sessionId); }
  restore(sessionId: string, state: SessionExecutionState, autoAvailable: boolean): void {
    this.sessions.set(sessionId, { autoOn: state.autoOn && autoAvailable, manual: state.manual && { ...state.manual } });
  }
  getOrCreate(sessionId: string, autoAvailable: boolean): SessionExecutionState {
    let state = this.sessions.get(sessionId);
    if (!state) { state = { autoOn: autoAvailable }; this.sessions.set(sessionId, state); }
    if (!autoAvailable) { state.autoOn = false; }
    return { ...state, manual: state.manual && { ...state.manual } };
  }
  setAuto(sessionId: string, on: boolean, autoAvailable: boolean): SessionExecutionState {
    const state = this.getOrCreate(sessionId, autoAvailable);
    state.autoOn = on && autoAvailable;
    this.sessions.set(sessionId, state);
    return { ...state };
  }
  setManual(sessionId: string, manual: NxModelSelection): SessionExecutionState {
    const state = this.sessions.get(sessionId) ?? { autoOn: false };
    state.manual = { ...manual }; state.autoOn = false;
    this.sessions.set(sessionId, state);
    return { ...state, manual: { ...manual } };
  }
  reconcile(autoAvailable: boolean, providerId = 'openai'): void {
    if (!autoAvailable) { for (const [id, state] of this.sessions) { if ((this.providers.get(id) ?? 'openai') === providerId) state.autoOn = false; } }
  }
}
