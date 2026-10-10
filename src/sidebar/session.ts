import type { NxReferenceDescriptor } from '../runtime/references';
import type { NxSessionState } from '../sessionState';
import type { NxTurnResult } from '../runtime/nxRuntime';
import type { SessionExecutionState } from '../runtime/executionSessions';

export type TurnStatus = 'running' | 'completed' | 'partial' | 'cancelled' | 'failed' | 'interrupted';
export interface ToolActivity {
  id: string; label: string; target?: string; lineRange?: string; command?: string;
  state: 'running' | 'success' | 'failed' | 'cancelled' | 'rejected' | 'interrupted'; durationMs?: number;
}
export interface ChatTurn {
  providerId?: string; providerLabel?: string;
  messageId: string; mode: 'auto' | 'manual'; status: TurnStatus; route?: string; modelId?: string; modelName?: string;
  effort?: string; escalation?: { from: string; to: string; completed: boolean }; notice?: string;
  tools: ToolActivity[]; changedFiles: string[];
}
export interface ChatMessage { id: string; segmentId?: string; role: 'user' | 'assistant'; text: string; references?: NxReferenceDescriptor[]; createdAt?: string; status?: TurnStatus; turn?: ChatTurn }
export interface ProviderSegment {
  id: string; sessionId: string; providerId: string; providerLabel: string; startIndex: number;
  contextCarryMode: 'fresh' | 'selected'; createdAt: string; carryCount?: number;
}
/** Visible history and compact runtime continuity are distinct session fields. */
export interface SidebarChatSession {
  sessionId: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  providerId: string;
  segmentId: string;
  segments?: ProviderSegment[];
  messages: ChatMessage[];
  execution: SessionExecutionState;
  rolling?: NxSessionState;
  responseMetadata?: NxTurnResult['metadata'];
  turn?: ChatTurn;
}
export interface SidebarChatSnapshot {
  preserveDraftFromSessionId?: string;
  providerLabel?: string;
  providerPickerAvailable?: boolean;
  segments?: ProviderSegment[];
  draftContext?: { id: string; descriptor: NxReferenceDescriptor; label: string }[];
  contextAvailable?: boolean;
  contextNotice?: string;
  sessionId: string;
  providerId: string;
  messages: ChatMessage[];
  autoOn: boolean;
  autoAvailable: boolean;
  manualModelId?: string;
  manualEffort?: string;
  models: { id: string; name: string }[];
  effortOptions: string[];
  manualValid: boolean;
  running: boolean;
  canSend: boolean;
  blockedReason?: string;
  status: string;
  executionLabel?: string;
}
