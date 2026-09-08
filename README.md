# Hatamon Case

A QR-code prize reveal for Hatamon card events. A customer buys something,
gets a slip with a QR code, scans it, and opens an animated case that lands on
one of the prizes you configured. Staff see a hidden panel where they upload
prize pictures, set the odds, print ticket slips, and mark prizes as collected.

Everything runs on **Cloudflare Pages** (static pages + Functions) with one
**KV namespace** for storage. No build step, no framework, no database server.

```
public/            what the browser loads
  index.html       customer: ticket → case → reel → claim code
  admin.html       staff panel (password protected, noindex)
functions/api/     the API, one Pages Function
functions/_lib/    auth, storage, roll logic
```

## How an event works

1. **Before the event** — sign in at `/admin.html`, add prizes with pictures,
   set weights (odds) and stock, then generate tickets and hit **Print QR
   slips**.
2. **At the table** — flip the **Live** switch on. Hand a slip to each
   customer who buys something.
3. **Customer scans** the slip. Their phone opens `/?c=XXXX-XXXX`, the case
   unlocks, they tap it, the reel spins and stops on their prize. They get a
   six-character **claim code**.
4. **They show you the screen**, you type the claim code into the **Pulls**
   tab (or tap *Collected* next to it) and hand over the prize.
5. **After** — export the CSV if you want a record, then *Delete all tickets /
   pulls* in Settings to reset for next time.

Each ticket opens exactly once. The roll happens on the server, so the odds
cannot be changed from the phone, and the reel the customer sees is generated
from the same prize pool with the winner placed at a fixed position.

### Odds

Each prize has a **weight**. Its chance is `weight / sum of weights` over
prizes that are *in the case* and still in stock. The panel shows the live
percentage next to every prize as you type. A sold-out prize drops out of the
pool automatically and the others' odds rescale.

Toggle **Show odds to customers** in Settings if you want the percentages
visible on the customer screen.

### Without tickets

Turn off **Require a ticket code** in Settings and anyone with the link can
open the case, limited to *N* opens per phone per hour. Handy for a giveaway
sign, but tickets are the honest way to tie one open to one purchase.

## Deploy to Cloudflare Pages

You need a Cloudflare account and `npm` (Node 18+).

```bash
npm install
npx wrangler login

# 1. create the KV namespace and paste the id it prints into wrangler.toml
npm run kv:create

# 2. first deploy — creates the Pages project
npm run deploy
```

Then in the Cloudflare dashboard, open the Pages project → **Settings**:

- **Functions → KV namespace bindings**: variable name `HATAMON`, pick the
  namespace you created. (Wrangler picks this up from `wrangler.toml` on
  deploy, but confirm it is there.)
- **Environment variables → Production**: add `ADMIN_PASSWORD` as a
  **secret**. Optionally add `SESSION_SECRET` (any long random string) — if
  omitted, sessions are signed with a key derived from the password, so
  changing the password logs everyone out, which is fine.

Redeploy (`npm run deploy`) after adding bindings, then visit
`https://<project>.pages.dev/admin.html`.

### Git-connected deploys (alternative)

Connect this repo to Pages in the dashboard with:

- Build command: *(leave empty)*
- Build output directory: `public`

and configure the same KV binding and secret. Every push to your production
branch redeploys.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # set ADMIN_PASSWORD
npm run dev                      # http://localhost:8788
```

`wrangler pages dev` simulates KV locally (data lives in `.wrangler/`).

## API

Everything under `/api`. Customer routes are public; `admin/*` requires the
session cookie set by `POST /api/admin/login`.

| Method | Path | What |
| --- | --- | --- |
| GET | `/api/case` | Branding, settings and the drawable prize list |
| POST | `/api/open` | `{ ticket }` → rolls, returns `reel`, `winnerIndex`, `win` |
| GET | `/api/win/:idOrClaimCode` | Re-fetch a pull (used when the page reloads) |
| GET | `/api/img/:id` | Prize image (immutable, cached) |
| POST | `/api/admin/login` / `logout` | Session |
| GET | `/api/admin/state` | Settings, prizes with odds, counts |
| PUT | `/api/admin/settings` | Partial update |
| PUT | `/api/admin/prizes` | Replace the prize list |
| POST | `/api/admin/upload` | `multipart/form-data` with `file` → `{ imageId, url }` |
| GET/POST | `/api/admin/tickets` | List / generate `{ count, batch }` |
| POST | `/api/admin/tickets/void` | `{ code }` toggles void |
| GET | `/api/admin/wins` / `wins.csv` | Pull log |
| POST | `/api/admin/wins/redeem` | `{ claimCode }` or `{ id, redeemed }` |
| POST | `/api/admin/purge` | `{ what: "wins" \| "tickets" }` |

## Things to know

- **Stock is best-effort.** KV has no transactions; two people opening the
  last unit of a prize in the same second could both win it. At event scale
  this is a non-issue, but keep a spare.
- **Images** are downscaled in the browser to 900 px before upload and stored
  in KV, capped at 3 MB each.
- **Single password** for staff. Rotate it in the dashboard to revoke access.
- Ticket codes use an alphabet without `0/O/1/I/L/U`, so they are safe to read
  out loud if a QR scan fails.

## License

Vendored `public/js/vendor/qrcode.js` is © Kazuhiko Arase, MIT. Everything
else is yours.
