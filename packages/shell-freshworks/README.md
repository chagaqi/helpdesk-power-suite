# Helpdesk Power Suite — Freshdesk & Freshservice app (FDK 9, platform 3.0)

| Location | File | Purpose |
| --- | --- | --- |
| `full_page_app` | `app/index.html` | Advanced Search & cursor export (CSV/XLSX) + Visual Field Rule builder (Crayons UI) |
| `ticket_background`, `new_ticket_background` | `app/background.html` | Invisible zero-flicker enforcer: hides / disables / sets fields as the page loads, blocks *Update* when required fields are empty |
| `ticket_sidebar` | `app/sidebar.html` | Shows the agent which rules apply on this ticket |

Serverless (`server/server.js`, generated from `src/server`):

* `onAppInstall` registers the account with the Power Suite API and stores the per-install signing secret in the app's server-side data store (`$db`). The secret never reaches a browser.
* `hpsCall` signs a short-lived HS256 JWT for each API call; `exportStep` fetches a Freshdesk page and pushes it to the export session server-to-server.
* Freshdesk list endpoints are page-capped (300) and `/tickets` defaults to the last 30 days; the pager uses `updated_since` (from the epoch) + keyset restarts, so exports cover all history.

Build & validate: `npm run build && npm run validate && npm run package` (or `fdk validate && fdk pack` with the Freshworks CLI).
