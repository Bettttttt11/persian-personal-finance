# مدیریت مالی شخصی فارسی برای Telegram + Cloudflare Workers

این مخزن یک سیستم شخصی مدیریت مالی Telegram-first است که Backend، Telegram Bot، REST API، Google Sheets Data Layer، فیش‌های خصوصی R2، OpenRouter Gateway، Telegram Mini App، گزارش‌ها، Import بانکی، Backup/Restore و یادآورها را در یک Cloudflare Worker نگه می‌دارد.

تمام مبلغ‌های مالی در Backend به‌صورت عدد صحیح «تومان» ذخیره می‌شوند. تاریخ عملیاتی تراکنش مستقل از زمان ایجاد رکورد است؛ تاریخ شمسی برای نمایش و ورودی پشتیبانی می‌شود و تاریخ Gregorian/ISO نیز در داده نگهداری می‌شود. همه‌ی موجودیت‌های اصلی شناسه‌ی UUID پایدار دارند و Business Logic به شماره‌ی ردیف Google Sheets وابسته نیست.

## معماری داده

Google Sheets دیتابیس اصلی و قابل حمل سیستم است. `Repository` همه‌ی خواندن/نوشتن را بر اساس Header و ID انجام می‌دهد؛ بنابراین Sort شدن ردیف‌ها در خود Google Sheets منطق برنامه را خراب نمی‌کند. ستون‌های ناشناخته در Updateها حفظ می‌شوند. Telegram Bot و Mini App فقط مصرف‌کننده‌ی Data Layer مشترک هستند و حذف یا بازنویسی Bot در آینده، قرارداد داده را از بین نمی‌برد.

`WriteGate` یک Durable Object با SQLite backend است که mutationهای یک مالک را پشت‌سرهم اجرا می‌کند تا دو درخواست همزمان باعث duplicate write نشوند. داده‌ی مالی داخل Durable Object نگهداری نمی‌شود؛ داده‌ی اصلی همچنان Google Sheets و R2 است.

## مسیرهای اصلی

- `GET /` → انتقال به Mini App
- `GET /app` → Mini App فارسی RTL
- `POST /telegram` → Telegram webhook
- `POST /` → سازگار با webhook قدیمی روی Root
- `/api/*` → REST API محافظت‌شده‌ی Mini App
- Scheduled handler → یادآور روزانه

فهرست دقیق routeها در `docs/ARCHITECTURE.md` آمده است.

## Sheetها و مهاجرت Schema

سیستم Sheetهای فعلی شما را حفظ می‌کند و در اجرای راه‌اندازی، Sheetها یا Headerهای گمشده را می‌سازد. هیچ migration ردیف‌های موجود را پاک نمی‌کند. Migration تکرارپذیر است و نسخه‌ی Schema را ثبت می‌کند.

Sheetهای تحت مدیریت:

`Transactions`, `Accounts`, `Categories`, `People`, `Projects`, `Installments`, `InstallmentPayments`, `Tags`, `Merchants`, `Rules`, `Drafts`, `ChangeLog`, `Settings`, `Receipts`, `Debts`, `DebtPayments`, `Recurring`, `Budgets`, `Splits`, `SplitItems`, `Inbox`, `Imports`, `ImportItems`, `Templates`, `Sessions`, `Migrations`, `EntityTags`, `Links`, `ProcessedUpdates`, `AuthState`, `Idempotency`.

`GOOGLE_SHEET_NAME=Transactions` می‌تواند در تنظیمات فعلی شما باقی بماند. این نسخه برای Data Layer چندجدولی به یک Sheet انتخابی وابسته نیست و نام Sheetهای قراردادی را از Schema می‌گیرد.

## امنیت

لایه‌ی اول مالکیت، مقایسه‌ی عددی Telegram User ID با `OWNER_TELEGRAM_ID` است. Username و شماره تلفن برای authorization استفاده نمی‌شوند. کاربر غیرمجاز در Bot فقط پیام کوتاه `Access Denied` می‌گیرد.

لایه‌ی دوم PIN است. PIN فقط در Secret با نام `BOT_PIN` قرار می‌گیرد و داخل Google Sheets یا log نوشته نمی‌شود. بعد از پنج تلاش ناموفق، قفل موقت ۱۵ دقیقه‌ای فعال می‌شود. Sessionها زمان انقضا دارند و حالت‌های ۱۵ دقیقه، ۳۰ دقیقه، ۱ ساعت و تا قفل دستی پشتیبانی می‌شوند. حالت پیش‌فرض ۱ ساعت است.

