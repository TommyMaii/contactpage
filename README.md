# Hatamon Case

A QR-code prize reveal for Hatamon card events. A customer buys something,
scans the QR on the table, and an animated case opens on the shop's big
screen (or on their phone), landing on one of the prizes you configured.
Staff see a hidden panel where they upload prize pictures, set the odds,
print the sign, and mark prizes as collected.

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
   set weights (odds) and stock.
2. **At the table** — open `/display.html` on a laptop, tablet or TV facing
   the customers and click **Start display** (press `F` for fullscreen). It
   shows your branding, the prizes, and the QR code to scan. Flip the
   **Live** switch on in the admin panel.
3. **Customer buys something and scans the QR.** Their phone says "look at
   the screen"; on the display the reel spins and stops on their prize. A
   few seconds later the same prize appears on their phone too.
4. **Hand over the prize.** With *Hand out at the screen* on (the default)
   the pull is marked collected automatically and nobody types anything.
   Press **Space** on the display to move to the next customer early. A
   small QR stays in the corner while a reel plays, so the next people scan
   without waiting; scans queue up and play in order.
5. **After** — export the CSV if you want a record, then *Delete all pulls*
   in Settings to reset for next time. Flip **Live** off whenever you leave
   the table so the QR stops working.

Prefer to hand out prizes at a separate counter? Turn *Hand out at the
screen* off: the display and the phone then show a six-character **claim
code**, which you type into the **Pulls** tab (or tap *Collected*) when the
customer comes to collect.

Prefer the reel on the customer's own phone? Settings → **Where the case
opens** → *On the customer's phone*. Then scanning shows the case, they tap
it, and the reel plays in their hand. The **QR sign** tab prints a table sign
for either mode — handy so several people can scan at once without crowding
the screen.

There are **no limits by default**: staff are at the table, so anyone can
scan as often as they are told to. If you ever run it unattended, Settings →
*Limit opens per phone* gives each phone N opens per hour (a cookie
identifies the phone). The roll happens on the server, so the odds cannot be
changed from the phone, and the reel is generated from the same prize pool
with the winner placed at a fixed position. A claim code can only be marked
collected once.

If several people scan in a row, the display plays them one after another
and shows "2 more waiting". A screen name in the URL (`/display.html?screen=b`
together with a QR for `/?screen=b`) lets you run two tables from one deploy.

### Odds

Each prize has a **weight**. Its chance is `weight / sum of weights` over
prizes that are *in the case* and still in stock. The panel shows the live
percentage next to every prize as you type. A sold-out prize drops out of the
pool automatically and the others' odds rescale.

Toggle **Show odds to customers** in Settings if you want the percentages
visible on the customer screen.

### Locking expensive prizes until you have earned them

Every prize has an **Unlock after** number: how many pulls must have
happened before it can be won. A graded card with *Unlock after 40* sits in
the reel and the showcase from the first customer and looks exactly as
winnable as everything else, but has a 0 % chance until the 40th pull, after
which its normal weight applies. The Prizes tab shows "🔒 locked until pull
#40" and the running pull count. *Delete all pulls* in Settings resets the
count to zero.

If *Show odds to customers* is on, the percentages shown are computed as if
nothing were locked, so a locked prize does not give itself away.

### Ticket mode (optional)

If you want a stricter one-open-per-purchase guarantee, turn on **Require a
ticket code** in Settings. Then generate tickets in the **Tickets** tab, print
the sheet of QR slips, and hand one slip to each customer with their purchase.
Each slip's QR opens `/?c=XXXX-XXXX` and works exactly once; someone who
clears their cookies or uses a private tab cannot re-roll.

## Deploy to Cloudflare Pages

Bindings are declared in `wrangler.toml`, which is committed. With that file
present Cloudflare ignores any bindings set in the dashboard, so do not mix
the two: the file wins on every deploy.

```bash
npm install
npx wrangler login
npx wrangler kv namespace create HATAMON   # once; prints an id
```

Paste the printed id into `wrangler.toml` (`id = "..."`), commit it, then:

```bash
npm run deploy
```

Then in the Cloudflare dashboard, open the project → **Settings →
Variables and secrets** and add `ADMIN_PASSWORD` as a **Secret** on
**Production**. Optionally `SESSION_SECRET` (any long random string);
without it sessions are signed with a key derived from the password, so
changing the password simply signs everyone out. Secrets only apply to
deployments made after you add them, so run `npm run deploy` once more.

Visit `https://<project>.pages.dev/admin.html`.

If you connect the repo to Pages in the dashboard instead (build command
empty, output directory `public`), every push deploys and the same
`wrangler.toml` supplies the KV binding.

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
| POST | `/api/open` | `{ ticket?, screen? }` → rolls, returns `win` (+ `reel`, `winnerIndex` in phone mode) |
| GET | `/api/display?screen=` | Recent wins queued for that display (polled every 2 s) |
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

- **Free plan limits.** Cloudflare's free KV tier allows 1,000 writes and
  100,000 reads per day. One open uses about 4–6 writes and the display
  polls at 2 s (~43k reads over a full day), so the free plan comfortably
  covers roughly 150 opens a day. Busier than that, or running several
  events a month? Workers Paid is USD 5/month and lifts writes to a million.
- **The display works on a phone too.** Open `/display.html` on any phone or
  tablet: the layout stacks, and the ⛶ and *Next ▶* buttons top-right replace
  the keyboard shortcuts.
- **Display latency.** The display sees a scan instantly when the phone and
  the display reach the same Cloudflare location, which is the normal case
  at a venue. Rarely (phone on a different carrier route) it can take up to
  a minute; the customer's phone still shows their prize and claim code
  regardless.

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
