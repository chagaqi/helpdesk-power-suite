import { z } from 'zod';
import { ENTITIES, PLATFORMS, USER_ROLES } from '../types.js';

const FIELD_TYPES = ['text', 'textarea', 'number', 'decimal', 'checkbox', 'date', 'dropdown', 'multiselect', 'regexp', 'lookup', 'unknown'] as const;

export const customFieldDefSchema = z.object({
  key: z.union([z.string().min(1).max(200), z.number()]).transform(String),
  title: z.string().min(1).max(300),
  type: z.enum(FIELD_TYPES).catch('unknown').optional(),
  options: z
    .array(z.object({ value: z.union([z.string(), z.number(), z.boolean()]).transform(String), label: z.string().max(500) }))
    .max(10_000)
    .optional(),
  active: z.boolean().optional(),
});

const isoish = z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)), 'must be an ISO date');
const tagList = z.array(z.string().min(1).max(200)).max(500);

export const exportFiltersSchema = z.object({
  userState: z.enum(['all', 'active', 'suspended']).optional(),
  roles: z.array(z.enum(USER_ROLES)).max(10).optional(),
  tags: z.object({ any: tagList.optional(), all: tagList.optional(), none: tagList.optional() }).optional(),
  statuses: z.array(z.string().max(60)).max(50).optional(),
  includeArchived: z.boolean().optional(),
  createdAfter: isoish.optional(),
  createdBefore: isoish.optional(),
  updatedAfter: isoish.optional(),
  fieldFilters: z
    .array(
      z.object({
        field: z.string().min(1).max(300),
        op: z.enum(['eq', 'neq', 'contains', 'empty', 'not_empty']).optional(),
        value: z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]).optional(),
      }),
    )
    .max(50)
    .optional(),
  text: z.string().max(500).optional(),
});

export const sessionCreateSchema = z.object({
  entity: z.enum(ENTITIES),
  source: z.enum(PLATFORMS),
  fieldSchema: z.array(customFieldDefSchema).max(10_000).default([]),
  filters: exportFiltersSchema.default({}),
  columns: z.array(z.string().min(1).max(300)).max(2000).optional(),
  dedupe: z.enum(['keep_latest', 'keep_first']).optional(),
});

export const batchSchema = z.object({
  cursor: z.string().max(8192).nullable().optional(),
  nextCursor: z.string().max(8192).nullable().optional(),
  done: z.boolean().optional(),
  records: z.array(z.unknown()).max(10_000),
  format: z.enum(['raw', 'normalized']).optional(),
});

export const finalizeSchema = z.object({
  format: z.enum(['csv', 'xlsx']).default('csv'),
  delimiter: z.enum([',', ';', '\t']).optional(),
  filename: z.string().max(120).optional(),
  sheetName: z.string().max(100).optional(),
});

export const oneShotSchema = sessionCreateSchema.extend({
  records: z.array(z.unknown()).max(50_000),
  format: z.enum(['raw', 'normalized']).optional(),
  delimiter: z.enum([',', ';', '\t']).optional(),
  filename: z.string().max(120).optional(),
});

export const xlsxSchema = z.object({
  title: z.string().max(200).optional(),
  filename: z.string().max(120).optional(),
  sheets: z.array(oneShotSchema.extend({ sheetName: z.string().max(100).optional() })).min(1).max(10),
});

export const installSchema = z.object({
  platform: z.enum(['zendesk', 'freshdesk', 'freshservice', 'gorgias', 'intercom']),
  tenant: z.string().min(1).max(253),
  installationId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  appVersion: z.string().max(40).optional(),
  platformToken: z.string().max(8192).optional(),
});

export const reorderSchema = z.object({ ids: z.array(z.string().min(1).max(100)).min(1).max(5000) });
