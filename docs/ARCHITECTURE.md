# معماری و قراردادهای سیستم

## اصل جداسازی

Telegram و Mini App هیچ‌کدام مالک داده نیستند. جریان اصلی به شکل زیر است:

`Telegram / Mini App → Auth → API or Bot Controller → Finance/Report/Import/AI Service → Repository → Google Sheets / R2`

تمام Entityهای مالی ID پایدار دارند. Repository با Header mapping کار می‌کند و row number را فقط به‌عنوان جزئیات داخلی یک request می‌شناسد.

## ماژول‌ها

| فایل | مسئولیت |
|---|---|
| `src/index.js` | routing Worker، Durable Object write gate، scheduled handler |
| `src/google.js` | Google Service Account JWT و Sheets REST API |
| `src/repository.js` | CRUD مبتنی بر ID/Header، batch write، audit، idempotency |
| `src/schema.js` | تعریف Sheet/Header، migration و seed اولیه |
| `src/auth.js` | Telegram initData، PIN، lockout، session cookie |
| `src/business.js` | transaction/debt/receivable/installment/split/merge |
| `src/reports.js` | filters، search، dashboard، reports، budget |
| `src/imports.js` | CSV normalization، duplicate detection، reconciliation |
| `src/storage.js` | R2 receipt/file lifecycle |
| `src/ai.js` | OpenRouter capability detection، read query، action proposal |
| `src/audit.js` | Undo امن با ChangeLog |
| `src/backup.js` | portable backup، preview، restore |
| `src/telegram.js` | Telegram UX و wizard |
| `src/api.js` | REST API Mini App |
| `src/scheduler.js` | reminder روزانه |
| `public/*` | Mini App فارسی RTL |

## قرارداد Transaction

Transaction نوع‌های `expense`, `income`, `transfer`, `installment_payment`, `debt`, `receivable`, `refund`, `adjustment` را می‌پذیرد. `amount` و `fee_amount` عدد صحیح تومان هستند.

`transaction_date` تاریخ شمسی نمایشی و `transaction_date_iso` تاریخ Gregorian عملیاتی است. `created_at` و `updated_at` timestamp سیستمی هستند و برای گزارش زمان تراکنش استفاده نمی‌شوند.

Linked data با ID ذخیره می‌شود؛ از جمله `parent_transaction_id`, `installment_id` در metadata/link، DebtPayments و Links.

## Routes عمومی Worker

| Method | Route | کاربرد |
|---|---|---|
| GET | `/` | انتقال به Mini App |
| GET | `/app` | HTML Mini App |
| POST | `/telegram` | Telegram webhook |
| POST | `/` | سازگاری webhook روی Root |

## خانواده‌های REST API

تمام routeهای زیر به‌جز login نیازمند Telegram initData معتبر و PIN session معتبر هستند.

| خانواده | کاربرد |
|---|---|
| `/api/auth/*` | login/logout |
| `/api/admin/*` | setup و Telegram webhook |
| `/api/health` | health |
| `/api/dashboard` | home summary |
| `/api/transactions*` | CRUD، restore، tags |
| `/api/search` | global search |
| `/api/reports*` | report و period compare |
| `/api/accounts/*` | balance و history |
| `/api/people/*` | person summary |
| `/api/projects/*` | project summary |
| `/api/installments/*` | installment summary/payment |
| `/api/debts/*` | settlement |
| `/api/inbox*` | review queue |
| `/api/drafts*` | persistent drafts |
| `/api/settings` | admin settings |
| `/api/storage` | storage stats |
| `/api/backup` | portable JSON backup |
| `/api/restore/*` | preview/apply/receipt restore |
| `/api/export/csv` | CSV filtered export |
| `/api/receipts*` | upload/read/delete/optimize/AI |
| `/api/imports*` | bank file/import items/confirm |
| `/api/ai/*` | capabilities/read/action proposal/confirm |
| `/api/splits*` | deterministic split and receivables |
| `/api/trash` | soft-deleted transactions |
| `/api/merge/*` | entity merge |
| `/api/entities/*` | CRUD مدیریت entityها |
| `/api/undo` | Undo امن |
| `/api/changelog` | audit history |
| `/api/links` | linked records |

## Concurrency و Idempotency

Mutationهای Worker از `WRITE_GATE` با نام ثابت مالک عبور می‌کنند. در کنار serialization، Repository جدول `Idempotency` دارد و Telegram `update_id` در `ProcessedUpdates` ثبت می‌شود. Import نیز content fingerprint و per-item status دارد.

این سه لایه نقش‌های متفاوت دارند: serialization برای همزمانی، idempotency برای retry HTTP و ProcessedUpdates برای retry Telegram.

## Audit

هر create/update/delete/restore/merge/import و write مرتبط با AI در ChangeLog ثبت می‌شود. `before_json` و `after_json` نسخه‌ی داده را نگه می‌دارند. داده‌ی حساس Session hash از audit payload حذف می‌شود.

Undo فقط عملیات‌هایی را برمی‌گرداند که بازگردانی مکانیکی آن‌ها امن است؛ سپس aggregateهای مالی وابسته دوباره محاسبه می‌شوند.

## Receipt lifecycle

R2 object key اصلی:

`receipts/YYYY/<transaction-id>/<receipt-id>/receipt.webp`

Thumbnail:

`receipts/YYYY/<transaction-id>/<receipt-id>/thumb.webp`

Original فقط با setting مربوط ذخیره می‌شود. دسترسی public bucket لازم نیست.

## AI safety

AI برای read ابتدا query محدود Data Layer می‌گیرد. اعداد مهم با کد محاسبه می‌شوند. Mutation به structured action تبدیل می‌شود، validation می‌شود، Draft proposal می‌سازد و فقط endpoint تأیید یا callback تأیید آن را اجرا می‌کند. JSON نامعتبر اجرا نمی‌شود.

## Portability

Backup JSON علاوه بر schema version، entityهای مستقل از Bot و receipt manifest را نگه می‌دارد. در یک پیاده‌سازی آینده می‌توان فقط Data Contract Sheetها و IDها را خواند و Bot را از صفر نوشت.
