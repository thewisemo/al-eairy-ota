// scrape.mjs — v4 (Arabic city names + variants + cookies + scroll + all units in SAR)
import { chromium } from 'playwright';
import fs from 'fs';

const TIMEOUT = 45000;
const MAX_PER_PROVIDER = 15;
const MAX_UNIT_ROWS_PER_HOTEL = 40;
const SCROLL_STEPS = 10;
const SCROLL_DELAY = 700;

const today = new Date();
const ci = ymd(new Date(today.getTime()+1*864e5));
const co = ymd(new Date(today.getTime()+2*864e5));
function ymd(d){ return d.toISOString().slice(0,10); }

const BRAND_RX = [/al\s*eairy/i, /العييري/, /al-?ayeri/i];
const isAlEairy = (s='') => BRAND_RX.some(r=>r.test(s));

function loadCities(){
  try {
    const txt = fs.readFileSync('data/cities.txt','utf8');
    const arr = txt.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    if (arr.length) return arr;
  } catch {}
  // Fallback لو الملف مش موجود أو فاضي
  return ['الأحساء','النعيرية','بريدة','الدمام','المدينة المنورة','مكة','جدة','حائل','الباحة','جازان','تبوك','أبها','خميس مشيط','نجران','القطيف','ينبع','الجبيل','عنيزة','الهفوف','حفر الباطن'];
}


const VARIANTS = {
  'الرياض': ['الرياض','Riyadh'],
  'جدة': ['جدة','Jeddah'],
  'مكة': ['مكة','Mecca','Makkah'],
  'المدينة المنورة': ['المدينة المنورة','Medina','Madinah','Al Madinah'],
  'الدمام': ['الدمام','Dammam'],
  'الخبر': ['الخبر','Al Khobar','Khobar'],
  'الأحساء': ['الأحساء','Al Ahsa','Al-Hasa','Hofuf','Al Hofuf'],
  'الهفوف': ['الهفوف','Hofuf','Al Hofuf','Al Ahsa'],
  'بريدة': ['بريدة','Buraydah','Buraidah'],
  'عنيزة': ['عنيزة','Unayzah','Unaizah'],
  'حائل': ['حائل','Hail'],
  'تبوك': ['تبوك','Tabuk'],
  'أبها': ['أبها','Abha'],
  'خميس مشيط': ['خميس مشيط','Khamis Mushayt','Khamis Mushait'],
  'نجران': ['نجران','Najran'],
  'جازان': ['جازان','Jazan','Jizan'],
  'الباحة': ['الباحة','Al Bahah','Al Baha'],
  'النعيرية': ['النعيرية','An Nairyah','Al Nairyah'],
  'القطيف': ['القطيف','Qatif'],
  'ينبع': ['ينبع','Yanbu'],
  'الجبيل': ['الجبيل','Jubail'],
  'حفر الباطن': ['حفر الباطن','Hafar Al-Batin','Hafar Al Batin'],
  'عرعر': ['عرعر','Arar'],
  'سكاكا': ['سكاكا','Sakaka']
};

function expandCity(city){ return VARIANTS[city] ? VARIANTS[city] : [city]; }

async function autoScroll(page){
  for (let i=0;i<10;i++){
    await page.evaluate(()=>window.scrollBy(0, window.innerHeight*0.9));
    await page.waitForTimeout(700);
  }
}

async function acceptCookies(page){
  const selectors = [
    '#onetrust-accept-btn-handler',
    'button:has-text("Accept")',
    'button:has-text("I agree")',
    'button:has-text("Got it")',
    'button:has-text("أوافق")',
    'button:has-text("قبول")',
  ];
  for (const s of selectors){
    const el = await page.$(s).catch(()=>null);
    if (el){ try { await el.click({timeout:2000}); } catch {} }
  }
}

function toNum(s){ const t=(s||'').toString().replace(/[^\d.,]/g,'').replace(/,/g,''); return t?+t:NaN; }

