import { z } from 'zod';
import { RULE_ACTIONS } from './types.js';

const primitive = z.union([z.string().max(10_000), z.number(), z.boolean(), z.null()]);
const refInput = z.union([
  z.string().min(1).max(300),
  z.object({ id: z.union([z.string().max(100), z.number()]).optional(), name: z.string().max(300).optional() }).refine((v) => v.id !== undefined || !!v.name, 'id or name required'),
]);
const stringList = z.array(z.string().min(1).max(200)).max(200);

export const fieldDefSchema = z.object({
  id: z.union([z.string().min(1).max(100), z.number()]).transform(String),
  name: z.string().min(1).max(300),
  key: z.string().max(150).optional(),
  type: z
    .enum(['text', 'textarea', 'number', 'decimal', 'checkbox', 'date', 'dropdown', 'multiselect', 'regexp', 'lookup', 'unknown', 'system'])
    .catch('unknown')
    .optional(),
  options: z.array(z.object({ value: z.string().max(500), label: z.string().max(500) })).max(5000).optional(),
  system: z.boolean().optional(),
});

const namedRefSchema = z.object({ id: z.union([z.string().max(100), z.number()]).transform(String).optional(), name: z.string().min(1).max(300) });

export const catalogInputSchema = z.object({
  fields: z.array(fieldDefSchema).max(5000),
  groups: z.array(namedRefSchema).max(5000).default([]),
  customRoles: z.array(namedRefSchema).max(1000).optional(),
  forms: z.array(namedRefSchema).max(1000).optional(),
  brands: z.array(namedRefSchema).max(1000).optional(),
});

export const ruleInputSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(1_000_000).optional(),
  conditions: z
    .object({
      roles: stringList.optional(),
      notRoles: stringList.optional(),
      groups: z.array(refInput).max(500).optional(),
      notGroups: z.array(refInput).max(500).optional(),
      tags: z.object({ any: stringList.optional(), all: stringList.optional(), none: stringList.optional() }).optional(),
      forms: z.array(refInput).max(200).optional(),
      brands: z.array(refInput).max(200).optional(),
      fields: z
        .array(
          z.object({
            field: refInput,
            op: z.enum(['eq', 'neq', 'in', 'contains', 'empty', 'not_empty']).default('eq'),
            value: z.union([primitive, z.array(primitive).max(500)]).optional(),
          }),
        )
        .max(50)
        .optional(),
      isNewTicket: z.boolean().optional(),
    })
    .default({}),
  actions: z
    .array(
      z.object({
        type: z.enum(RULE_ACTIONS),
        field: refInput,
        value: z.union([primitive, z.array(primitive).max(500)]).optional(),
      }),
    )
    .min(1)
    .max(200),
});

export type RuleInput = z.infer<typeof ruleInputSchema>;

export const evalContextSchema = z.object({
  /** Optional: overridden by the authenticated principal unless the caller is an admin previewing. */
  user: z
    .object({
      id: z.string().max(100).optional(),
      role: z.string().max(100),
      customRole: z.string().max(200).optional(),
      groups: z.array(z.union([z.string().max(300), namedRefSchema])).max(500).default([]),
    })
    .optional(),
  ticket: z
    .object({
      tags: z.array(z.string().max(200)).max(1000).optional(),
      form: z.union([z.string().max(300), namedRefSchema, z.null()]).optional(),
      brand: z.union([z.string().max(300), namedRefSchema, z.null()]).optional(),
      fields: z.record(z.string(), z.union([primitive, z.array(primitive)]).optional()).optional(),
      isNew: z.boolean().optional(),
    })
    .optional(),
});
