# Outpost

A self-hosted point of sale for independent artists: an in-person **register**, an online **shop**, and **live auctions**, all sharing one inventory. Card payments run through Stripe, so card numbers never touch your server.

> **A note from the maker.** I built Outpost for my own shop, to the best of my ability. It isn't perfect, and I can't promise it's free of bugs, security problems or legal gaps. It's free to use, but **use it at your own risk.** You run your own shop, so you're responsible for your payments, taxes, customers' information and the laws where you live. I'm not able to give support or legal advice.

## Start here

**New to this? Open [`docs/guide.html`](docs/guide.html) in your browser.** It walks you step by step from download to a live shop, including payments, using Outpost day to day, backups, and fixes for common problems. No coding needed.

## What Outpost is for

Outpost is for people who make things and are tired of marketplace fees and rules. It's free, you host it yourself (roughly $5 to $8 a month, see the guide for options), and your shop, your customers and your data are yours.

**A note on "handmade."** Outpost is built for artists and makers who make their own work. No software can check how something was made, so this is a community expectation, not something Outpost enforces. Every shop can show a "made by hand" statement and a per-product "how it's made" note, and reviews can only come from real paid orders. If you sell something that isn't handmade, say so plainly.

## Quick start (for developers)

Requires Node.js 20 or newer (22 LTS recommended).

```bash
npm install
cp .env.example .env     # then edit .env
npm start                # http://localhost:3000
```