const providers = {
  Booking: {
    name:'Booking',
    searchUrl: (q)=>`https://www.booking.com/searchresults.html?ss=${encodeURIComponent(q)}&checkin=${ci}&checkout=${co}&group_adults=2&no_rooms=1&group_children=0&selected_currency=SAR&lang=en-us`,
    async search(page, query){
      await page.goto(this.searchUrl(query+', Saudi Arabia'), { waitUntil:'domcontentloaded', timeout: TIMEOUT });
      await acceptCookies(page);
      await page.waitForTimeout(800);
      await autoScroll(page);

      const cards = await page.$$('div[data-testid="property-card"]');
      const out = [];
      let idx=0;
      for (const card of cards){
        const titleEl = await card.$('div[data-testid="title"]');
        const name = titleEl ? (await titleEl.innerText()) : null;
        const priceEl = await card.$('[data-testid="price-and-discounted-price"], [aria-label="Price"]');
        const priceTxt = priceEl ? (await priceEl.innerText()).replace(/\s+/g,' ') : '';
        const price = toNum(priceTxt);
        const linkEl = await card.$('a[data-testid="title-link"]');
        const href = linkEl ? await linkEl.getAttribute('href') : null;
        if (!name || !href) continue;
        idx++;
        out.push({
          platform:'Booking', rank: idx, hotel: name.trim(),
          url: 'https://www.booking.com'+href+`&checkin=${ci}&checkout=${co}&group_adults=2&no_rooms=1&group_children=0&selected_currency=SAR&lang=en-us`,
          lowestPrice: Number.isFinite(price)?price:NaN, currency:'SAR'
        });
        if (out.length>=MAX_PER_PROVIDER) break;
      }
      return out;
    },
    async units(page, hotelUrl){
      const out = [];
      await page.goto(hotelUrl, { waitUntil:'domcontentloaded', timeout: TIMEOUT });
      await acceptCookies(page);
      await page.waitForTimeout(800);

      const rooms = await page.$$('[data-testid="room-name"], .hprt-roomtype-icon-link');
      for (const r of rooms.slice(0, 40)){
        const title = await r.innerText().catch(()=>null);
        const rowTxt = await r.evaluate(el=>el.closest('tr')?.innerText || el.parentElement?.innerText || '');
        const matches = rowTxt.match(/(SAR|ر\.س|ريال)\s*([\d\.,]+)/g) || [];
        const nums = matches.map(x=>toNum(x)).filter(Number.isFinite);
        if (!title || !nums.length) continue;
        const cancellable = /free cancellation|إلغاء مجاني/i.test(rowTxt) ? Math.min(...nums) : null;
        const nonref = /non-refundable|غير قابل للاسترداد/i.test(rowTxt) ? Math.min(...nums) : null;
        out.push({ name: title.trim(), price: Math.min(...nums), cancellable, nonRefundable: nonref });
      }
      return out;
    }
  },

  Agoda: {
    name:'Agoda',
    searchUrl: (q)=>`https://www.agoda.com/search?checkIn=${ci}&los=1&rooms=1&adults=2&children=0&pslc=SAR&locale=en-us&text=${encodeURIComponent(q)}`,
    async search(page, query){
      await page.goto(this.searchUrl(query+' Saudi Arabia'), { waitUntil:'domcontentloaded', timeout: TIMEOUT });
      await acceptCookies(page);
      await page.waitForTimeout(800);
      await autoScroll(page);

      const cards = await page.$$('[data-testid="hotel-name"], [itemprop="name"]');
      const out = [];
      let idx=0;
      for (const el of cards){
        const hotel = (await el.innerText()).trim();
        const root = await el.evaluateHandle(n=>n.closest('a')||n.closest('div'));
        let href=''; try{ href = await (await root.asElement()).getAttribute('href') || '';}catch{}
        if (href && !href.startsWith('http')) href = 'https://www.agoda.com'+href;
        const seg = await (await root.asElement()).innerText();
        const m = seg.match(/(SAR|ر\.س|ريال)[^\d]*([\d\.,]+)/i);
        const price = m ? toNum(m[2]) : NaN;
        if (!hotel || !href) continue;
        idx++;
        out.push({ platform:'Agoda', rank: idx, hotel, url: href, lowestPrice: Number.isFinite(price)?price:NaN, currency:'SAR' });
        if (out.length>=MAX_PER_PROVIDER) break;
      }
      return out;
    },
    async units(page, hotelUrl){
      const out = [];
      await page.goto(hotelUrl, { waitUntil:'domcontentloaded', timeout: TIMEOUT });
      await acceptCookies(page);
      await page.waitForTimeout(800);
      const rooms = await page.$$('[data-component="room-name"], .RoomName');
      for (const r of rooms.slice(0, 40)){
        const title = (await r.innerText().catch(()=>null)) || 'Room';
        const seg = await r.evaluate(el=>el.parentElement?.innerText || '');
        const m = seg.match(/(SAR|ر\.س|ريال)[^\d]*([\d\.,]+)/g) || [];
        const nums = m.map(x=>toNum(x)).filter(Number.isFinite);
        if (!nums.length) continue;
        const cancellable = /Free cancellation|إلغاء مجاني/i.test(seg) ? Math.min(...nums) : null;
        const nonref = /Non-refundable|غير قابل للاسترداد/i.test(seg) ? Math.min(...nums) : null;
        out.push({ name: title.trim(), price: Math.min(...nums), cancellable, nonRefundable: nonref });
      }
      return out;
    }
  },

  Expedia: {
    name:'Expedia',
    searchUrl: (q)=>`https://www.expedia.com/Hotel-Search?destination=${encodeURIComponent(q)}&startDate=${ci}&endDate=${co}&adults=2&rooms=1&langid=1033&currency=SAR`,
    async search(page, query){
      await page.goto(this.searchUrl(query+', Saudi Arabia'), { waitUntil:'domcontentloaded', timeout: TIMEOUT });
      await acceptCookies(page);
      await page.waitForTimeout(800);
      await autoScroll(page);

      const out = [];
      let idx=0;
      const dataEl = await page.$('#__NEXT_DATA__');
      if (dataEl){
        try {
          const json = JSON.parse(await dataEl.innerText());
          const items = (json?.props?.pageProps?.apolloState && Object.values(json.props.pageProps.apolloState).find(x=>x?.hotelResults)?.hotelResults) || [];
          for (const it of items){
            const name = it.name || it.hotelName;
            const amount = +(it?.price?.lead?.amount || it?.price?.displayMessages?.[0]?.value?.amount || NaN);
            const path = it?.hotelPath || '';
            if (!name) continue;
            idx++;
            out.push({
              platform:'Expedia', rank: idx, hotel: name.trim(),
              url: path ? (path.startsWith('http') ? path : `https://www.expedia.com${path}`) : '',
              lowestPrice: Number.isFinite(amount)?amount:NaN, currency:'SAR'
            });
            if (out.length>=MAX_PER_PROVIDER) break;
          }
        } catch {}
      }
      return out;
    },
    async units(page, hotelUrl){
      const out = [];
      await page.goto(hotelUrl, { waitUntil:'domcontentloaded', timeout: TIMEOUT });
      await acceptCookies(page);
      await page.waitForTimeout(800);
      const script = await page.$('script[type="application/json"]#__NEXT_DATA__');
      if (script){
        try {
          const json = JSON.parse(await script.innerText());
          const roomsMatch = JSON.stringify(json).match(/"rooms":\s*(\[[\s\S]*?\])/);
          const rooms = roomsMatch ? JSON.parse(roomsMatch[1]) : [];
          for (const r of rooms.slice(0, 40)){
            let prices = [];
            (r?.ratePlans||[]).forEach(p=>{ const a=+p?.price?.lead?.amount; if (Number.isFinite(a)) prices.push(a); });
            if (prices.length){
              const text = JSON.stringify(r);
              const cancellable = /Free cancellation|إلغاء مجاني/i.test(text) ? Math.min(...prices) : null;
              const nonref = /Non-refundable|غير قابل للاسترداد/i.test(text) ? Math.min(...prices) : null;
              out.push({ name: r?.name||'Room', price: Math.min(...prices), cancellable, nonRefundable: nonref });
            }
          }
        } catch {}
      }
      return out;
    }
  }
};

