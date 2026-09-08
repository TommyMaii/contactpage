# Hatamon Case

A QR-code prize reveal for Hatamon card events. A customer buys something,
scans the QR sign on the table, and opens an animated case that lands on one
of the prizes you configured. Staff see a hidden panel where they upload
prize pictures, set the odds, print the sign, and mark prizes as collected.

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
   set weights (odds) and stock, then open the **QR sign** tab and hit
   **Print sign**.
2. **At the table** — put the sign out and flip the **Live** switch on.
3. **Customer buys something and scans the sign.** Their phone opens the
   case, they tap it, the reel spins and stops on their prize. They get a
   six-character **claim code**.
4. **They show you the screen**, you type the claim code into the **Pulls**
   tab (or tap *Collected* next to it) and hand over the prize.
5. **After** — export the CSV if you want a record, then *Delete all pulls*
   in Settings to reset for next time. Flip **Live** off whenever you leave
   the table so the sign stops working.

Each phone gets **one open per hour** by default (a cookie identifies the
phone; change the number in Settings if people buy more than once). The roll
happens on the server, so the odds cannot be changed from the phone, and the
reel the customer sees is generated from the same prize pool with the winner
placed at a fixed position. A claim code can only be marked collected once.

### Odds

Each prize has a **weight**. Its chance is `weight / sum of weights` over
prizes that are *in the case* and still in stock. The panel shows the live
percentage next to every prize as you type. A sold-out prize drops out of the
pool automatically and the others' odds rescale.

Toggle **Show odds to customers** in Settings if you want the percentages
visible on the customer screen.

### Ticket mode (optional)

If you want a stricter one-open-per-purchase guarantee, turn on **Require a
ticket code** in Settings. Then generate tickets in the **Tickets** tab, print
the sheet of QR slips, and hand one slip to each customer with their purchase.
Each slip's QR opens `/?c=XXXX-XXXX` and works exactly once; someone who
clears their cookies or uses a private tab cannot re-roll.

## Deploy to Cloudflare Pages

The easy way is to connect the GitHub repo in the Cloudflare dashboard, so
every push redeploys.

1. **Workers & Pages → Create → Pages → Connect to Git**, pick this repo.
   - Build command: *(leave empty)*
   - Build output directory: `public`
2. Once it has deployed, open the project → **Settings** and add:
   - **Bindings → Add → KV namespace**: variable name `HATAMON`. Create a
     namespace (any name) if you have none yet.
   - **Variables and secrets → Add**: type *Secret*, name `ADMIN_PASSWORD`,
     value = the staff password. Make sure it is on **Production**.
   - Optionally `SESSION_SECRET` (any long random string). Without it,
     sessions are signed with a key derived from the password, so changing
     the password simply signs everyone out.
3. **Bindings and secrets only apply to deployments made after you add
   them.** Trigger one by pushing any commit. Then visit
   `https://<project>.pages.dev/admin.html`.

### Deploying from your terminal instead

```bash
npm install
npx wrangler login
npm run kv:create        # paste the printed id into wrangler.toml and uncomment the block
npm run deploy           # creates the Pages project on first run
```

Then add the `ADMIN_PASSWORD` secret in the dashboard as above and run
`npm run deploy` once more.

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
- **Per-phone limit is a cookie**, so a determined person can re-roll in a
  private tab. Stock caps how much that can cost you; ticket mode closes the
  gap entirely.
- **Single password** for staff. Rotate it in the dashboard to revoke access.
- Ticket codes use an alphabet without `0/O/1/I/L/U`, so they are safe to read
  out loud if a QR scan fails.

## License

Vendored `public/js/vendor/qrcode.js` is © Kazuhiko Arase, MIT. Everything
else is yours.
