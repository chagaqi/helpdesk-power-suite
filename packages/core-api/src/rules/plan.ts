import type { Primitive } from '../types.js';
import type { Evaluation } from './types.js';

/** Platform-neutral UI operation a shell performs on the ticket form. */
export type EnforcementOp =
  | { op: 'hide' | 'show' | 'disable' | 'enable'; fieldId: string; key: string }
  | { op: 'set'; fieldId: string; key: string; value: Primitive | Primitive[] };

export interface AppliedState {
  /** fieldId -> platform key, so restores can address fields no rule mentions anymore. */
  hidden: Map<string, string>;
  disabled: Map<string, string>;
  values: Map<string, string>;
}

export const emptyApplied = (): AppliedState => ({ hidden: new Map(), disabled: new Map(), values: new Map() });

/**
 * Computes the minimal op list moving the form from `prev` (what this shell already applied) to the
 * evaluation's target. Fields no longer hidden/disabled by any rule are restored, so re-evaluation
 * after a field change never leaves stale UI state. Returns the new applied state.
 */
export function diffEnforcement(ev: Evaluation, prev: AppliedState = emptyApplied()): { ops: EnforcementOp[]; applied: AppliedState } {
  const ops: EnforcementOp[] = [];
  const next = emptyApplied();
  for (const st of Object.values(ev.fields)) {
    if (st.hidden) next.hidden.set(st.fieldId, st.key);
    if (st.disabled) next.disabled.set(st.fieldId, st.key);
  }
  // Restore first (show/enable) so a field moving between rules never flashes hidden.
  for (const [id, key] of prev.hidden) if (!next.hidden.has(id)) ops.push({ op: 'show', fieldId: id, key });
  for (const [id, key] of prev.disabled) if (!next.disabled.has(id)) ops.push({ op: 'enable', fieldId: id, key });
  for (const [id, key] of next.hidden) if (!prev.hidden.has(id)) ops.push({ op: 'hide', fieldId: id, key });
  for (const [id, key] of next.disabled) if (!prev.disabled.has(id)) ops.push({ op: 'disable', fieldId: id, key });
  for (const st of Object.values(ev.fields)) {
    if (!st.setValue) continue;
    const sig = JSON.stringify(st.value ?? null);
    next.values.set(st.fieldId, sig);
    if (prev.values.get(st.fieldId) !== sig) ops.push({ op: 'set', fieldId: st.fieldId, key: st.key, value: st.value ?? null });
  }
  return { ops, applied: next };
}