(async ()=>{
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled']
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    timezoneId: 'Asia/Riyadh',
    locale: 'en-US',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();

  const result = { date: ymd(new Date()), checkIn: ci, checkOut: co, cities: [], meta: {} };
  const CITIES = loadCities();

  function logMeta(city, prov, msg){
    if (!result.meta[city]) result.meta[city] = {};
    result.meta[city][prov] = msg;
  }

  for (const city of CITIES){
    const variants = expandCity(city);
    const cityProviders = {};

    for (const provName of Object.keys(providers)){
      const prov = providers[provName];
      let hits = [];
      const tried = [];
      try {
        for (const q of variants){
          tried.push(q);
          hits = await prov.search(page, q);
          if (hits && hits.length) break;
        }
      } catch(e){
        logMeta(city, provName, `error:${(e.message||'')}`);
      }
      if (!hits || !hits.length){
        logMeta(city, provName, `no-results:${tried.join('|')}`);
        cityProviders[provName] = [];
        continue;
      }

      const alOnly = hits.filter(h=>isAlEairy(h.hotel));
      const top15 = hits.slice(0, MAX_PER_PROVIDER);
      const seen = new Set();
      const chosen = [];
      for (const h of alOnly.concat(top15)){
        const k = `${h.platform}|${h.hotel}`;
        if (seen.has(k)) continue; seen.add(k); chosen.push(h);
      }

      const hotels = [];
      for (const h of chosen){
        let units = [];
        try { units = await prov.units(page, h.url); } catch(e){}
        hotels.push({
          platform: h.platform,
          rank: h.rank || null,
          hotel: h.hotel,
          url: h.url,
          lowestPrice: Number.isFinite(h.lowestPrice) ? h.lowestPrice : null,
          currency: 'SAR',
          taxesIncluded: null,
          isAlEairy: isAlEairy(h.hotel),
          units: (units||[]).slice(0, MAX_UNIT_ROWS_PER_HOTEL)
        });
      }
      hotels.sort((a,b)=>{
        const ax=Number.isFinite(a.lowestPrice)?a.lowestPrice:1e15;
        const bx=Number.isFinite(b.lowestPrice)?b.lowestPrice:1e15;
        return ax-bx;
      });
      cityProviders[provName] = hotels;
    }

    const hasAl = Object.values(cityProviders).some(list => (list||[]).some(h=>h.isAlEairy));
    if (!hasAl) continue;
    result.cities.push({ city, providers: cityProviders });
  }

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(`data/al-eairy-ota-${ci}.json`, JSON.stringify(result, null, 2));
  fs.writeFileSync(`data/latest.json`, JSON.stringify(result, null, 2));
  await browser.close();
  console.log('DONE', ci);
})();