Mini App باید `Telegram.WebApp.initData` خام را بفرستد. Worker امضای Telegram را cryptographic بررسی می‌کند، `auth_date` را کنترل می‌کند، ID مالک را تطبیق می‌دهد و سپس PIN Session را نیز الزام می‌کند. دانستن URL Mini App برای دسترسی کافی نیست. Cookie نشست امضاشده است و Google Sheets فقط hash بخش تصادفی نشست را نگه می‌دارد.

اگر `TELEGRAM_WEBHOOK_SECRET` را تعریف کنید، Worker هدر secret-token وبهوک را هم بررسی می‌کند و endpoint تنظیم Webhook همان secret را برای Telegram ثبت می‌کند.

## Secrets مورد نیاز

در Cloudflare Dashboard به Worker بروید و از `Settings → Variables & Secrets` موارد زیر را به‌صورت Secret وارد کنید:

```text
TELEGRAM_BOT_TOKEN
OWNER_TELEGRAM_ID
SPREADSHEET_ID
GOOGLE_SERVICE_ACCOUNT_JSON
BOT_PIN
SESSION_SECRET
```

`SESSION_SECRET` را یک مقدار تصادفی و طولانی، ترجیحاً حداقل ۳۲ بایت، انتخاب کنید.

Secretهای اختیاری:

```text
OPENROUTER_API_KEY
TELEGRAM_WEBHOOK_SECRET
```

متغیرهای اختیاری مدل:

```text
OPENROUTER_TEXT_MODEL
OPENROUTER_VISION_MODEL
OPENROUTER_AUDIO_MODEL
OPENROUTER_FILE_MODEL
PUBLIC_BASE_URL
GOOGLE_SHEET_NAME
```

`PUBLIC_BASE_URL` بهتر است برابر origin نهایی Worker باشد؛ نمونه‌ی شکلی: `https://your-worker.your-subdomain.workers.dev`. مسیر `/app` را داخل آن قرار ندهید. در requestهای عادی Worker origin را خودش تشخیص می‌دهد، ولی برای Cron که request عمومی ندارد، `PUBLIC_BASE_URL` برای دکمه‌ی Mini App در Reminderها لازم است. بدون آن Reminder ارسال می‌شود ولی دکمه‌ی Web App ساخته نمی‌شود.

## R2 Binding

Binding مورد انتظار کد:

```text
RECEIPTS_BUCKET
```

`wrangler.jsonc` Binding را بدون `bucket_name` تعریف کرده است. Wrangler جدید می‌تواند هنگام deploy چنین R2 binding را خودکار provision کند. اگر ترجیح می‌دهید Bucket را خودتان بسازید، در Cloudflare Dashboard به `R2 Object Storage` بروید، یک private bucket بسازید، سپس در Worker بخش `Settings → Bindings` آن را با نام `RECEIPTS_BUCKET` متصل کنید. در این حالت می‌توانید `bucket_name` همان Bucket را نیز در `wrangler.jsonc` ثبت کنید.

R2 public access لازم نیست و نباید فعال شود. فایل‌ها فقط از API احرازشده‌ی Worker خوانده می‌شوند.

اگر R2 متصل نباشد، هسته‌ی Bot و تراکنش‌ها کار می‌کند و فقط قابلیت‌های وابسته به فایل با پیام قابل فهم غیرفعال می‌مانند.

## Durable Object Binding

`wrangler.jsonc` یک Binding با نام `WRITE_GATE` و کلاس `WriteGate` دارد و migration آن با `new_sqlite_classes` تعریف شده است. این backend برای Durable Objectهای جدید و Workers Free مناسب است.

این Object فقط هماهنگ‌کننده‌ی write است. اگر روزی کل Bot را عوض کنید، داده‌ی مالی به آن وابسته نیست.

## Deploy بدون نصب روی کامپیوتر

روش پیشنهادی کاملاً مرورگری است:

