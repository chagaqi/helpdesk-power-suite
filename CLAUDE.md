# CLAUDE.md — Autonomous Engineering Rules for `helpdesk-power-suite`

## 1. Project Identity & Verified Market Proof
`helpdesk-power-suite` is Repo #2 in our B2B Marketplace Factory. It directly attacks three high-install "Zombie Incumbents" verified in our 18,645-app scrape that require ZERO external third-party APIs:
1. **Zendesk `Advanced Search` (5,986 installs, 2.0★)** — Verbatim complaints: *"Any search that has more than 1,000 results cannot be downloaded... cannot resize columns... cannot stick to custom fields or include archived tickets."*
2. **Zendesk `Ticket Field Manager` (5,491 installs, 3.0★) & Freshworks `Hide or Disable Fields based on User Roles` (725 installs, 3.3★)** — Verbatim complaints: *"Configuration is extremely finicky (you have to use numeric field IDs instead of seeing the field name!). You cannot set permissions on a per-rule/per-group basis. Hidden fields flash for a few seconds."*
3. **Zendesk `Bulk User Export` (741 installs, 2.0★) & `Super Admin` (1,546 installs, 2.0★)** — Verbatim complaints: *"Broken, only pulls 100 users period... doesn't export custom People/Org fields... doesn't filter out suspended users or filter by tags... switching tabs duplicates rows."*

## 2. Architecture: 1 Headless Core Engine + 4 Helpdesk Shells
- `packages/core-api/` (TypeScript + Hono + Zod):
  1. **Streaming Cursor Export Engine (`POST /v1/export/stream` & `POST /v1/export/xlsx`):** Normalizes cursor-paginated batches of Tickets, Users, or Organizations from Zendesk/Freshdesk/Gorgias/Intercom, flattens nested custom fields by human-readable field label, filters by tags/status/active-vs-suspended/role, deduplicates strictly by ID (fixing the duplicate bug), and outputs clean UTF-8 BOM CSV or multi-tab styled `.xlsx` workbooks capable of 50,000+ rows without hitting the 1,000-row offset search wall.
  2. **Visual Rule & Field Permission Compiler (`POST /v1/rules/evaluate` & `GET /v1/rules/config`):** Allows admins to pick fields by **human-readable name** (auto-mapped to IDs) and build per-group / per-role / per-tag conditional visibility rules (`hide`, `disable`, `require`, `set_value`) with zero UI flicker.
  3. **Entitlement & Anti-Spoofing (`EntitlementService.ts`):** Free tier allows exports up to 250 rows and 2 field rules; Pro tier ($19/mo via Polar.sh / Stripe / Native Marketplace billing) unlocks unlimited 100k+ cursor exports and unlimited role/group field rules.
- `packages/shell-zendesk/`: ZAF v2 app with **two locations**: `nav_bar` (for the Advanced Cursor Search, Custom-Field User/Ticket Explorer, Resizable Columns & Bulk CSV/XLSX Exporter + Visual Field Rule Builder by Field Name) AND `ticket_sidebar` / `new_ticket_sidebar` (tiny zero-flicker script that enforces the hide/disable/require field rules instantaneously on ticket load).
- `packages/shell-freshworks/`: FDK v9 Crayons app for Freshdesk & Freshservice (`full_page_app` for Advanced Search/Export & Visual Rule Admin + `ticket_sidebar` for instant role-based field hiding/disabling).
- `packages/shell-gorgias/` & `packages/shell-intercom/`: Companion sidebar/export adapters.
- `packages/gateway/`: Single-file bundled server (`dist/server.mjs`) running `core-api`, Redis/in-memory stores, Polar/Stripe webhooks, and the `/playground` interactive demo UI.
