# Gorgias companion: HTTP integration setup

`@hps/shell-gorgias` adds two signed endpoints to the HPS gateway:

| Route | Purpose |
| --- | --- |
| `POST /gorgias/widget` | Gorgias HTTP integration callback. Returns field-rule hints for the ticket: hidden, read-only, required and preset values, plus `requiredMissing`. The rules are the ones admins build by field name in the HPS rule builder. |
| `POST /gorgias/export` | Runs a server-side cursor export of tickets, customers or agents (deduplicated by ID, filtered by state, role, tags and status). It returns a signed `downloadUrl` that is served by core's `GET /v1/exports/:id`. |

## 1. Gateway configuration

| Setting | Used for |
| --- | --- |
| `GORGIAS_WIDGET_SECRET` (≥ 16 chars) | The `widgetSecret` that verifies requests (static account token or `X-HPS-Signature`). |
| `PUBLIC_BASE_URL` | The `publicBaseUrl` that prefixes signed download links. |
| `GORGIAS_ACCOUNTS` (`acme=ops@acme.com:API_KEY,...`) | Gorgias API credentials per account, returned by `clientFactory(account)`. Without them `/gorgias/export` answers `404 not_found`. |

The bundled gateway (`packages/gateway`) mounts these routes automatically when `GORGIAS_WIDGET_SECRET` is set; the snippet below shows the equivalent manual composition.

```ts
import { createGorgiasRoutes, GorgiasClient } from '@hps/shell-gorgias';

const { app: core, deps } = createServices({ /* ... */ });
const root = new Hono();
root.route('/', createGorgiasRoutes({
  rules: deps.rules,
  entitlements: deps.entitlements,
  store: deps.store,
  signer: deps.signer,
  publicBaseUrl: deps.config.publicBaseUrl,
  widgetSecret: process.env.GORGIAS_WIDGET_SECRET!,
  downloadTtlSec: deps.config.downloadTtlSec,
  clientFactory: async (account) => {
    const creds = await loadGorgiasCredentials(account); // your secret store
    return creds ? new GorgiasClient({ account, email: creds.email, apiKey: creds.apiKey }) : null;
  },
}));
root.route('/', core);
```

## 2. Sync the field catalog once

Rules reference fields by human-readable name, so the tenant `gorgias:<account>` needs a field catalog first:

```ts
const defs = await client.listTicketCustomFields();          // GET /api/custom-fields?object_type=Ticket
await deps.rules.syncCatalog('gorgias:acme', { fields: gorgiasCatalogFields(defs), groups: teams });
```

## 3. Create the HTTP integration in Gorgias

In **Settings → Integrations → HTTP → Add HTTP integration**, enter the values from `http-integration.json`:

- **URL:** `https://<gateway>/gorgias/widget`, method **POST**, content type `application/json`.
- **Triggers:** ticket created and ticket updated.
- **Body:** the `form` template. Gorgias substitutes the `{{ticket.*}}` variables. The route accepts tags as a list or as a comma-separated string. It also accepts `custom_fields` as an object keyed by field id, a `[{id, value}]` array or a JSON string.
- **Response:** shows as data in the ticket's customer sidebar widget, where you can choose which keys to display (for example `hints` and `requiredMissing`).

### Authentication

Two schemes are accepted (both compared in constant time, `401` otherwise):

1. **Static per-account token (recommended for Gorgias).** Gorgias HTTP integrations can only send fixed headers, so add
   `X-HPS-Account-Token: <token>` where `token = hex HMAC-SHA256(GORGIAS_WIDGET_SECRET, "gorgias-account:<account>")`.
   The token is bound to the `account` in the body: one account's token cannot act for another. Generate it with
   `node -e "console.log(require('crypto').createHmac('sha256', process.env.GORGIAS_WIDGET_SECRET).update('gorgias-account:acme').digest('hex'))"`.
   Rotating `GORGIAS_WIDGET_SECRET` revokes every token.
2. **Per-request body signature** for callers that can compute it (relays, your own services):
   `X-HPS-Signature: sha256=<hex HMAC-SHA256(GORGIAS_WIDGET_SECRET, rawBody)>`.

Never put the widget secret itself in a header template.

## Role mapping and audience

- The Gorgias role `admin` maps to `admin`. Lite and observer agents map to `light_agent`. Every other role maps to `agent`.
- When the payload has a `user` (`{ id, role: {name}, team_ids }`), hints are computed for that agent.
- Otherwise hints are computed for the ticket's `assignee_user` and `assignee_team`. HTTP integrations fire on ticket events, not once per viewing agent.

## Response shape

```json
{
  "tenant": "gorgias:acme",
  "ticketId": "42",
  "version": "9f1c2a7e",
  "hints": [
    { "field": "Order Value", "fieldId": "102", "hidden": false, "disabled": false, "required": true },
    { "field": "Refund Reason", "fieldId": "101", "hidden": true, "disabled": true, "required": false }
  ],
  "requiredMissing": ["Order Value"],
  "matchedRuleIds": ["rule_..."],
  "warnings": []
}
```

Errors are always `{ "error": { "code", "message" } }`:

| Status | Code | When |
| --- | --- | --- |
| 400 | `invalid_request` | The request is invalid. |
| 401 | `unauthorized` | The signature is missing or wrong. |
| 404 | `not_found` | No Gorgias credentials are configured for the account. |
| 413 | `payload_too_large` | The request body is too large. |
| 502 | `upstream_error` | The Gorgias API refused the request or kept failing after bounded retries on 429/5xx. |
