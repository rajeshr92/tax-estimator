# Tax Estimator — 2026 Federal Withholding vs. Liability

A single-page web app that answers one question as the year unfolds: **am I under-paying my federal income tax — by how much — and will it trigger an IRS underpayment penalty?**

It's built for W-2 employees with equity compensation (RSUs), where the flat 22% supplemental withholding on vests is often far below the true marginal rate, and the gap only surfaces in April.

## Privacy

- **All calculations run in the browser.** There is no backend, no analytics, and no network request carrying user data.
- Inputs are kept in the browser's **local storage** on the user's own device so they survive a reload. They are never synced or uploaded. The **Reset** button wipes them (clearing site data does too).
- If the page is hosted behind an auth gate (see *Deployment*), the gate only checks the visitor's email at sign-in and serves the static file. It never sees what is typed into the app.

## Features

**Inputs**
1. **Year to date** — earnings and federal tax withheld, straight off a paystub.
2. **Rest of the year** — remaining salary and cash bonus, each with a selectable withholding method:
   - *Track YTD rate* — live withheld ÷ earned from step 1
   - *Tax brackets* — payroll-style estimate from the annual base salary (optional W-4 Step 2 / two-earner schedule); for bonuses, the incremental rate of stacking the bonus on salary
   - *Flat 22%* (bonus) — IRS supplemental rate, with the mandatory 37% on supplemental wages over $1M
   - *Custom %*
3. **Shares already vested** — quick entry as shares × average price or a single dollar total, with an "already included in YTD" toggle (on by default) to prevent double-counting.
4. **Upcoming vests** — the what-if lever: a global predicted share price, per-vest price overrides, or a direct dollar value per vest; editable RSU withholding rate.
5. **Other** — standard or itemized deduction, spouse/other income with its withholding, qualifying children (child tax credit with phase-out), and a manual adjustments field.

**Results**
- **Verdict gauge** — projected liability vs. projected withholding, with the balance due or refund, effective and marginal rates.
- **Liability breakdown** — income → deduction → taxable income → tax per bracket → credits, and withholding by source.
- **Extra withholding per paycheck** — enter a W-4 line 4(c) amount and paychecks remaining; everything updates live.
- **Safe-harbor check** — independently evaluates the **90% of current-year tax** rule and the **110% of prior-year tax** rule (AGI over $150k), plus the under-$1,000 de minimis exception, and shows the **tipping point** (2025 tax × 11⁄9) where the cheaper target switches from one rule to the other.

**Experience**
- First-run walkthrough: privacy first, then what the tool does, then a worked example ("Maya") computed live through the real tax model. Replay any time via **How it works**, or force it with `?nux=1` in the URL.
- Mobile layout with a pinned live-verdict bar at the bottom of the screen; two-column layout on desktop.

## Tax model

Constants are from IRS **Rev. Proc. 2025-32** (tax year 2026). Bracket math was checked against the cumulative-tax figures published in that document at every threshold.

| | Married filing jointly | Single | Head of household |
|---|---|---|---|
| Standard deduction | $32,200 | $16,100 | $24,150 |
| 37% bracket begins | $768,700 | $640,600 | $640,600 |

Child tax credit: $2,200 per child, phasing out $50 per $1,000 of AGI above $400k (MFJ) / $200k (others).

**Not modeled:** long-term capital gains rates, Additional Medicare tax (0.9%), Net Investment Income Tax (3.8%), AMT, and state taxes. Use *Other tax adjustments* to fold in an estimate. This is a planning tool, not tax advice.

## Project layout

```
src/App.jsx           React component — all logic, tax constants, and UI (source of truth)
src/shell-head.html   Page shell: meta tags, React from cdnjs, localStorage shim
src/shell-tail.html
scripts/build.mjs     Compiles JSX ahead of time and writes dist/index.html
dist/index.html       Deployable single file (committed, so it can be uploaded as-is)
```

## Build

```bash
npm install
npm run build        # writes dist/index.html
```

Open `dist/index.html` directly in a browser to use it locally.

## Deployment (Cloudflare Pages + Access)

1. **Host:** Cloudflare dashboard → Workers & Pages → Create → Pages → *Upload assets*. Upload a folder containing `dist/index.html`. The site is served at `<project>.pages.dev`.
2. **Gate (optional, invite-only):** Zero Trust → Access controls → Applications → *Self-hosted*. Add two public hostnames: `<project>.pages.dev` and `*.<project>.pages.dev` (the wildcard covers per-deployment preview URLs). Add an **Allow** policy with **Include → Emails** listing every invitee, including yourself.
3. **Login methods:** Zero Trust → Integrations → Identity providers. One-time PIN works out of the box; add Google with an OAuth client whose redirect URI is `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`, and enable it on the application.
4. **Update:** Pages project → *Create new deployment* → upload the new build.

The Cloudflare Zero Trust free plan covers up to 50 users.

## Yearly maintenance

Bracket thresholds, standard deductions, and child tax credit values are hard-coded for 2026 at the top of `src/App.jsx` (`BRACKETS`, `STD_DEDUCTION`, `CTC_*`). When the IRS publishes the next year's inflation adjustments (usually October–November), update those constants, the year labels, and the prior-year reference in the safe-harbor card, then rebuild and redeploy.
