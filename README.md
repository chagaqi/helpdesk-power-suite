# Helpdesk Power Suite

One headless engine, four helpdesk shells. Replaces three high-install, low-rated marketplace apps with a single product:

| Incumbent (installs, rating) | Verbatim complaint | Fixed by |
| --- | --- | --- |
| Zendesk **Advanced Search** (5,986, 2.0★) | "more than 1,000 results cannot be downloaded… cannot resize columns… cannot stick to custom fields or include archived tickets" | Cursor export engine (no offset wall), resizable sticky columns, custom-field presets, archived toggle |
| Zendesk **Ticket Field Manager** (5,491, 3.0★) / Freshworks **Hide or Disable Fields based on User Roles** (725, 3.3★) | "numeric field IDs instead of the field name… no per-rule/per-group permissions… hidden fields flash" | Rule compiler by field **name**, per group / role / tag with priorities, cached local evaluation (zero flicker) |
| Zendesk **Bulk User Export** (741, 2.0★) / **Super Admin** (1,546, 2.0★) | "only pulls 100 users… no custom People/Org fields… doesn't filter suspended users or tags… switching tabs duplicates rows" | Unlimited cursor pages, custom fields by title, active/suspended/role/tag filters, strict ID dedupe + cursor-replay idempotency |

## Repository layout

```
packages/
  core-api/          Headless engine (TypeScript, Hono, Zod, fflate) — isomorphic where it matters
    src/export/      Module A: CursorExportEngine, normalizers (Zendesk/Freshdesk/Freshservice/Gorgias/Intercom),
                     UTF-8 BOM CSV, styled multi-tab XLSX writer, signed download links
    src/rules/       Module B: VisualFieldRuleEngine (name → ID catalog, priority evaluation, compiled rule sets,
                     diff-based enforcement ops) — rules/index.ts is dependency-free and bundled into sidebars
    src/billing/     EntitlementService (Free/Pro), Polar + Stripe + marketplace webhooks, checkout
    src/auth/        InstallService (per-install derived secrets, HS256 proxy tokens, anti-squatting), JWT
    src/stores/      IUsageStore: in-memory, Redis (Upstash REST or any RESP commander)
    src/http/        Hono routes (/v1/*)
  shell-kit/         Browser kit shared by shells: API client, cursor export runner, zero-flicker RuleEnforcer,
                     search/export UI with resizable sticky columns, visual rule builder
  shell-zendesk/     ZAF v2 app: nav_bar (search/export + rule admin), ticket_sidebar + new_ticket_sidebar (enforcer)
  shell-freshworks/  FDK 9 / platform 3.0 Crayons app for Freshdesk & Freshservice (full_page_app, ticket_sidebar,
                     ticket_background/new_ticket_background enforcer, serverless signer/exporter)
  shell-gorgias/     Gorgias companion: cursor exporter + HTTP-integration widget routes
  shell-intercom/    Intercom companion: cursor exporter + Canvas Kit inbox app
  gateway/           Single-file deployable server: dist/server.mjs (+ /playground demo)
```

## Quick start

```bash
npm install
npm run verify          # typecheck → build → validate app manifests → all tests (unit, contract, headless E2E)
npm start               # node packages/gateway/dist/server.mjs  → http://localhost:8787/playground
```

Deploy: copy `packages/gateway/dist/server.mjs` anywhere with Node ≥ 20 and set the env vars in `.env.example`
(or `docker build -t hps . && docker run -p 8787:8787 --env-file .env hps`). The bundle has zero runtime dependencies.

## HTTP API (core)

All `/v1/*` routes except install, webhooks and downloads require `Authorization: Bearer <JWT>` signed by the platform
proxy with the installation's shared secret. Errors are always `{ "error": { "code", "message", "details?" } }`.

