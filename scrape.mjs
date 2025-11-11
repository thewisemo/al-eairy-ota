// scrape.mjs — Playwright scraper v3 (per-platform groups + cities.txt + include all Al Eairy)
import { chromium } from 'playwright';
import fs from 'fs';

function loadCities(){
  try{
    const txt = fs.readFileSync('data/cities.txt','utf8');
    return txt.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  }catch(e){
    console.log('cities.txt not found; please create data/cities.txt with one city per line.');
    return [];
  }
}

const CITIES = loadCities();
const BRAND_RX = [/al\s*eairy/i, /العييري/, /al-?ayeri/i];
const MAX_PER_PROVIDER = 15;
const MAX_UNIT_ROWS_PER_HOTEL = 30;
const TIMEOUT = 35000;
const DELAY_MS = 600;

const today = new Date();
const ci = ymd(new Date(today.getTime()+1*864e5));
const co = ymd(new Date(today.getTime()+2*864e5));

function ymd(d){ return d.toISOString().slice(0,10); }
function isAlEairy(name=''){ return BRAND_RX.some(rx=>rx.test(name)); }
function toNum(s){ const t=(s||'').toString().replace(/[^\d.,]/g,'').replace(/,/g,''); return t?+t:NaN; }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
async function go(p,u){ await p.goto(u,{waitUntil:'domcontentloaded',timeout:TIMEOUT}); }

