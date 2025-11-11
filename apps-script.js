/** Report from GitHub JSON — v3 (per-platform tables + Google Sheet) */
const CFG = {
  TIMEZONE: 'Asia/Riyadh',
  RECIPIENTS: ['msw.sa99@gmail.com','eaisocials2025@gmail.com'],
  SENDER_NAME: 'Al Eairy — Daily OTA Report',
  REMOTE_JSON_URL: 'https://raw.githubusercontent.com/USER/REPO/main/data/latest.json', // <-- غيّر USER/REPO
  SHEET_ID: '' // اختياري
};

function runDailyReport(){
  const res = UrlFetchApp.fetch(CFG.REMOTE_JSON_URL, { muteHttpExceptions:true, followRedirects:true });
  if (res.getResponseCode() !== 200) throw new Error('Cannot fetch JSON: ' + res.getResponseCode());
  const data = JSON.parse(res.getContentText());

  const flatRows = [];
  const citySummaries = [];
  const dateStr = Utilities.formatDate(new Date(), CFG.TIMEZONE, 'yyyy-MM-dd');

  (data.cities||[]).forEach(cityObj => {
    const city = cityObj.city;
    const perProvider = cityObj.providers || {};

    const allHotels = [];
    Object.keys(perProvider).forEach(p => {
      (perProvider[p]||[]).forEach(h => allHotels.push(h));
    });
    const byPrice = allHotels.slice().sort((a,b)=>{
      const ax = Number.isFinite(a.lowestPrice)?a.lowestPrice:Infinity;
      const bx = Number.isFinite(b.lowestPrice)?b.lowestPrice:Infinity;
      return ax-bx;
    });
    const top15All = byPrice.slice(0,15);
    const priced = top15All.filter(h=>Number.isFinite(h.lowestPrice));
    const cityMedian = priced.length ? median(priced.map(h=>h.lowestPrice)) : null;
    const pos = top15All.findIndex(h=>h.isAlEairy);
    const alTop1 = pos===0;
    const gap = (alTop1 && top15All[1] && Number.isFinite(top15All[1].lowestPrice) && Number.isFinite(top15All[0].lowestPrice))
      ? round2(top15All[1].lowestPrice - top15All[0].lowestPrice) : null;

    citySummaries.push({ city, alPresent: pos>=0, alPosition: pos>=0?pos+1:null, alTop1, gapToNext:gap, median: cityMedian });

    Object.keys(perProvider).forEach(p => {
      (perProvider[p]||[]).forEach(h => {
        const base = {
          Date: dateStr,
          City: city,
          Platform: p,
          Rank: h.rank || '',
          Hotel: h.hotel,
          DirectURL: h.url,
          LowestPrice: h.lowestPrice ?? '',
          Currency: h.currency || 'SAR',
          TaxesIncluded: h.taxesIncluded ?? '',
          IsAlEairy: h.isAlEairy ? 'Yes' : 'No'
        };
        if (!(h.units||[]).length){
          flatRows.push({ ...base, Unit:'', UnitPrice:'', CheapestCancellable:'', CheapestNonRefundable:'' });
        } else {
          h.units.forEach(u=>{
            flatRows.push({
              ...base,
              Unit: u.name,
              UnitPrice: u.price ?? '',
              CheapestCancellable: u.cancellable ?? '',
              CheapestNonRefundable: u.nonRefundable ?? ''
            });
          });
        }
      });
    });
  });

  const headers = ['Date','City','Platform','Rank','Hotel','DirectURL','LowestPrice','Currency','TaxesIncluded','Unit','UnitPrice','CheapestCancellable','CheapestNonRefundable','IsAlEairy'];
  const csv = [headers.join(',')].concat(
    flatRows.map(r=>headers.map(h=>`"${String(r[h]??'').replace(/"/g,'""')}"`).join(','))
  ).join('\n');
  const blob = Utilities.newBlob(csv, 'text/csv', `al-eairy-ota-${dateStr}.csv`);

  writeToSheet_(headers, flatRows, dateStr);

  const ci = (data.checkIn||'');
  const html = buildHtmlEmail_(dateStr, ci, citySummaries, flatRows);
  const text = buildTextEmail_(dateStr, ci, citySummaries);

  GmailApp.sendEmail(
    CFG.RECIPIENTS.join(','),
    `Daily OTA price scan — Al Eairy — ${dateStr}`,
    text,
    { name: CFG.SENDER_NAME, attachments:[blob], htmlBody: html }
  );
}

function writeToSheet_(headers, rows, dateStr){
  const ss = getSpreadsheet_();
  const name = 'Daily';
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  sh.clear();
  sh.getRange(1,1,1,headers.length).setValues([headers]);
  if (rows.length){
    const vals = rows.map(r => headers.map(h => r[h] ?? ''));
    sh.getRange(2,1,vals.length, headers.length).setValues(vals);
  }
  sh.getRange(1, headers.length+1).setValue('Date');
  sh.getRange(2, headers.length+1).setValue(dateStr);
}

function getSpreadsheet_(){
  if (CFG.SHEET_ID){
    try { return SpreadsheetApp.openById(CFG.SHEET_ID); } catch(e){}
  }
  const name = 'OTA Dashboard';
  const files = DriveApp.getFilesByName(name);
  if (files.hasNext()){
    const file = files.next();
    return SpreadsheetApp.openById(file.getId());
  } else {
    const ss = SpreadsheetApp.create(name);
    return ss;
  }
}

