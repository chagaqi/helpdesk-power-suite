import type { EntityType, NormalizedRecord, Platform } from '../../types.js';
import { normalizeFreshworks } from './freshworks.js';
import { normalizeGorgias } from './gorgias.js';
import { normalizeIntercom } from './intercom.js';
import { asRaw, isoDate, NormalizationError, objectOrEmpty, requireId, tagList } from './shared.js';
import { normalizeZendesk } from './zendesk.js';

export { NormalizationError } from './shared.js';
export { zendeskFieldSchema } from './zendesk.js';
export { freshworksFieldSchema } from './freshworks.js';
export { intercomFieldSchema } from './intercom.js';

/** Converts one raw platform API object into a NormalizedRecord. */
export function normalizeRecord(source: Platform, entity: EntityType, raw: unknown): NormalizedRecord {
  switch (source) {
    case 'zendesk':
      return normalizeZendesk(entity, raw);
    case 'freshdesk':
    case 'freshservice':
      return normalizeFreshworks(source, entity, raw);
    case 'gorgias':
      return normalizeGorgias(entity, raw);
    case 'intercom':
      return normalizeIntercom(entity, raw);
    case 'generic':
      return normalizeGeneric(entity, raw);
  }
}

/** "generic" accepts already-normalized records (validated defensively). */
function normalizeGeneric(entity: EntityType, raw: unknown): NormalizedRecord {
  const r = asRaw(raw, 'record');
  const id = requireId(r);
  if (r.entity !== undefined && r.entity !== entity) throw new NormalizationError(`record ${id} has entity "${String(r.entity)}", expected "${entity}"`);
  const fields: NormalizedRecord['fields'] = {};
  for (const [k, v] of Object.entries(objectOrEmpty(r.fields))) {
    fields[k] = v === null || ['string', 'number', 'boolean'].includes(typeof v) ? (v as never) : JSON.stringify(v);
  }
  const role = typeof r.role === 'string' ? (r.role as NormalizedRecord['role']) : undefined;
  return {
    id,
    entity,
    source: 'generic',
    fields,
    tags: tagList(r.tags),
    customFields: { ...objectOrEmpty(r.customFields) },
    status: typeof r.status === 'string' ? r.status : undefined,
    role,
    suspended: r.suspended === true,
    archived: r.archived === true,
    createdAt: isoDate(r.createdAt),
    updatedAt: isoDate(r.updatedAt),
  };
}