1. در GitHub یک Repository خصوصی بسازید.
2. محتویات همین پروژه را با رابط وب GitHub داخل Repository قرار دهید. Secretها را داخل Git commit نکنید.
3. در Cloudflare Dashboard وارد `Workers & Pages` شوید.
4. `Create application` را بزنید و در بخش `Import a repository` حساب GitHub و Repository را انتخاب کنید.
5. Root directory را `/` نگه دارید.
6. Build command لازم نیست؛ این پروژه build frontend جداگانه ندارد.
7. Deploy command را روی مقدار پیش‌فرض `npx wrangler deploy` نگه دارید.
8. `Save and Deploy` را بزنید.
9. بعد از ساخته شدن Worker، Runtime Secrets بالا را در `Settings → Variables & Secrets` قرار دهید. Build-time variable جای Runtime Secret را نمی‌گیرد.
10. R2 Binding و Durable Object را در `Settings → Bindings` بررسی کنید. اگر R2 خودکار ساخته نشده بود، Bucket خصوصی را دستی بسازید و با نام `RECEIPTS_BUCKET` Bind کنید.
11. یک deployment تازه اجرا کنید تا تمام bindingها و secretها در نسخه‌ی فعال در دسترس باشند.
12. URL نهایی Worker را در `PUBLIC_BASE_URL` ذخیره کنید و دوباره deploy کنید.

Cloudflare Git integration با هر push جدید از GitHub Worker را دوباره deploy می‌کند. بنابراین برای نگهداری آینده نیز نصب Wrangler روی کامپیوتر لازم نیست.

## Cron

`wrangler.jsonc` شامل این Trigger است:

```text
30 3 * * *
```

Cloudflare Cron با UTC اجرا می‌شود. این مقدار در وضعیت فعلی timezone ایران حدود ساعت ۰۷:۰۰ تهران است. منطق تاریخ خود برنامه از `Asia/Tehran` استفاده می‌کند، نه timezone دیتاسنتر.

اگر می‌خواهید ساعت Reminder تغییر کند، در Cloudflare Dashboard از بخش Trigger/Cron همان Worker زمان Cron را تغییر دهید یا مقدار `triggers.crons` را در GitHub ویرایش کنید.

Scheduler موارد زیر را بررسی می‌کند:

- تراکنش‌های تکرارشونده؛ فقط Reminder می‌دهد و ثبت خودکار نمی‌کند.
- اقساط و وضعیت سررسید.
- بدهی/طلب دارای due date.
- آستانه‌های بودجه.
- پاکسازی Draft منقضی.

## اولین راه‌اندازی

بعد از Deploy، در Bot دستور زیر را بفرستید:

```text
/setup
```

این دستور فقط برای `OWNER_TELEGRAM_ID` اجرا می‌شود و پیش از PIN مجاز است تا بتوانید یک نصب تازه را آماده کنید. کار آن:

- بررسی Secretهای لازم.
- بررسی دسترسی Google Sheets.
- ساخت Sheetهای گمشده.
- افزودن Headerهای گمشده و حفظ Headerهای اضافی.
- ثبت نسخه‌ی Schema.
- ساخت دسته‌بندی‌های اولیه فقط اگر Categories خالی باشد.
- ساخت Settings پایه.
- نمایش Health نتیجه.

اجرای چندباره‌ی `/setup` داده‌ی قبلی را حذف نمی‌کند.

همین عملیات از Mini App در `تنظیمات → سلامت سیستم → اجرای راه‌اندازی / مهاجرت` نیز در دسترس است.

## تنظیم Telegram Webhook

چون Bot شما از قبل Webhook دارد، Worker هر دو مسیر `POST /telegram` و `POST /` را می‌پذیرد. برای مسیر استاندارد جدید:

1. `PUBLIC_BASE_URL` را تنظیم کنید.
2. Mini App را باز کنید، PIN بزنید و به `تنظیمات → سلامت سیستم` بروید.
3. دکمه‌ی `تنظیم Webhook` را بزنید.
4. Worker آدرس `${PUBLIC_BASE_URL}/telegram` را با Telegram Bot API ثبت می‌کند و پاسخ `ok` تلگرام را validate می‌کند.

اگر `TELEGRAM_WEBHOOK_SECRET` تعریف شده باشد، همان endpoint هنگام SetWebhook مقدار secret token را هم تنظیم می‌کند.

برای بررسی وضعیت، endpoint احرازشده‌ی `GET /api/admin/telegram-webhook` از Mini App/DevTools قابل استفاده است.

## اتصال Mini App به Bot

در BotFather:

1. `/mybots`
2. Bot موردنظر
3. `Bot Settings`
4. `Menu Button`
5. آدرس `https://YOUR-WORKER/app`

خود Bot نیز دکمه‌ی `🌐 داشبورد` را با همان Worker origin می‌سازد. ورود Mini App فقط از داخل Telegram معتبر است، چون Backend `initData` را بررسی می‌کند.

## OpenRouter

برای AI فقط `OPENROUTER_API_KEY` Secret لازم است. مدل‌ها را می‌توانید هم به‌صورت Runtime variable و هم از صفحه‌ی تنظیمات Mini App تعیین کنید. تنظیم ذخیره‌شده در Settings می‌تواند مدل env را override کند.

