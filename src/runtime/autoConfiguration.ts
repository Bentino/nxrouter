import { NxModelSelection, NxProviderProfile } from './providers';

export type MappingRole = 'Router' | 'LOW' | 'MEDIUM' | 'HIGH';
export type MappingValidity = 'unconfigured' | 'available' | 'unavailable';
export interface AutoConfiguration {
  available: boolean;
  mappings: Record<MappingRole, { modelId?: string; validity: MappingValidity; valid: boolean }>;
  missingOrUnavailable: MappingRole[];
}

/** The provider owns the catalog; adapters consume this normalized result. */
export function validateAutoMapping(profile: NxProviderProfile, modelIds: readonly string[], connected: boolean): AutoConfiguration {
  const ids = new Set(modelIds);
  const selection: Record<MappingRole, NxModelSelection> = {
    Router: profile.auto.router, LOW: profile.auto.tiers.LOW,
    MEDIUM: profile.auto.tiers.MEDIUM, HIGH: profile.auto.tiers.HIGH
  };
  const mappings = {} as AutoConfiguration['mappings'];
  const missingOrUnavailable: MappingRole[] = [];
  for (const role of ['Router', 'LOW', 'MEDIUM', 'HIGH'] as const) {
    const modelId = selection[role].modelId.trim() || undefined;
    const validity: MappingValidity = !modelId ? 'unconfigured' : connected && ids.has(modelId) ? 'available' : 'unavailable';
    mappings[role] = { modelId, validity, valid: validity === 'available' };
    if (!mappings[role].valid) { missingOrUnavailable.push(role); }
  }
  return { available: connected && missingOrUnavailable.length === 0, mappings, missingOrUnavailable };
}

export function invalidAutoMessage(state: AutoConfiguration): string {
  const role = state.missingOrUnavailable[0];
  if (!role) { return ''; }
  const item = state.mappings[role];
  return item.validity === 'unconfigured'
    ? `Auto routing is unavailable because the ${role} model is not configured.`
    : `Auto routing is unavailable because the configured ${role} model "${item.modelId}" is not available for the current OpenAI account.`;
}
