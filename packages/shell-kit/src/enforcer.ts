import {
  diffEnforcement,
  emptyApplied,
  evaluateCompiled,
  missingRequired,
  type AppliedState,
  type CompiledRuleSet,
  type EnforcementOp,
  type EvalTicket,
  type Evaluation,
  type Primitive,
} from '@hps/core-api/rules';
import type { HostUser, KeyValueStorage } from './types.js';

/** Platform UI primitives (ZAF client.invoke / FDK client.interface.trigger). */
export interface FieldOps {
  hide(key: string): void | Promise<void>;
  show(key: string): void | Promise<void>;
  disable(key: string): void | Promise<void>;
  enable(key: string): void | Promise<void>;
  setValue(key: string, value: Primitive | Primitive[]): void | Promise<void>;
}

export interface EnforcerDeps {
  ops: FieldOps;
  storage: KeyValueStorage;
  user: HostUser;
  /** Reads the ticket context; `fieldIds` lists fields whose values conditions depend on. */
  readTicket(fieldIds: string[]): Promise<EvalTicket>;
  /** Fetches the rule set; returns null when the cached etag is still current. */
  fetchRules(etag?: string): Promise<{ compiled: CompiledRuleSet; etag?: string } | null>;
  /** Subscribe to ticket changes that can flip conditions. Returns an unsubscribe fn. */
  watch?(fieldIds: string[], onChange: () => void): () => void;
  onError?(err: unknown): void;
}

const CACHE_KEY = 'hps.rules.compiled.v1';

interface Cached {
  etag?: string;
  compiled: CompiledRuleSet;
}

/**
 * Zero-flicker enforcement:
 *  1. Synchronously evaluates the locally cached compiled rule set and applies hide/disable ops
 *     immediately on ticket load (no network round-trip before fields are hidden).
 *  2. Revalidates the rule set in the background (ETag); applies only the diff if rules changed.
 *  3. Re-evaluates when watched fields / tags change; blocks saves with missing required fields.
 */
export class RuleEnforcer {
  private applied: AppliedState = emptyApplied();
  private compiled: CompiledRuleSet | null = null;
  private etag?: string;
  private lastEval: Evaluation | null = null;
  private unwatch?: () => void;
  private watchSig = '';
  readonly appliedOps: EnforcementOp[] = [];

  constructor(private readonly d: EnforcerDeps) {
    const cached = this.readCache();
    if (cached) {
      this.compiled = cached.compiled;
      this.etag = cached.etag;
    }
  }

  private readCache(): Cached | null {
    try {
      const raw = this.d.storage.get(CACHE_KEY);
      return raw ? (JSON.parse(raw) as Cached) : null;
    } catch {
      return null;
    }
  }

  get evaluation() {
    return this.lastEval;
  }

  get ruleSetVersion() {
    return this.compiled?.version ?? null;
  }

  /** Step 1 + 2. Resolves once the fresh rule set has been applied. */
  async start(): Promise<void> {
    if (this.compiled) await this.apply();
    try {
      const fresh = await this.d.fetchRules(this.etag);
      if (fresh) {
        this.compiled = fresh.compiled;
        this.etag = fresh.etag;
        this.d.storage.set(CACHE_KEY, JSON.stringify({ etag: fresh.etag, compiled: fresh.compiled } satisfies Cached));
        await this.apply();
      }
    } catch (e) {
      // Offline / API down: the cached rules keep being enforced.
      this.d.onError?.(e);
    }
  }

  /** Re-evaluates against the current ticket state and applies the minimal diff. */
  async apply(): Promise<Evaluation | null> {
    if (!this.compiled) return null;
    const watchIds = [...new Set(this.compiled.rules.flatMap((r) => (r.conditions.fields ?? []).map((f) => f.field.id)))];
    const ticket = await this.d.readTicket(watchIds);
    const ev = evaluateCompiled(this.compiled, { user: this.d.user, ticket });
    const { ops, applied } = diffEnforcement(ev, this.applied);
    for (const op of ops) {
      if (op.op === 'set') await this.d.ops.setValue(op.key, op.value);
      else await this.d.ops[op.op](op.key);
      this.appliedOps.push(op);
    }
    this.applied = applied;
    this.lastEval = ev;
    const sig = [...ev.watchFieldIds].sort().join(',');
    if (this.d.watch && sig !== this.watchSig) {
      // (Re)subscribe when the set of condition fields changes (e.g. after a rules refresh).
      this.unwatch?.();
      this.watchSig = sig;
      this.unwatch = this.d.watch(ev.watchFieldIds, () => void this.apply().catch((e) => this.d.onError?.(e)));
    }
    return ev;
  }

  /** Returns a user-facing error when required fields are empty, otherwise null. */
  async validateSave(): Promise<string | null> {
    if (!this.lastEval) await this.apply();
    const ev = this.lastEval;
    if (!ev) return null;
    const ids = Object.values(ev.fields).filter((f) => f.required).map((f) => f.fieldId);
    if (!ids.length) return null;
    const ticket = await this.d.readTicket(ids);
    const missing = missingRequired(ev, ticket.fields ?? {});
    return missing.length ? `Please fill in required field${missing.length > 1 ? 's' : ''}: ${missing.map((m) => m.name).join(', ')}` : null;
  }

  stop() {
    this.unwatch?.();
    this.unwatch = undefined;
    this.watchSig = '';
  }
}
