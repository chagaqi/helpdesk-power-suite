# Submission Guide — Helpdesk Power Suite

Everything needed to package, list and get the four shells approved. All commands run from the repo root.

## 0. Pre-flight (every release)

```bash
npm ci
npm run verify      # typecheck → build → validate manifests → unit, contract and headless E2E tests
npm run package     # builds and writes the upload archives below
```

| Artifact | Path | Upload to |
| --- | --- | --- |
| Zendesk app | `packages/shell-zendesk/dist/helpdesk-power-suite-zendesk-1.0.0.zip` | Zendesk Marketplace developer portal (or `zcli apps:create` for a private install) |
| Freshworks app | `packages/shell-freshworks/dist/helpdesk-power-suite-freshworks-1.0.0.zip` | Freshworks Developer Portal → *New app* (same layout as `fdk pack`) |
| API gateway | `packages/gateway/dist/server.mjs` | Any Node ≥ 20 host / container (see §5) |
| Gorgias / Intercom | served by the gateway (`/gorgias/*`, `/intercom/canvas/*`) | Configured in each platform's developer settings (§3, §4) |

Release checklist:

- [ ] `npm run verify` green on the release commit (CI uploads the same archives as artifacts).
- [ ] Bump `version` in `packages/shell-zendesk/manifest.json` and root `package.json` together.
- [ ] Gateway deployed at the host listed in the Zendesk `domainWhitelist` and the Freshworks `api_host` default, with
      `HPS_MASTER_SECRET`, Redis and webhook secrets set (§5). `GET /healthz` returns `{"ok":true}`.
- [ ] Polar (or Stripe) product "Helpdesk Power Suite Pro — $19/month" exists and its webhook points at `/v1/webhooks/polar`.
- [ ] Screenshots captured (§6) and the support/privacy URLs below are live.

## 1. Zendesk Marketplace (ZAF v2)

**Package & validate**

```bash
npm run build -w @hps/shell-zendesk
npm run validate -w @hps/shell-zendesk     # offline checks: manifest, locations, logos 320/128 px, translations, whitelist
npm run package -w @hps/shell-zendesk
# Official validation / private install (needs Zendesk credentials):
npx @zendesk/zcli login -i
npx @zendesk/zcli apps:validate packages/shell-zendesk
npx @zendesk/zcli apps:create packages/shell-zendesk    # private install for review/testing
```

**Locations:** `support.nav_bar` (search/export + Field Rules admin), `support.ticket_sidebar`,
`support.new_ticket_sidebar` (zero-flicker enforcer). Parameters: `api_base_url` (url) and `shared_secret` (secure,
filled automatically on first admin open). `domainWhitelist: ["api.helpdeskpowersuite.com"]`.

**Listing copy**

- **Name:** Helpdesk Power Suite: Cursor Export & Field Rules
- **Tagline (≤ 80):** Export 50,000+ records with custom fields. Hide or require fields by group — no flicker.
- **Short description:** Export 50,000+ tickets, users & orgs to CSV/Excel with custom fields — and hide, lock or require ticket fields per group, role or tag by field name, with zero flicker.
- **Long description:** in `packages/shell-zendesk/translations/en.json` → `app.long_description` (Markdown; covers search/export, field rules, plans).
- **Categories:** Productivity · Reporting & Analytics · Admin tools
- **Pricing:** Free (250-row exports, 2 field rules) · Pro $19/month per account (unlimited exports and rules). For a
  Zendesk-billed paid listing, send plan changes to `/v1/webhooks/marketplace` (HMAC `X-HPS-Signature`); otherwise
  upgrades run through Polar/Stripe checkout inside the app.
- **Support:** support@helpdeskpowersuite.com · https://helpdeskpowersuite.com/docs/zendesk
- **Privacy:** https://helpdeskpowersuite.com/privacy

**Reviewer notes (paste into the submission form)**

