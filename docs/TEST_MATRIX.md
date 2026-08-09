# ماتریس آزمون

`test/scenarios.test.js` سناریوهای Business/Auth/Data را با Repository حافظه‌ای و R2 سازگار با قرارداد Worker اجرا می‌کند. `scripts/audit-ui.mjs` نیز callbackها و API familyهای UI را بررسی می‌کند.

| سناریو | پوشش |
|---|---|
| `/start` | policy شروع و نیاز به PIN |
| Telegram ID غیرمجاز | فقط Access Denied |
| PIN اشتباه | رد ورود و شمارش تلاش |
| PIN صحیح | ساخت session |
| قفل موقت PIN | پس از تلاش‌های ناموفق |
| Mini App auth | initData HMAC + owner + signed session |
| دستکاری cookie | رد session |
| ساخت Expense | مبلغ، تاریخ، account impact |
| ساخت Income | account impact |
| Transfer | دو حساب، بدون Expense شدن |
| Fee | خروج حساب و گزارش مستقل |
| تاریخ شمسی دستی | تبدیل معتبر به ISO |
| Person Receivable | طلب و Person summary |
| Debt settlement | تسویه جزئی + fee |
| Installment | پرداخت جزئی + fee |
| ویرایش Transaction | ChangeLog و مقدار جدید |
| Soft delete | حذف از report |
| Restore | بازگشت report و aggregate |
| Refund | کاهش net expense و عدم افزایش income |
| Search | شرح و entity/tag relation |
| Filters | query transaction |
| Reports | income/expense/fee/net |
| Project | project summary |
| Tag | رابطه چندبرچسبی |
| Receipt | private R2 put/get contract |
| CSV import | parsing و mapping |
| Duplicate bank transaction | ID/reference/fingerprint path |
| Reconciliation | اتصال bank metadata به manual tx |
| Import idempotency | preview/confirm تکراری |
| AI read | query داده واقعی |
| AI create proposal | proposal بدون write مستقیم |
| AI confirmation | write پس از confirm |
| دنگ | equal/settlement deterministic |
| Dashboard | محاسبه از Repository واقعی |
| Recurring | monthly/custom deterministic date |
| Backup/Restore | preview و stable ID |
| Undo | بازگردانی edit امن |
| callback audit | ۸۰ خانواده callback Telegram |
| Mini App API audit | route familyهای مورد استفاده UI |
| JavaScript syntax | تمام فایل‌های Worker و Mini App |
