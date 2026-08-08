export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}
export interface UsageEvent {
  entryId: string;
  usage: Usage;
}
export const zeroUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: 0,
});
export function aggregateUsage(events: readonly UsageEvent[]): Usage {
  const seen = new Set<string>();
  return events.reduce((total, event) => {
    if (seen.has(event.entryId)) return total;
    seen.add(event.entryId);
    return {
      input: total.input + event.usage.input,
      output: total.output + event.usage.output,
      cacheRead: total.cacheRead + event.usage.cacheRead,
      cacheWrite: total.cacheWrite + event.usage.cacheWrite,
      totalTokens: total.totalTokens + event.usage.totalTokens,
      cost: total.cost + event.usage.cost,
    };
  }, zeroUsage());
}