function buildTextEmail_(todayStr, ci, digest){
  const en = digest.map(d=>`• ${d.city}: ${d.alPresent ? `Al Eairy present — position ${d.alPosition||'—'}${d.alTop1?' (Top1)':''}; median ${d.median??'—'}; gap-to-next ${d.gapToNext??'—'}.` : `Al Eairy not in top 15; median ${d.median??'—'}.`}`).join('\n');
  const ar = digest.map(d=>`• ${d.city}: ${d.alPresent ? `العييري موجود — المركز ${d.alPosition||'—'}${d.alTop1?' (الأول)':''}؛ متوسط المدينة ${d.median??'—'}؛ الفارق مع التالي ${d.gapToNext??'—'}.` : `العييري غير ضمن أفضل 15؛ متوسط المدينة ${d.median??'—'}.`}`).join('\n');
  return `Hello,\n\nHere is today’s OTA price scan (2 adults, 1 night, check-in ${ci}):\n${en}\n\n-----------------------------\n\nمرحبًا،\n\nهذا مسح أسعار المنصات لليوم (شخصان، ليلة واحدة، تاريخ الدخول ${ci}):\n${ar}\n\nCSV attached + Google Sheet updated.\nBest regards.`;
}

function buildHtmlEmail_(todayStr, ci, digest, rows){
  const en = digest.map(d=>`<li><b>${esc(d.city)}</b>: ${esc(d.alPresent ? `Al Eairy present — position ${d.alPosition||'—'}${d.alTop1?' (Top1)':''}; median ${d.median??'—'}; gap-to-next ${d.gapToNext??'—'}.` : `Al Eairy not in top 15; median ${d.median??'—'}.`)}</li>`).join('');
  const ar = digest.map(d=>`<li><b>${esc(d.city)}</b>: ${esc(d.alPresent ? `العييري موجود — المركز ${d.alPosition||'—'}${d.alTop1?' (الأول)':''}؛ متوسط المدينة ${d.median??'—'}؛ الفارق مع التالي ${d.gapToNext??'—'}.` : `العييري غير ضمن أفضل 15؛ متوسط المدينة ${d.median??'—'}.`)}</li>`).join('');
  const tables = perCityPerPlatformTables_(rows);
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
    <p>Hello,</p><p>Here is today’s OTA price scan (2 adults, 1 night, check-in <b>${esc(ci)}</b>):</p><ul>${en}</ul>
    <hr/><p dir="rtl">مرحبًا،</p><p dir="rtl">هذا مسح أسعار المنصات لليوم (شخصان، ليلة واحدة، تاريخ الدخول <b>${esc(ci)}</b>):</p><ul dir="rtl">${ar}</ul>
    <hr/>${tables}</div>`;
}

function perCityPerPlatformTables_(rows){
  const heads = ['City','Rank','Hotel','Platform','Lowest Price','Currency','Is Al Eairy?'];
  const byCity = {};
  rows.forEach(r=>{ (byCity[r.City]=byCity[r.City]||[]).push(r); });
  return Object.keys(byCity).sort().map(city=>{
    const byPlat = {};
    byCity[city].forEach(r=>{ (byPlat[r.Platform]=byPlat[r.Platform]||[]).push(r); });
    const sections = Object.keys(byPlat).map(p=>{
      const map = {};
      byPlat[p].forEach(r=>{
        const key = `${r.Hotel}|${r.Platform}|${r.Rank}|${r.Currency}|${r.IsAlEairy}`;
        const pval = Number.isFinite(+r.LowestPrice)?+r.LowestPrice:Infinity;
        if (!map[key] || pval < map[key].LowestPrice) map[key] = {...r, LowestPrice:pval};
      });
      const lines = Object.values(map).sort((a,b)=>{
        const ax=Number.isFinite(a.LowestPrice)?a.LowestPrice:Infinity;
        const bx=Number.isFinite(b.LowestPrice)?b.LowestPrice:Infinity;
        return ax-bx;
      }).slice(0,15).map(r=>{
        const star = r.IsAlEairy==='Yes'?'⭐':'';
        return `<tr>
          <td>${esc(r.City)}</td>
          <td style="text-align:right">${esc(r.Rank||'')}</td>
          <td>${esc(r.Hotel)} ${star}</td>
          <td>${esc(r.Platform)}</td>
          <td style="text-align:right">${Number.isFinite(+r.LowestPrice)?esc(round2(+r.LowestPrice)):''}</td>
          <td>${esc(r.Currency||'')}</td>
          <td>${esc(r.IsAlEairy||'')}</td>
        </tr>`;
      }).join('');
      return `<h4 style="margin:10px 0 6px">${esc(p)}</h4>
        <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px;width:100%;max-width:900px">
          <thead><tr>${heads.map(h=>`<th style="text-align:left;background:#f5f5f5">${esc(h)}</th>`).join('')}</tr></thead>
          <tbody>${lines}</tbody>
        </table>`;
    }).join('');
    return `<h3 style="margin:16px 0 6px">${esc(city)}</h3>${sections}`;
  }).join('\n');
}

function round2(x){ return Math.round(x*100)/100; }
function median(arr){ const a=arr.slice().sort((x,y)=>x-y), n=a.length; return n? (n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2) : null; }
function esc(s){ return String(s||'').replace(/[&<>"']/g,c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
