/** Report from GitHub JSON — v1 */
const CFG = {
  TIMEZONE: 'Asia/Riyadh',
  RECIPIENTS: ['msw.sa99@gmail.com','eaisocials2025@gmail.com'],
  SENDER_NAME: 'Al Eairy — Daily OTA Report',
  REMOTE_JSON_URL: 'https://raw.githubusercontent.com/USER/al-eairy-ota/main/data/latest.json' // <-- غيّر USER/REPO
};

function runDailyReport(){
  const res = UrlFetchApp.fetch(CFG.REMOTE_JSON_URL, { muteHttpExceptions:true, followRedirects:true });
  if (res.getResponseCode() !== 200) throw new Error('Cannot fetch JSON');
  const data = JSON.parse(res.getContentText());

  const rows = [];
  const citySummaries = [];

  (data.cities||[]).forEach(c=>{
    const hotels = (c.hotels||[]).slice().sort((a,b)=>{
      const ax = Number.isFinite(a.lowestPrice)?a.lowestPrice:Infinity;
      const bx = Number.isFinite(b.lowestPrice)?b.lowestPrice:Infinity;
      return ax-bx;
    });

    const top15 = hotels.slice(0,15);
    const priced = top15.filter(h=>Number.isFinite(h.lowestPrice));
    const median = priced.length ? median(priced.map(h=>h.lowestPrice)) : null;
    const pos = top15.findIndex(h=>h.isAlEairy);
    const alTop1 = pos===0;
    const gap = (alTop1 && top15[1] && Number.isFinite(top15[1].lowestPrice) && Number.isFinite(top15[0].lowestPrice))
      ? round2(top15[1].lowestPrice - top15[0].lowestPrice) : null;

    citySummaries.push({ city: c.city, alPresent: pos>=0, alPosition: pos>=0?pos+1:null, alTop1, gapToNext:gap, median });

    top15.forEach(h=>{
      if (!(h.units||[]).length){
        rows.push({ City:c.city, Platform:h.platform, Rank:h.rank||'', Hotel:h.hotel, DirectURL:h.url,
          LowestPrice:h.lowestPrice??'', Currency:h.currency||'SAR', TaxesIncluded:h.taxesIncluded??'',
          Unit:'', UnitPrice:'', CheapestCancellable:'', CheapestNonRefundable:'', IsAlEairy: h.isAlEairy?'Yes':'No' });
      } else {
        h.units.forEach(u=>{
          rows.push({ City:c.city, Platform:h.platform, Rank:h.rank||'', Hotel:h.hotel, DirectURL:h.url,
            LowestPrice:h.lowestPrice??'', Currency:h.currency||'SAR', TaxesIncluded:h.taxesIncluded??'',
            Unit:u.name, UnitPrice:u.price??'', CheapestCancellable:u.cancellable??'', CheapestNonRefundable:u.nonRefundable??'',
            IsAlEairy: h.isAlEairy?'Yes':'No' });
        });
      }
    });
  });

  const todayStr = Utilities.formatDate(new Date(), CFG.TIMEZONE, 'yyyy-MM-dd');
  const headers = ['City','Platform','Rank','Hotel','DirectURL','LowestPrice','Currency','TaxesIncluded','Unit','UnitPrice','CheapestCancellable','CheapestNonRefundable','IsAlEairy'];
  const csv = [headers.join(',')].concat(rows.map(r=>headers.map(h=>`"${String(r[h]??'').replace(/"/g,'""')}"`).join(','))).join('\n');
  const blob = Utilities.newBlob(csv, 'text/csv', `al-eairy-ota-${todayStr}.csv`);

  const digest = citySummaries.map(s=>{
    const en = s.alPresent ? `Al Eairy present — position ${s.alPosition||'—'}${s.alTop1?' (Top1)':''}; median ${s.median??'—'}; gap-to-next ${s.gapToNext??'—'}.`
                           : `Al Eairy not in top 15; median ${s.median??'—'}.`;
    const ar = s.alPresent ? `العييري موجود — المركز ${s.alPosition||'—'}${s.alTop1?' (الأول)':''}؛ متوسط المدينة ${s.median??'—'}؛ الفارق مع التالي ${s.gapToNext??'—'}.`
                           : `العييري غير ضمن أفضل 15؛ متوسط المدينة ${s.median??'—'}.`;
    return { city: s.city, en, ar };
  });

  const ci = (data.checkIn||'');
  const html = buildHtmlEmail_(todayStr, ci, digest, rows);
  const text = buildTextEmail_(todayStr, ci, digest);

  GmailApp.sendEmail(
    CFG.RECIPIENTS.join(','),
    `Daily OTA price scan — Al Eairy — ${todayStr}`,
    text,
    { name: CFG.SENDER_NAME, attachments:[blob], htmlBody: html }
  );
}

function round2(x){ return Math.round(x*100)/100; }
function median(arr){ const a=arr.slice().sort((x,y)=>x-y), n=a.length; return n? (n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2) : null; }

function buildTextEmail_(todayStr, ci, digest){
  const en = digest.map(d=>`• ${d.city}: ${d.en}`).join('\n');
  const ar = digest.map(d=>`• ${d.city}: ${d.ar}`).join('\n');
  return `Hello,\n\nHere is today’s OTA price scan (2 adults, 1 night, check-in ${ci}):\n${en}\n\n-----------------------------\n\nمرحبًا،\n\nهذا مسح أسعار المنصات لليوم (شخصان، ليلة واحدة، تاريخ الدخول ${ci}):\n${ar}\n\nCSV attached.\nBest regards.`;
}

function buildHtmlEmail_(todayStr, ci, digest, rows){
  const en = digest.map(d=>`<li><b>${esc(d.city)}</b>: ${esc(d.en)}</li>`).join('');
  const ar = digest.map(d=>`<li><b>${esc(d.city)}</b>: ${esc(d.ar)}</li>`).join('');
  const table = compactTablesHtml_(rows);
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
    <p>Hello,</p><p>Here is today’s OTA price scan (2 adults, 1 night, check-in <b>${esc(ci)}</b>):</p><ul>${en}</ul>
    <hr/><p dir="rtl">مرحبًا،</p><p dir="rtl">هذا مسح أسعار المنصات لليوم (شخصان، ليلة واحدة، تاريخ الدخول <b>${esc(ci)}</b>):</p><ul dir="rtl">${ar}</ul>
    <hr/>${table}</div>`;
}

function compactTablesHtml_(rows){
  const heads = ['City','Rank','Hotel','Platform','Lowest Price','Currency','Is Al Eairy?'];
  const byCity = {};
  rows.forEach(r=>{ (byCity[r.City]=byCity[r.City]||[]).push(r); });
  return Object.keys(byCity).map(city=>{
    const map = {};
    byCity[city].forEach(r=>{
      const key = `${r.Hotel}|${r.Platform}|${r.Rank}|${r.Currency}|${r.IsAlEairy}`;
      const p = Number.isFinite(+r.LowestPrice)?+r.LowestPrice:Infinity;
      if (!map[key] || p < map[key].LowestPrice) map[key] = {...r, LowestPrice:p};
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
    return `<h3 style="margin:16px 0 8px">${esc(city)}</h3>
      <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px;width:100%;max-width:900px">
        <thead><tr>${heads.map(h=>`<th style="text-align:left;background:#f5f5f5">${esc(h)}</th>`).join('')}</tr></thead>
        <tbody>${lines}</tbody>
      </table>`;
  }).join('\n');
}

function esc(s){ return String(s||'').replace(/[&<>"']/g,c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
