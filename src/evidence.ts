export const isolatedTools = { read: 'nx_spike_safe', write: 'nx_spike_write', verify: 'nx_spike_execute', dangerous: 'nx_spike_dangerous' } as const;
export const acceptanceEvents: object[] = [];
export function record(event: object): void {
  // Bounded diagnostic evidence only. Never used to choose a route or restore a session.
  acceptanceEvents.push(event);
  if (acceptanceEvents.length > 100) { acceptanceEvents.shift(); }
}