مدل‌ها مستقل هستند:

- `OPENROUTER_TEXT_MODEL`: سؤال‌های متنی، NLU، خلاصه و action proposal.
- `OPENROUTER_VISION_MODEL`: استخراج پیشنهاد از تصویر فیش.
- `OPENROUTER_AUDIO_MODEL`: voice/transcription در صورت سازگاری مدل.
- `OPENROUTER_FILE_MODEL`: تحلیل PDF/file زمانی که parsing مرورگر کافی نیست.

Gateway ابتدا metadata مدل‌های OpenRouter را می‌خواند و قابلیت ورودی و پارامترهای ساختاری را بررسی می‌کند. نبود Vision/Audio/File مدل باعث crash سیستم نمی‌شود. مدل Text همچنان مستقل کار می‌کند.

AI هیچ mutation مالی را مستقیم اجرا نمی‌کند. برای create/edit/category/person/project/installment/debt ابتدا Draft پیشنهاد ساخته می‌شود و بعد از تأیید کاربر Data Layer نوشته می‌شود. داده‌ی محاسباتی مهم با کد deterministic محاسبه می‌شود و فقط حداقل داده‌ی لازم به مدل فرستاده می‌شود.

## فیش‌ها

Mini App پیش از upload تصویر را با Canvas به WebP تبدیل می‌کند. مقدارهای پیش‌فرض:

- حداکثر ضلع: ۱۶۰۰ px
- کیفیت WebP: ۷۸
- thumbnail: حدود ۳۰۰ px
- نگهداری اصل: خاموش

تنظیم کیفیت، ضلع و نگهداری اصل از Mini App قابل تغییر است.

Telegram همیشه امکان تبدیل codec تصویر به WebP را در خود Worker بدون سرویس transform ندارد. در این مسیر فایل private در R2 نگهداری می‌شود و Mini App هنگام مشاهده/بهینه‌سازی نسخه‌ی WebP و thumbnail را جایگزین می‌کند. اگر `keep_original_receipts` خاموش باشد، اصل پس از تکمیل نسخه‌ی بهینه نگهداری نمی‌شود.

برای Download، WebP مستقیم دریافت می‌شود و JPG در Browser با Canvas از WebP ساخته می‌شود؛ نسخه‌ی JPG جداگانه در R2 مصرف فضا نمی‌کند.

## Bank Import

Telegram document به Inbox اضافه می‌شود. CSV در Bot قابل بررسی است. XLSX/PDF و mappingهای بزرگ به Mini App هدایت می‌شوند.

Mini App:

- CSV را در Browser می‌خواند.
- XLS/XLSX را با SheetJS در Browser parse می‌کند.
- PDF متنی را با PDF.js بررسی می‌کند.
- اگر PDF متن کافی نداشت و مدل فایل OpenRouter تنظیم شده باشد، fallback AI در دسترس است.

AI شرط لازم Import نیست.

Duplicate Detection این ترتیب را دارد:

1. `bank_transaction_id`
2. `tracking_number` یا `reference_number`
3. fingerprint قطعی بر اساس account/date/amount/type/description نرمال‌شده و metadata مناسب

مورد مشکوک خودکار حذف نمی‌شود. کاربر باید «همان تراکنش» یا «تراکنش جدید» را انتخاب کند. Reconciliation رکورد دستی را نگه می‌دارد و فقط metadata بانکی را به آن متصل می‌کند.

## Backup و Restore

صفحه‌ی تنظیمات دو نوع خروجی دارد:

- JSON ساختاری و قابل حمل از Entityها به‌همراه receipt manifest.
- ZIP کامل شامل JSON و فایل‌های R2 که قابل خواندن بوده‌اند.

Session/AuthState/Idempotency/ProcessedUpdates داخل Backup قابل حمل قرار نمی‌گیرند.

Restore ابتدا Preview تعارض IDها را نشان می‌دهد. سپس با تأیید صریح و انتخاب overwrite اجرا می‌شود. Mini App Sheetها را مرحله‌ای می‌فرستد تا requestهای بزرگ و سهمیه‌ی Sheets کنترل شوند. برای ZIP، فایل‌های فیش بعد از restore داده‌ها دوباره در R2 آپلود می‌شوند.

## PDF و Excel Export