const providers = {
  Booking: {
    key:'Booking',
    buildSearch:(city)=>`https://www.booking.com/searchresults.html?ss=${encodeURIComponent(`${city}, Saudi Arabia`)}&checkin=${ci}&checkout=${co}&group_adults=2&no_rooms=1&group_children=0&selected_currency=SAR&lang=en-us`,
    search: async (page, city)=>{
      await go(page, providers.Booking.buildSearch(city));
      const cards = await page.$$('div[data-testid="property-card"]');
      const out = [];
      let idx = 0;
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
        out.push({ platform:'Booking', rank: idx, hotel: name.trim(), url: 'https://www.booking.com'+href, lowestPrice: Number.isFinite(price)?price:NaN, currency:'SAR' });
        if (out.length>=MAX_PER_PROVIDER) break;
      }
      return out;
    },
    units: async (page, hotelUrl)=>{
      const out = [];
      await go(page, hotelUrl);
      const rooms = await page.$$('[data-testid="room-name"], .hprt-roomtype-icon-link');
      for (const r of rooms.slice(0, MAX_UNIT_ROWS_PER_HOTEL)){
        const title = await r.innerText().catch(()=>null);
        const seg = await r.evaluate(el=>el.closest('tr')?.innerText || el.parentElement?.innerText || '');
        const m = seg.match(/(SAR|ر\.س|ريال)\s*([\d\.,]+)/g) || [];
        const nums = m.map(x=>toNum(x)).filter(Number.isFinite);
        if (!title || !nums.length) continue;
        const cancellable = /free cancellation|إلغاء مجاني/i.test(seg) ? Math.min(...nums) : null;
        const nonref = /non-refundable|غير قابل للاسترداد/i.test(seg) ? Math.min(...nums) : null;
        out.push({ name: title.trim(), price: Math.min(...nums), cancellable, nonRefundable: nonref });
      }
      return out;
    }
  },

  Agoda: {
    key:'Agoda',
    buildSearch:(city)=>`https://www.agoda.com/search?checkIn=${ci}&los=1&rooms=1&adults=2&children=0&pslc=SAR&locale=en-us&text=${encodeURIComponent(`${city} Saudi Arabia`)}`,
    search: async (page, city)=>{
      await go(page, providers.Agoda.buildSearch(city));
      const out = [];
      const cards = await page.$$('[data-testid="hotel-name"], [itemprop="name"]');
      let idx = 0;
      for (const el of cards){
        const hotel = (await el.innerText()).trim();
        const cardRoot = await el.evaluateHandle(n => n.closest('a') || n.closest('div'));
        let href = '';
        try { href = await (await cardRoot.asElement()).getAttribute('href') || ''; } catch(_){}
        if (href && !href.startsWith('http')) href = 'https://www.agoda.com' + href;
        const seg = await (await cardRoot.asElement()).innerText();
        const m = seg.match(/(SAR|ر\.س|ريال)[^\d]*([\d\.,]+)/i);
        const price = m ? toNum(m[2]) : NaN;
        if (!hotel || !href) continue;
        idx++;
        out.push({ platform:'Agoda', rank: idx, hotel, url: href, lowestPrice: Number.isFinite(price)?price:NaN, currency:'SAR' });
        if (out.length>=MAX_PER_PROVIDER) break;
      }
      return out;
    },
    units: async (page, hotelUrl)=>{
      const out = [];
      await go(page, hotelUrl);
      const rooms = await page.$$('[data-component="room-name"], .RoomName');
      for (const r of rooms.slice(0, MAX_UNIT_ROWS_PER_HOTEL)){
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
    key:'Expedia',
    buildSearch:(city)=>`https://www.expedia.com/Hotel-Search?destination=${encodeURIComponent(`${city}, Saudi Arabia`)}&startDate=${ci}&endDate=${co}&adults=2&rooms=1&langid=1033&currency=SAR`,
    search: async (page, city)=>{
      await go(page, providers.Expedia.buildSearch(city));
      const out = [];
      const dataEl = await page.$('#__NEXT_DATA__');
      let idx = 0;
      if (dataEl){
        try{
          const json = JSON.parse(await dataEl.innerText());
          const items = (json?.props?.pageProps?.apolloState && Object.values(json.props.pageProps.apolloState).find(x=>x?.hotelResults)?.hotelResults) || [];
          for (const it of items){
            const name = it.name || it.hotelName;
            const price = +(it?.price?.lead?.amount || it?.price?.displayMessages?.[0]?.value?.amount || NaN);
            const path = it?.hotelPath || '';
            if (!name) continue;
            idx++;
            out.push({
              platform:'Expedia', rank: idx, hotel: name.trim(),
              url: path ? (path.startsWith('http') ? path : `https://www.expedia.com${path}`) : '',
              lowestPrice: Number.isFinite(price)?price:NaN, currency:'SAR'
            });
            if (out.length>=MAX_PER_PROVIDER) break;
          }
        }catch(_){}
      }
      return out;
    },
    units: async (page, hotelUrl)=>{
      const out = [];
      await go(page, hotelUrl);
      const script = await page.$('script[type="application/json"]#__NEXT_DATA__');
      if (script){
        try{
          const json = JSON.parse(await script.innerText());
          const roomsMatch = JSON.stringify(json).match(/"rooms":\s*(\[[\s\S]*?\])/);
          const rooms = roomsMatch ? JSON.parse(roomsMatch[1]) : [];
          for (const r of rooms.slice(0, MAX_UNIT_ROWS_PER_HOTEL)){
            let prices = [];
            (r?.ratePlans||[]).forEach(p=>{ const a=+p?.price?.lead?.amount; if (Number.isFinite(a)) prices.push(a); });
            if (prices.length){
              const text = JSON.stringify(r);
              const cancellable = /Free cancellation|إلغاء مجاني/i.test(text) ? Math.min(...prices) : null;
              const nonref = /Non-refundable|غير قابل للاسترداد/i.test(text) ? Math.min(...prices) : null;
              out.push({ name: r?.name||'Room', price: Math.min(...prices), cancellable, nonRefundable: nonref });
            }
          }
        }catch(_){}
      }
      return out;
    }
  }
};

function uniqBy(arr, keyFn){
  const seen = new Set(); const out=[];
  for (const x of arr){ const k = keyFn(x); if (seen.has(k)) continue; seen.add(k); out.push(x); }
  return out;
}

(async ()=>{
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    locale: 'en-US',
  });
  const page = await context.newPage();

  const result = { date: ymd(new Date()), checkIn: ci, checkOut: co, cities: [] };

  for (const city of CITIES){
    const cityProviders = {};

    for (const key of ['Booking','Agoda','Expedia']){
      const prov = providers[key];
      let hits = [];
      try {
        hits = await prov.search(page, city);
      } catch(e){ hits = []; }
      // Include all Al Eairy + top15 in default ranking order
      const alOnly = hits.filter(h=>isAlEairy(h.hotel));
      const top15 = hits.slice(0, MAX_PER_PROVIDER);
      const chosen = uniqBy(alOnly.concat(top15), h=>`${h.platform}|${h.hotel}`);

      const hotels = [];
      for (const h of chosen){
        let units = [];
        try { units = await prov.units(page, h.url); } catch(e){ units = []; }
        hotels.push({
          platform: h.platform,
          rank: h.rank || null,
          hotel: h.hotel,
          url: h.url,
          lowestPrice: Number.isFinite(h.lowestPrice) ? h.lowestPrice : null,
          currency: 'SAR',
          taxesIncluded: null,
          isAlEairy: isAlEairy(h.hotel),
          units: units.map(u=>({ name: u.name, price: u.price, cancellable: u.cancellable ?? null, nonRefundable: u.nonRefundable ?? null }))
        });
        await sleep(DELAY_MS);
      }
      cityProviders[key] = hotels;
      await sleep(DELAY_MS);
    }

    const hasAl = Object.values(cityProviders).some(list => (list||[]).some(h=>h.isAlEairy));
    if (!hasAl) continue;

    result.cities.push({ city, providers: cityProviders });
  }

  await browser.close();

  fs.mkdirSync('data', { recursive: true });
  const fname = `data/al-eairy-ota-${ci}.json`;
  fs.writeFileSync(fname, JSON.stringify(result, null, 2));
  fs.writeFileSync('data/latest.json', JSON.stringify(result, null, 2));
  console.log('Written:', fname, 'and data/latest.json');
})();
