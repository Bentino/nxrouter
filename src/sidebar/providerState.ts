import { NxProviderManager, NxProviderProfile } from '../runtime/providers';
import { validateAutoMapping } from '../runtime/autoConfiguration';
import { OpenAIAvailabilityMonitor } from '../runtime/openaiAvailabilityMonitor';

/** Current provider authorization/catalog, never restored from a session. */
export class SidebarProviders {
  private current: { id: string; label: string; connection: 'connected' | 'disconnected' | 'unavailable'; selectable: boolean }[] = [];
  private catalogs = new Map<string, { id: string; name: string; effortOptions: readonly string[] }[]>();
  private queue: Promise<void> = Promise.resolve();
  private availability = new Map<string, boolean>();
  constructor(private readonly monitor: OpenAIAvailabilityMonitor, readonly manager?: NxProviderManager) {}
  summaries() {
    if (this.manager) return this.current.map(item => ({ ...item }));
    const config = this.monitor.state();
    return config ? [{ id: config.providerId, label: 'OpenAI', connection: config.state === 'connected' ? 'connected' as const : 'unavailable' as const, selectable: config.state === 'connected' }] : [];
  }
  state(id: string) {
    const config = this.monitor.state();
    if (id === config?.providerId) return { connected: config.state === 'connected', auto: config.auto.available,
      models: (config.models ?? []).filter(model => model.availability === 'available'), label: this.summaries().find(item => item.id === id)?.label ?? 'OpenAI' };
    return { connected: this.current.some(item => item.id === id && item.selectable), auto: this.availability.get(id) === true,
      models: this.catalogs.get(id) ?? [], label: this.current.find(item => item.id === id)?.label ?? id };
  }
  profile(id: string, fallback: () => NxProviderProfile): NxProviderProfile {
    const provider = this.manager?.require(id);
    const profile = provider ? provider.profile?.() ?? { providerId: id, auto: { router: { modelId: '' }, tiers: {
      LOW: { modelId: '' }, MEDIUM: { modelId: '' }, HIGH: { modelId: '' }
    } } } : fallback();
    if (profile.providerId !== id) throw new Error('Provider-local mappings unavailable.');
    return profile;
  }
  refresh(discover = false): Promise<void> {
    const next = this.queue.then(() => this.refreshNow(discover));
    this.queue = next.catch(() => {}); return next;
  }
  private async refreshNow(discover: boolean): Promise<void> {
    await this.monitor.refresh(discover);
    if (!this.manager) return;
    const current = await this.manager.summaries();
    const catalogs = new Map<string, { id: string; name: string; effortOptions: readonly string[] }[]>();
    const availability = new Map<string, boolean>();
    for (const summary of current) {
      if (summary.id === this.monitor.state()?.providerId) continue;
      availability.set(summary.id, false);
      if (!summary.selectable) continue;
      try {
        const provider = this.manager.require(summary.id);
        const models = (await provider.listModels()).filter(model => !model.availability || model.availability === 'available');
        catalogs.set(summary.id, models.map(model => ({ id: model.id, name: model.name, effortOptions: [...(model.effortOptions ?? [])] })));
        const profile = provider.profile?.(), validated = await provider.autoAvailability?.();
        availability.set(summary.id, !!profile && validateAutoMapping(profile, models.map(model => model.id), true).available && (validated?.available ?? true));
      } catch { summary.selectable = false; summary.connection = 'unavailable'; }
    }
    // Never expose a temporarily emptied catalog during overlapping ready/account refreshes.
    this.current = current; this.catalogs = catalogs; this.availability = availability;
  }
}