Set `ADMIN_PASSWORD` (and your Stripe **test** keys when you're ready for card payments) in `.env`. Restart after changing `.env`. Online, Outpost refuses to start with a missing or obvious admin password.

**Hosting.** Set `DATA_DIR` to a persistent disk so the database (`outpost.db`) and uploaded photos survive redeploys, set `TRUST_PROXY=1` behind a proxy, and set `BASE_URL` to your public address. The included `render.yaml` sets this up on Render; Railway, Fly.io or any host with a persistent volume works the same way. Cloudflare Workers/Pages can't run Outpost as-is (no persistent local disk).

## Screens

| URL | What it is |
|---|---|
| `/` | Staff app (password protected): **In person**, **Auctions**, **Products**, **Orders**, **Settings** |
| `/store.html` | Public shop with search, categories and checkout |
| `/links` | Link-in-bio page (links, events, optional email signup) |
| `/privacy`, `/terms` | Privacy Policy and Terms of Service, written from your Settings |
| `/auction.html` | Public auction lots; `/auction.html?lot=3` is the live bidding screen |
| `/receipt.html?order=…&k=…` | Printable receipt (the link is private to each order) |

## Your own artwork

Drop `mascot.svg` and `sold.svg` into `public/art/`. The mascot appears at the bottom of the sidebar; the sold graphic appears on the sale-complete and thank-you screens. See `public/art/README.txt`.

## Auctions

1. **Auctions → New auction**: photo, title, starting bid, bid increment, and when it closes.
2. Bidders open the lot page, sign up with a name and email, and bid. Bids must beat the current bid by the increment. A bid in the last 2 minutes extends the lot by 2 minutes ("soft close").
3. When a lot closes, the highest bidder wins and an unpaid order is created (tax included). On the Auctions page use **Copy payment link** or **Email winner** to send them their link. The link stays valid until it's paid.
4. Winner doesn't pay? **Didn't pay → next bidder** removes their bid and offers the lot to the next-highest bidder.
5. You can remove a suspicious bid while a lot is open.

**Card on file (optional).** In Settings → Bidding you can require bidders to save a card (through Stripe) before bidding. The card is charged automatically, once, when a bidder wins. If the charge fails the winner can still pay with the normal payment link. Test this in Stripe test mode first.

Bidders are not email-verified, so anyone can type any email. Card-on-file, the human check and the blocklist greatly reduce fake bids.

## What's in the app

- **In person**: register with discount codes, cash / other / card (QR) payments.
- **Checkout**: buyers enter their address first, then see shipping and tax before paying on Stripe. Set flat shipping prices by region (with optional free shipping over an amount) and choose how online tax is worked out in Settings.
- **Links page and email list**: a link-in-bio page, plus an email signup whose list you download as a CSV and import into your own email service. Outpost sends no email.
- **About page**: a description of your shop plus links to your website and social accounts, set in Settings.
- **Option names and buyer questions**: name the option list (Size, Color…) and add up to 3 text boxes for buyers (engraving, name, gift note). Answers are saved on the order and shown on the receipt, in Orders, and in Stripe.
- **Options and SKUs**: a product can have options (sizes, colors) with their own stock, optional price and SKU. Stock is tracked per option, refunds restock the right option, and a barcode scanner (or typing a SKU + Enter) adds items at the register. CSV import/export supports `sku` and `variants` (`Small:5;Medium:3:32.50`).
- **Products**: shop labels (New, Last chance, Discontinued, Staff pick; "Sold out" and "Only a few left" appear automatically), bulk edit, CSV import and export, low-stock warnings.
- **Orders**: mark Packed / Shipped / Delivered with a tracking number, "Email buyer" opens a ready-written email in your email app, refunds (full or partial, with a note and optional restock).
- **Customers** and **Reports**: sales by day, where sales come from, best sellers, running low, what needs your attention, orders CSV.
- **Auctions**: "Ending soon" / "Final minutes" markers, buyers can Watch lots (shown in "Your bidding").
- **Reviews**: verified-purchase reviews only (a real paid order is required), with seller replies and a public count of hidden reviews.
- **Disputes**: Orders → Manage → Dispute evidence page collects what you need for a Stripe chargeback.
- **Settings**: tax, pause sales (optionally scheduled, with a "back on" date), refund policy, discount codes, order limits, colors (presets or custom, plus text colors for body, headings, links and buttons), graphics, protection.

Outpost does **not** send emails by itself (that needs an email service). Stripe emails card receipts for you; for everything else use the "Email buyer" / "Email winner" buttons.

## Refunds

Set your policy in **Settings → Refund policy**. It shows at checkout and on receipts. Refund from **Orders → Manage**. Card orders are refunded through Stripe; cash/other sales are just recorded. If you already refunded in your Stripe dashboard, tick "I already refunded this in Stripe". Test a refund with Stripe test keys before relying on it.

## Protection from bots and scammers

Built in, no setup: a hidden-field trap, a minimum-time check, rate limits per visitor and for the whole shop, a per-item order limit (default 10, change in Settings), disposable-email blocking, discount-code guessing limits, and a blocklist (Settings → Protection, or the Block buttons on Customers and bid lists). Unpaid orders never hold your stock; stock only goes down when a payment succeeds.

Strongly recommended:

1. **Turn on the human check (free).** Make a Cloudflare Turnstile widget, then put the two keys in `.env` as `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` and restart. Visitors then pass a quick check before checkout and before joining to bid. If the check can't be verified, Outpost says no (it fails closed).
2. **Turn on Radar in Stripe** (Settings → Radar) to screen stolen cards.
3. When you put Outpost online behind a host, set `TRUST_PROXY=1` so limits count each visitor separately.

Bidder sign-up doesn't verify email addresses (so a bidder could use someone else's email). The human check, rate limits and blocklist reduce abuse; you can also remove any bid from the Auctions page.

## Stripe webhook (required for card payments)

Orders are marked paid and stock is decremented only when Stripe confirms payment via webhook.

- Local dev: install the Stripe CLI, run `stripe listen --forward-to localhost:3000/webhook`, and copy the `whsec_...` it prints into `STRIPE_WEBHOOK_SECRET`.
- Production: add an endpoint `https://YOUR-DOMAIN/webhook` in the Stripe Dashboard (payload style **Snapshot**, not Thin) for the events `checkout.session.completed` and `checkout.session.expired`.

## Before going live

- Serve over HTTPS and set `BASE_URL` to your real address (payment links and QR codes use it).
- Use a long random `ADMIN_PASSWORD`; test end to end with Stripe test cards (`4242 4242 4242 4242`) before switching to live keys.
- Back up regularly with Settings → Back up your shop → Download backup (one file with the database and photos).
- Tax, shipping prices and refunds are set up in Settings. A physical card reader (Stripe Terminal) is not built in yet.

## Licence and legal

Outpost is MIT licensed (see `LICENSE`). `docs/` has plain-language **Terms of Sale** and **Privacy Notice** templates for sellers to adapt. They are starting points, not legal advice. Sellers are responsible for their own taxes, consumer-law obligations and payments compliance.
