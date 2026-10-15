import type { CustomFieldType, FieldOption, Primitive } from '../types.js';

export const RULE_ACTIONS = ['hide', 'show', 'disable', 'enable', 'require', 'optional', 'set_value'] as const;
export type RuleActionType = (typeof RULE_ACTIONS)[number];

export type Dimension = 'visibility' | 'editability' | 'requirement' | 'value';

export const ACTION_DIMENSION: Record<RuleActionType, Dimension> = {
  hide: 'visibility',
  show: 'visibility',
  disable: 'editability',
  enable: 'editability',
  require: 'requirement',
  optional: 'requirement',
  set_value: 'value',
};

/** Ticket field as shown to admins in the rule builder. */
export interface FieldDef {
  /** Platform field id ("360001234", "priority", "cf_customer_tier"). */
  id: string;
  /** Human-readable name — what admins pick from. */
  name: string;
  /** Address used by the shell SDK: Zendesk "custom_field_360001234"/"priority", Freshdesk "cf_tier"/"priority". Defaults to id. */
  key?: string;
  type?: CustomFieldType | 'system';
  options?: FieldOption[];
  system?: boolean;
}

export interface NamedRef {
  id?: string;
  name: string;
}

export interface Catalog {
  fields: FieldDef[];
  groups: NamedRef[];
  /** Custom agent roles (Zendesk custom roles / Freshdesk roles). */
  customRoles?: NamedRef[];
  forms?: NamedRef[];
  brands?: NamedRef[];
  updatedAt?: string;
}

export interface FieldRef {
  id: string;
  name: string;
}

export type ConditionOp = 'eq' | 'neq' | 'in' | 'contains' | 'empty' | 'not_empty';

export interface FieldCondition {
  field: FieldRef;
  op: ConditionOp;
  value?: Primitive | Primitive[];
}

export interface RuleConditions {
  /** Canonical roles (admin, agent, light_agent, end_user) or custom role names. ANY must match. */
  roles?: string[];
  notRoles?: string[];
  /** Agent must belong to ANY of these groups. */
  groups?: NamedRef[];
  /** Agent must belong to NONE of these groups. */
  notGroups?: NamedRef[];
  tags?: { any?: string[]; all?: string[]; none?: string[] };
  forms?: NamedRef[];
  brands?: NamedRef[];
  /** ALL ticket field conditions must hold. */
  fields?: FieldCondition[];
  /** Restrict to new tickets (true) or existing tickets (false). */
  isNewTicket?: boolean;
}

export interface RuleAction {
  type: RuleActionType;
  field: FieldRef;
  value?: Primitive | Primitive[];
}

export interface FieldRule {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  /** Lower number = higher priority (evaluated first). First matching rule wins per field per dimension. */
  priority: number;
  conditions: RuleConditions;
  actions: RuleAction[];
  createdAt: string;
  updatedAt: string;
}

export interface EvalUser {
  id?: string;
  role: string;
  customRole?: string;
  groups: (NamedRef | string)[];
}

export interface EvalTicket {
  tags?: string[];
  form?: NamedRef | string | null;
  brand?: NamedRef | string | null;
  /** Current field values keyed by field id (preferred) or field name. */
  fields?: Record<string, Primitive | Primitive[] | undefined>;
  isNew?: boolean;
}

export interface EvalContext {
  user: EvalUser;
  ticket?: EvalTicket;
}

export interface FieldState {
  fieldId: string;
  name: string;
  key: string;
  hidden?: boolean;
  disabled?: boolean;
  required?: boolean;
  setValue?: boolean;
  value?: Primitive | Primitive[];
  decidedBy: Partial<Record<Dimension, string>>;
}

export interface Evaluation {
  fields: Record<string, FieldState>;
  matchedRuleIds: string[];
  /** Field ids referenced by conditions: shells re-evaluate when these change. */
  watchFieldIds: string[];
  warnings: string[];
}

/** Rule set shipped to shells for local (zero-flicker) evaluation. */
export interface CompiledRuleSet {
  version: string;
  generatedAt: string;
  rules: FieldRule[];
  fields: Record<string, { id: string; name: string; key: string }>;
  /** Rules beyond the plan cap that were left out. */
  inactiveRuleIds: string[];
}