> 1. Install the app (keep the default API URL). Open the Power Suite icon in the left nav as an **admin** once: the app
>    registers the account and stores its signing secret in the secure `shared_secret` setting automatically.
> 2. *Advanced Search & Export*: pick Users, set State = Active only, click **Export CSV**. Exports use
>    `/api/v2/users` cursor pagination (or `/api/v2/search/export` with a query, `/api/v2/incremental/tickets/cursor`
>    for archived tickets), so there is no 1,000-result limit. Drag a column edge in **Preview** to resize; widths persist.
> 3. *Field Rules*: create "Hide <custom field> for <group>" by picking the field and group by name. Open a ticket as an
>    agent in that group: the field is hidden on load via `ticketFields:<name>.hide`. Required rules block
>    `ticket.save` with a message.
> 4. The free plan caps exports at 250 rows and 2 rules (an upgrade notice is shown). Reviewer Pro access: send us the
>    review subdomain and we'll grant a complimentary Pro plan.
> Data: ticket/user records pass through our API only to build the file; exports are held for 15 minutes behind a
> signed, expiring link and then deleted. Secrets are never exposed to agents' browsers.

## 2. Freshworks Marketplace (FDK 9, platform 3.0 — Freshdesk & Freshservice)

**Package & validate**

```bash
npm run build -w @hps/shell-freshworks      # app/scripts/*.bundle.js + server/server.js (serverless)
npm run validate -w @hps/shell-freshworks   # offline: modules/locations, icons, request templates ↔ manifest, iparams, serverless exports
npm run package -w @hps/shell-freshworks
# With the Freshworks CLI (FDK 9.x: npm i -g https://cdn.freshdev.io/fdk/latest.tgz):
cd packages/shell-freshworks && fdk validate && fdk pack && fdk run   # local test at ?dev=true
```

**Modules:** `common.full_page_app` (search/export + rule builder, Crayons), `support_ticket` and `service_ticket`
`ticket_sidebar` (rules applying to the agent), `ticket_background` / `new_ticket_background` (zero-flicker enforcer,
`interface.trigger('hide'|'disable'|'setValue')`, intercepted `ticket.propertiesUpdated` for required fields).
Serverless: `onAppInstall` / `onAppUninstall`, SMI functions `hpsCall`, `fdPage`, `exportStep`. Request templates in
`config/requests.json`; iparams `api_host`, `freshworks_domain`, `freshworks_api_key` (secure).

**Listing copy**

- **Name:** Helpdesk Power Suite — Advanced Export & Field Rules
- **Short description:** Export every ticket, contact and company (all history, all custom fields) to CSV/Excel, and hide or lock ticket fields per group, role or tag — by field name, with no flicker.
- **Long description:**
  - Exports beyond Freshdesk's 30-day default and 300-page cap (keyset cursor over `updated_since`), with custom fields under their labels, active/blocked/deleted filtering, tags and status filters, strict de-duplication.
  - Field rules by name: hide, read-only, require or set a value per agent group, role or ticket tag, ordered by priority with overrides. Applied by a background app as the ticket opens.
  - Ticket data moves server-to-server (Freshworks serverless → Power Suite API); the signing secret lives only in the app's server-side data store.
- **Pricing:** Free (250 rows, 2 rules) · Pro $19/month per account.
- **Reviewer notes:** install with an admin API key → open the full-page app → Export Tickets (all history) → Field Rules → create "Hide <field> for <group>" → open a ticket as an agent in that group. Uninstall revokes the installation (`/v1/uninstall`) so reinstall works.

## 3. Gorgias (HTTP integration companion)

1. Set `GORGIAS_WIDGET_SECRET` (≥ 16 chars) and `GORGIAS_ACCOUNTS=acme=ops@acme.com:API_KEY` on the gateway.
2. Generate the account token: `node -e "console.log(require('crypto').createHmac('sha256', process.env.GORGIAS_WIDGET_SECRET).update('gorgias-account:acme').digest('hex'))"`.
3. In Gorgias → *Settings → Integrations → HTTP → Add*: import `packages/shell-gorgias/widget/http-integration.json`,
   set `X-HPS-Account-Token`, URL `https://<gateway>/gorgias/widget`, triggers *ticket created/updated*.