XLSX واقعی در Browser با SheetJS ساخته می‌شود. برای PDF فارسی RTL، Mini App یک سند print-ready با `dir=rtl` و جدول فارسی می‌سازد و Print سیستم Browser را باز می‌کند؛ از همان صفحه `Save as PDF` را انتخاب کنید. این روش برای شکل‌دهی فارسی/RTL از ساخت PDF خام داخل Worker قابل اتکاتر است و فشار CPU روی Worker Free ایجاد نمی‌کند.

صورتحساب Account، Person و Project نیز از همین مسیر ساخته می‌شود.

## رفتارهای مالی مهم

- `transfer` خرج حساب نمی‌شود.
- Fee انتقال از حساب مبدا کم و در گزارش کارمزد جدا می‌شود.
- Refund به `parent_transaction_id` لینک است و مبلغ خرج خالص را کاهش می‌دهد؛ درآمد تلقی نمی‌شود.
- دریافت تسویه‌ی طلب درآمد جدید تلقی نمی‌شود.
- Soft-deleted transaction وارد گزارش نمی‌شود.
- Draft و Import تأییدنشده وارد گزارش نمی‌شوند.
- حذف/Restore پرداخت قسط یا تسویه باعث محاسبه‌ی دوباره‌ی aggregate مربوط می‌شود.
- مانده‌ی حساب از opening balance و تراکنش‌های فعال محاسبه می‌شود.

## تست بدون نصب محلی

مخزن یک GitHub Actions workflow در `.github/workflows/quality.yml` دارد. با هر push، GitHub این دو فرمان را در runner خودش اجرا می‌کند:

```text
npm run check
npm test
```

هیچ dependency برای test suite لازم نیست؛ از Node built-in test runner استفاده شده است.

`npm run check` Syntax همه‌ی JavaScriptها، callbackهای Telegram، خانواده‌های API مورد استفاده‌ی Mini App و markerهای غیرقابل تحویل را بررسی می‌کند.

فهرست سناریوها در `docs/TEST_MATRIX.md` است.

## Health Check

در Mini App از `تنظیمات → سلامت سیستم` وضعیت این موارد دیده می‌شود بدون نمایش Secret:

- Telegram API
- Google Sheets
- R2
- OpenRouter
- Schema version
- تعداد تراکنش، فیش و Draft
- حجم تقریبی R2
- زمان آخرین Backup

## نکات Google Sheets

Service Account باید Spreadsheet را با دسترسی Edit در اختیار داشته باشد. مقدار کامل JSON حساب سرویس در `GOOGLE_SERVICE_ACCOUNT_JSON` Secret قرار می‌گیرد. Private key هیچ‌وقت به Mini App ارسال نمی‌شود.

برای سازگاری بلندمدت، IDها را در Google Sheets به‌صورت رشته حفظ کنید و نام Headerهای قراردادی را تغییر ندهید. اضافه کردن ستون اختصاصی خودتان مجاز است و Repository آن را در Updateهای معمول حفظ می‌کند.

## منابع رسمی برای استقرار

- Cloudflare Workers Builds / Git integration: `https://developers.cloudflare.com/workers/ci-cd/builds/`
- Workers Builds configuration: `https://developers.cloudflare.com/workers/ci-cd/builds/configuration/`
- Wrangler configuration و automatic provisioning: `https://developers.cloudflare.com/workers/wrangler/configuration/`
- R2 Worker bindings: `https://developers.cloudflare.com/r2/api/workers/workers-api-reference/`
- Durable Objects: `https://developers.cloudflare.com/durable-objects/`
- Telegram Mini Apps validation: `https://core.telegram.org/bots/webapps`
- Google Service Account OAuth/JWT: `https://developers.google.com/identity/protocols/oauth2/service-account`
- OpenRouter Models API: `https://openrouter.ai/docs/api-reference/list-available-models`

## فایل‌های مهم

`src/index.js` entrypoint و coordinator، `src/telegram.js` UX Bot، `src/api.js` REST API، `src/repository.js` Data Layer، `src/schema.js` migration، `src/business.js` قواعد مالی، `src/reports.js` گزارش، `src/imports.js` Import/Reconciliation، `src/storage.js` R2، `src/ai.js` OpenRouter، `src/auth.js` Telegram/PIN/session، `src/scheduler.js` Cron، `src/backup.js` Backup/Restore و `public/` Mini App هستند.

برای شروع عملی بعد از Deploy: Secrets را ثبت کنید، R2 Binding را بررسی کنید، `PUBLIC_BASE_URL` را قرار دهید، `/setup` را اجرا کنید، Webhook را از صفحه سلامت تنظیم کنید و سپس Menu Button BotFather را روی `/app` بگذارید.
