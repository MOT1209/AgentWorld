/**
 * Usage analytics + reputation metadata.
 *
 * Counters only; no free-form quality scores. Reputation is derived from
 * measurable data (executions, failures, incidents, verification state).
 */
export interface SkillUsageCounters {
  installations: number;
  executions: number;
  success: number;
  failure: number;
  totalDurationMs: number;
  permissionDenials: number;
  securityBlocks: number;
  updates: number;
  rollbacks: number;
  agents: string[];
}

export function blankCounters(): SkillUsageCounters {
  return {
    installations: 0,
    executions: 0,
    success: 0,
    failure: 0,
    totalDurationMs: 0,
    permissionDenials: 0,
    securityBlocks: 0,
    updates: 0,
    rollbacks: 0,
    agents: [],
  };
}

export class SkillUsageTracker {
  private readonly counters = new Map<string, SkillUsageCounters>();

  private getOrCreate(key: string): SkillUsageCounters {
    let current = this.counters.get(key);
    if (current === undefined) {
      current = blankCounters();
      this.counters.set(key, current);
    }
    return current;
  }

  recordInstallation(key: string): void {
    this.getOrCreate(key).installations += 1;
  }

  recordExecution(key: string, outcome: { success: boolean; durationMs: number; agentId?: string }): void {
    const c = this.getOrCreate(key);
    c.executions += 1;
    if (outcome.success) c.success += 1;
    else c.failure += 1;
    c.totalDurationMs += Math.max(0, Math.floor(outcome.durationMs));
    if (outcome.agentId !== undefined && !c.agents.includes(outcome.agentId)) {
      c.agents.push(outcome.agentId);
    }
  }

  recordPermissionDenial(key: string): void {
    this.getOrCreate(key).permissionDenials += 1;
  }

  recordSecurityBlock(key: string): void {
    this.getOrCreate(key).securityBlocks += 1;
  }

  recordUpdate(key: string): void {
    this.getOrCreate(key).updates += 1;
  }

  recordRollback(key: string): void {
    this.getOrCreate(key).rollbacks += 1;
  }

  snapshot(key: string): SkillUsageCounters {
    return { ...this.getOrCreate(key), agents: [...this.getOrCreate(key).agents] };
  }

  averageDurationMs(key: string): number {
    const c = this.getOrCreate(key);
    return c.executions === 0 ? 0 : Math.round(c.totalDurationMs / c.executions);
  }
}

export interface SkillReputation {
  usageCount: number;
  successfulExecutions: number;
  failedExecutions: number;
  securityIncidents: number;
  verified: boolean;
  publisher: string | null;
  lastReviewed: string | null;
}

export function buildReputation(input: {
  counters: SkillUsageCounters;
  verified: boolean;
  publisher: string | null;
  lastReviewed: string | null;
}): SkillReputation {
  return {
    usageCount: input.counters.executions,
    successfulExecutions: input.counters.success,
    failedExecutions: input.counters.failure,
    securityIncidents: input.counters.securityBlocks,
    verified: input.verified,
    publisher: input.publisher,
    lastReviewed: input.lastReviewed,
  };
}