4. Exports: `POST /gorgias/export` (same auth) returns a signed CSV/XLSX link. Details: `packages/shell-gorgias/widget/README.md`.

**App-store blurb:** "Field-rule hints and unlimited, de-duplicated CSV/Excel exports of Gorgias tickets and customers, with custom fields by name."

## 4. Intercom (Canvas Kit inbox app)

1. Intercom Developer Hub → *New app* → **Canvas Kit** → Inbox: *Initialize URL* `https://<gateway>/intercom/canvas/initialize`,
   *Submit URL* `https://<gateway>/intercom/canvas/submit`.
2. Gateway env: `INTERCOM_CLIENT_SECRET` (verifies `X-Body-Signature`), `INTERCOM_ACCESS_TOKENS=<workspace_id>=<token>`.
3. Scopes: read contacts, companies, conversations, tags, data attributes.

**App-store blurb:** "See which conversation attributes are required or locked for you, and export contacts or companies — every custom attribute, tags by name, no duplicates — to CSV or Excel in one click."

## 5. Deploy the gateway

```bash
npm run build -w @hps/gateway             # → packages/gateway/dist/server.mjs (single file, no node_modules)
NODE_ENV=production HPS_MASTER_SECRET=… REDIS_URL=rediss://… PUBLIC_BASE_URL=https://api.helpdeskpowersuite.com \
POLAR_WEBHOOK_SECRET=… TRUST_PROXY=1 node packages/gateway/dist/server.mjs
# or: docker build -t hps . && docker run -p 8787:8787 --env-file .env hps
```

* Full variable list: `.env.example`. Production refuses to start without `HPS_MASTER_SECRET`.
* Storage: `REDIS_URL` (built-in RESP client, `redis://` or `rediss://`) or `UPSTASH_REDIS_REST_URL` + token. In-memory is
  for development only. Export sessions are held in process memory — run a single instance or use sticky routing.
* Billing webhooks: Polar → `https://<gateway>/v1/webhooks/polar` (events `subscription.*`); Stripe →
  `/v1/webhooks/stripe` (`checkout.session.completed`, `customer.subscription.*`). Checkouts carry `tenant_key`
  metadata (`zendesk:<subdomain>`, `freshdesk:<domain>` …).
* Public demo: `/playground` (rate-limited per IP; disable with `PLAYGROUND_ENABLED=0`).

## 6. Screenshots & assets

| Asset | Source |
| --- | --- |
| Zendesk `logo.png` 320×320, `logo-small.png` 128×128, `icon_nav_bar.svg` | `packages/shell-zendesk/assets/` (regenerate: `node packages/shell-zendesk/scripts/gen-assets.mjs`) |
| Freshworks `icon.svg` | `packages/shell-freshworks/app/styles/images/icon.svg` |
| Screenshots (1280×800) | Capture from a sandbox account: (1) Export with Preview + resized columns, (2) Field Rules list + editor, (3) agent ticket with a hidden/locked field, (4) Excel output with frozen header. The `/playground` page reproduces (1) and the rule preview without a sandbox. |

## 7. Known platform constraints (disclose if asked)

* Zendesk search results are capped by Zendesk itself; the app avoids the cap by using `search/export` and incremental
  cursor exports, which require an admin for incremental (archived) tickets.
* Freshdesk search is limited to 300 results, so query text is applied as a local filter over the full keyset export.
* Field rules hide fields in the agent UI only; data remains reachable via the helpdesk API and the helpdesk's own
  permissions (documented in the listing).
* Gorgias HTTP integrations send fixed headers only — authenticate with the per-account token.
* Intercom Canvas submit requests must answer within ~10 s; very large Intercom exports should use the API session flow.
