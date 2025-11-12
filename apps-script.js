/** Al Eairy — Daily OTA email + CSV (ALL units) — v3.3 **/
const CFG = {
  TIMEZONE: 'Asia/Riyadh',
  RECIPIENTS: ['imwisemo@gmail.com','eaisocials2025@gmail.com'],
  SENDER_NAME: 'Al Eairy — Daily OTA Report',
  REMOTE_JSON_URL: 'https://raw.githubusercontent.com/thewisemo/al-eairy-ota/main/data/latest.json',
};

function runDailyReport(){
  const res = UrlFetchApp.fetch(CFG.REMOTE_JSON_URL, { muteHttpExceptions:true, followRedirects:true });
  if (res.getResponseCode() !== 200) throw new Error('Cannot fetch JSON: ' + res.getResponseCode());
  const data = JSON.parse(res.getContentText());
  const dateStr = Utilities.formatDate(new Date(), CFG.TIMEZONE, 'yyyy-MM-dd');

  const csvRows = [];
  const mailParts = [];
  const tableParts = [];

  (data.cities||[]).forEach(cityObj=>{
    const city = cityObj.city;
    const booking = (cityObj.providers||{}).Booking || [];

    // احسب ميديان المدينة + رتّب حسب السعر
    const finite = booking.filter(h=>Number.isFinite(h.lowestPrice));
    finite.sort((a,b)=>(a.lowestPrice-b.lowestPrice));
    const median = finite.length ? finite[Math.floor(finite.length/2)].lowestPrice : null;

    // سطر العييري (لو موجود)
    const ae = booking.find(h=>h.isAlEairy);

    // ملخص المدينة
    const pos = ae ? (ae.rank || booking.findIndex(h=>h.hotel===ae.hotel)+1) : null;
    mailParts.push(`• ${city}: ${ae ? ('Al Eairy price '+ae.lowestPrice+' SAR'+(pos?`, position ${pos}`:'')) : 'Al Eairy not shown'}; median ${median??'—'}.`);

    // جدول البريد (Top ≤15) + علِّم العييري بنجمة
    const rows = booking.map(h=>{
      const star = h.isAlEairy ? '⭐' : '';
      return [city, h.rank||'', `${h.hotel} ${star}`, 'Booking', h.lowestPrice??'', 'SAR', h.isAlEairy?'Yes':'No'];
    });
    tableParts.push(renderMiniTable(['City','Rank','Hotel','Platform','Lowest Price','Currency','Is Al Eairy?'], rows));

    // CSV — ALL rows + ALL units
    booking.forEach(h=>{
      if ((h.units||[]).length){
        h.units.forEach(u=>{
          csvRows.push([
            dateStr, city, 'Booking', h.rank||'',
            h.hotel, h.url||'',
            h.lowestPrice??'', 'SAR', '',
            u.name||'', u.price??'', u.cancellable??'', u.nonRefundable??'', h.isAlEairy?'Yes':'No'
          ]);
        });
      } else {
        // حتى لو مفيش وحدات ملتقطة
        csvRows.push([dateStr, city, 'Booking', h.rank||'', h.hotel, h.url||'', h.lowestPrice??'', 'SAR', '', '', '', '', '', h.isAlEairy?'Yes':'No']);
      }
    });

    // لو العييري مش ظاهر: أضف صفًا فارغًا بسعر غير متاح لإبرازه في الجدول
    if (!ae){
      csvRows.push([dateStr, city, 'Booking', '', 'Al Eairy (not in Top15)', '', '', 'SAR', '', '', '', '', '', 'Yes']);
    }
  });

  // جهّز CSV
  const csvHeader = ['Date','City','Platform','Rank','Hotel','DirectURL','LowestPrice','Currency','TaxesIncluded','Unit','UnitPrice','CheapestCancellable','CheapestNonRefund','IsAlEairy'];
  const csvBlob = Utilities.newBlob([ [csvHeader.join(',')].concat(csvRows.map(r=>r.join(','))).join('\n') ], 'text/csv', `al-eairy-ota-${data.checkIn||dateStr}.csv`);

  // البريد (بالثنائي EN/AR)
  const introEN = `Hello,\n\nHere is today’s OTA price scan (2 adults, 1 night, check-in ${data.checkIn}):\n\n${mailParts.join('\n')}\n\n`;
  const introAR = `مرحبًا،\n\nهذا مسح أسعار المنصات لليوم (شخصان، ليلة واحدة، تاريخ الدخول ${data.checkIn}):\n\n${mailParts.join('\n')}\n\n`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif">
    <p>${introEN.replace(/\n/g,'<br>')}</p>
    <hr>
    <p>${introAR.replace(/\n/g,'<br>')}</p>
    ${tableParts.join('<br>')}
  </div>`;

  GmailApp.sendEmail(CFG.RECIPIENTS.join(','), `Daily OTA price scan — Al Eairy — ${data.date}`,
    introEN + '\n' + introAR,
    { name: CFG.SENDER_NAME, htmlBody: html, attachments: [csvBlob] }
  );
}

function renderMiniTable(headers, rows){
  const th = headers.map(h=>`<th style="padding:6px 10px;border:1px solid #ccc;background:#f7f7f7">${h}</th>`).join('');
  const tr = rows.map(r=>`<tr>${r.map(c=>`<td style="padding:6px 10px;border:1px solid #ddd">${String(c)}</td>`).join('')}</tr>`).join('');
  return `<table style="border-collapse:collapse;margin-top:8px">${`<tr>${th}</tr>`+tr}</table>`;
}
