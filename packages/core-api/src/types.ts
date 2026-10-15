/** Shared, dependency-free domain types (safe to import from browser shells). */

export const PLATFORMS = ['zendesk', 'freshdesk', 'freshservice', 'gorgias', 'intercom', 'generic'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const ENTITIES = ['ticket', 'user', 'organization'] as const;
export type EntityType = (typeof ENTITIES)[number];

/** Canonical role vocabulary shared by exports and field rules. */
export const USER_ROLES = ['admin', 'agent', 'light_agent', 'end_user', 'lead'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export type Primitive = string | number | boolean | null;

/** A helpdesk record after platform normalization. */
export interface NormalizedRecord {
  /** Stable platform identifier (always a string; numeric IDs are stringified). */
  id: string;
  entity: EntityType;
  source: Platform;
  /** Standard columns keyed by canonical column key (see export/columns.ts). */
  fields: Record<string, Primitive>;
  tags: string[];
  /** Raw custom field values keyed by platform field key/id. Flattened later via the field schema. */
  customFields: Record<string, unknown>;
  status?: string;
  role?: UserRole;
  /** Users only: suspended, blocked, deactivated or deleted. */
  suspended?: boolean;
  /** Tickets only: archived/closed-and-archived. */
  archived?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export type CustomFieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'decimal'
  | 'checkbox'
  | 'date'
  | 'dropdown'
  | 'multiselect'
  | 'regexp'
  | 'lookup'
  | 'unknown';

export interface FieldOption {
  value: string;
  label: string;
}

/** Custom field definition used to flatten values by human-readable title. */
export interface CustomFieldDef {
  /** Platform key: Zendesk ticket field id ("360001234"), user field key ("plan"), Freshdesk "cf_tier", ... */
  key: string;
  /** Human-readable title shown to admins and used as the export column header. */
  title: string;
  type?: CustomFieldType;
  options?: FieldOption[];
  active?: boolean;
}