| Method & path | Who | Purpose |
| --- | --- | --- |
| `POST /v1/install` | first admin (IP rate-limited) | Register a tenant; returns the one-time shared secret (stored in a secure setting) |
| `POST /v1/uninstall` | admin | Revoke installation; releases the tenant when none remain |
| `GET /v1/me` | agent | Tenant, user (from token), entitlement, monthly usage |
| `POST /v1/export/sessions` → `/:id/batches` → `/:id/finalize` | agent | Streaming cursor export (any number of pages) → signed CSV/XLSX link |
| `POST /v1/export/stream` | agent | One-shot export streamed back as UTF-8 BOM CSV |
| `POST /v1/export/xlsx` | agent | One-shot multi-tab styled workbook (+ summary tab) |
| `GET /v1/exports/:id?exp=&sig=` | anyone with the link | Ephemeral signed download (default 15 min) |
| `GET /v1/rules/config` | agent (admins get catalog + rules) | Compiled rule set with `ETag` / `304` |
| `PUT /v1/rules/catalog` | admin | Sync field / group / role / form / brand names |
| `POST /v1/rules/validate` · `POST /v1/rules` · `PUT/DELETE /v1/rules/:id` · `POST /v1/rules/reorder` | admin | Rule CRUD by name, priority ordering |
| `POST /v1/rules/evaluate` | agent (admins may preview as others) | Evaluate for the token's user + ticket context |
| `POST /v1/billing/checkout` | admin | Polar or Stripe hosted checkout carrying `tenant_key` |
| `POST /v1/webhooks/{polar,stripe,marketplace}` | providers | Signature-verified, idempotent entitlement updates |

### Export semantics

* **Cursor idempotency:** a batch whose `cursor` was already ingested is ignored (`replayed: true`) — re-fetching page 1
  after a tab switch can't duplicate anything.
* **Strict ID dedupe:** every row is keyed by record ID; newer versions (by `updated_at`) replace older ones in place,
  and a record that stops matching the filters in a newer version is removed.
* **Filters:** `userState` (active / suspended — suspended covers suspended, deleted, blocked, deactivated), `roles`
  (`admin`, `agent`, `light_agent`, `end_user`, `lead`), `tags.any/all/none`, ticket `statuses`, `includeArchived`, dates,
  custom-field filters by **title**, free text.
* **Columns:** standard columns + every custom field flattened under its human-readable title (dropdown values → option
  labels, multiselect → `a; b`, checkbox → boolean). Column presets accept titles or keys.
* **CSV:** UTF-8 BOM, CRLF, RFC 4180 quoting, spreadsheet formula-injection neutralised. **XLSX:** shared strings, bold
  filled header, frozen header row, autofilter, sized columns, typed numbers/booleans/dates, one tab per entity.

### Rule semantics

Rules are ordered by priority (lower first). For every field, each dimension — visibility (`hide`/`show`), editability
(`disable`/`enable`), requirement (`require`/`optional`) and value (`set_value`) — is decided by the **first** matching
rule, so "Tier 2 can see Refund Amount" above "hide Refund Amount from everyone" works the way admins read the list.
Conditions: roles / not-roles, groups / not-groups (by name), ticket tags (any/all/none), forms, brands, field-value
conditions, new-vs-existing ticket. A hidden field is never also required (warning returned).

## Security model

* The per-installation secret is derived (`HMAC(master, tenant|installation|salt)`) and shown once. Zendesk keeps it in a
  `secure: true` setting and signs requests in its proxy (`client.request({ secure: true, jwt })`); Freshworks keeps it in
  the server-side app data store and signs in serverless. Agents' browsers never see it.
* Tenant identity (and therefore the Pro entitlement) is taken from the verified token, never the request body. Re-registering
  an existing tenant requires an admin token of an existing installation or a Zendesk signed-URL RS256 proof → no plan
  borrowing by claiming someone else's subdomain.
* Tokens: HS256 only (`alg: none` rejected), audience-checked, max 1 h lifetime, single-use `jti`.
* Agent role/group claims come from the platform client context; admin-only routes enforce `role=admin`. Field rules
  are UX guardrails on top of the helpdesk's own permissions, not a replacement for them.
* Webhooks: Standard Webhooks (Polar) / Stripe signatures with 5-minute tolerance, idempotent by event id, out-of-order safe.
* Download links: HMAC-signed, expiring, `no-store`, `nosniff`. Playground: CSP with per-request nonce, IP rate limit.

## Tests

`npm test` runs every suite: core unit + HTTP contract tests, shell integration tests (fake ZAF / FDK runtimes wired to
the real API), Gorgias/Intercom adapters, the RESP client against a real `redis-server`, and headless Chromium E2E against
the built `dist/server.mjs` (playground + the real Zendesk bundles, including a timing test proving cached rules hide
fields before the rules request returns). Set `HPS_CHROMIUM` to a Chromium binary if it isn't at `/opt/pw-browsers/chromium`.

See [SUBMISSION_GUIDE.md](SUBMISSION_GUIDE.md) for marketplace packaging and listing copy.
