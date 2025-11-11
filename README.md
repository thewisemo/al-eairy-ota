# Al Eairy OTA — v3

- استخدم `data/cities.txt` لوضع **المدن التي للعييري فروع فيها فقط** (سطر لكل مدينة).
- النتائج تُحفظ في `data/latest.json`، مجمعة **لكل منصة داخل كل مدينة**.
- Google Apps Script يكتب جدول يومي إلى Google Sheet باسم **OTA Dashboard** (تبويب Daily)، ويرسل بريد ثنائي + CSV.

## خطوات سريعة
1) ارفع الملفات على ريبو GitHub عام.
2) افتح `data/cities.txt` وعدّل المدن حسب فروع العييري.
3) شغّل الـ Action يدويًا أول مرة، وبعدها هيشتغل يوميًا 18:00 UTC (21:00 KSA).
4) خذ رابط RAW لـ `data/latest.json` وحطه داخل Apps Script في `REMOTE_JSON_URL`.
5) شغّل `runDailyReport` مرة ثم اعمل Trigger يومي 21:05 (الرياض).
