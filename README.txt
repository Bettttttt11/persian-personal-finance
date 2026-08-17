Persian Finance v10 — Complete Mini App redesign + reports + AI money/time + optional PIN

Replace ONLY the included files in GitHub:
- src/utils.js
- src/jalali.js
- src/auth.js
- src/business.js
- src/schema.js
- src/reports.js
- src/api.js
- src/ai.js
- src/telegram.js
- public/app.html
- public/app.css
- public/app.js

DO NOT replace wrangler.jsonc, src/google.js, or src/repository.js.

Deployment:
1) Extract this ZIP.
2) Upload/replace ONLY the included src/public files in GitHub.
3) Commit.
4) Wait until the NEW Cloudflare deployment is Success.
5) In Telegram run /setup once.
6) Confirm Schema: v10.
7) Fully close and reopen the Telegram Mini App.

v10 highlights:
- Full responsive Aurora/fintech redesign for phone, Telegram WebView, tablet, and desktop.
- Long text no longer breaks cards, rows, modals, or AI chat bubbles.
- Transactions show exactly one Jalali month at a time; current month is the default.
- Navigate to previous months without carrying future/current-month data into a new month.
- Full report filters: date, text, type, source, status, account, destination account,
  category, person, project, merchant, tag, installment plan, amount/fee ranges,
  time range, starred, fee, receipt, installment, and debt/receivable.
- Report summary includes income, net expense, fees, refunds, net, inflow, outflow,
  transfers, counts, and multiple breakdowns.
- CSV/Excel/PDF exports use the exact active report filters.
- Excel includes Summary, Transactions, Categories, and Breakdowns sheets.
- PDF includes summary totals plus transaction details and is sent to the Telegram bot chat.
- AI preserves explicit Rial/Toman units and numeric zero count deterministically.
- AI understands Persian money words such as "صد هزار تومان" and "یک میلیون و دویست هزار تومان".
- Natural transaction time support: e.g. at 17:00, "ساعت 4" resolves to the most plausible past 16:00.
- Manual transaction entry supports date plus HH:MM:SS.
- PIN is optional and can be enabled/changed/disabled from Telegram:
  Settings -> 🔐 رمز ورود
- Legacy BOT_PIN secret may remain in Cloudflare; disabling PIN from the bot overrides it.
- Existing Telegram Mini App signature auth, KV receipt storage, Google token/batch performance,
  transaction soft-delete, installment improvements, v9 AI confirmation/idempotency, transfer and receipt fixes are retained.

Validation:
- npm run check: PASS
- UI/API callback audit: PASS
- JavaScript syntax: 21 files PASS
- npm test: 23/23 PASS

Important:
- /setup is idempotent and should be run after deployment to migrate the schema.
- Do not manually change old Google Sheet values during migration.
