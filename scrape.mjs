// scrape.mjs — v4 (city variants + cookies + scroll + all units, SAR)
// Runs on GitHub Actions with Playwright
import { chromium } from 'playwright';
import fs from 'fs';

const TIMEOUT = 45000;
const MAX_PER_PROVIDER = 15;
const MAX_UNIT_ROWS_PER_HOTEL = 40;
const SCROLL_STEPS = 10;
const SCROLL_DELAY = 700;

// ----- dates (next day) -----
const today = new Date();
const ci = ymd(new Date(today.getTime()+1*864e5));
const co = ymd(new Date(today.getTime()+2*864e5));
function ymd(d){ return d.toISOString().slice(0,10); }

// ----- brand detection -----
const BRAND_RX = [/al\s*eairy/i, /العييري/, /al-?ayeri/i];
const isAlEairy = (s='') => BRAND_RX.some(r=>r.test(s));

// ----- cities: read from data/cities.txt -----
function loadCities(){
  try { return fs.readFileSync('data/cities.txt','utf8').split(/\r?\n/).map(s=>s.trim()).filter(Boolean); }
  catch { return []; }
}

// common variants per city (we’ll try each until we get hits)
const VARIANTS = {
  'Mecca': ['Makkah','Mecca','مكة'],
  'Medina': ['Medina','Al Madinah','Madinah','المدينة المنورة'],
  'Buraydah': ['Buraydah','Buraidah','بريدة'],
  'Khamis Mushayt': ['Khamis Mushayt','Khamis Mushait','خميس مشيط'],
  'Al Ahsa': ['Al Ahsa','Al-Hasa','Hofuf','Al Hofuf','الأحساء','الهفوف'],
  'Al Khobar': ['Al Khobar','Khobar','الخبر'],
  'Jazan': ['Jazan','Jizan','جازان'],
  'Al Bahah': ['Al Bahah','Al Baha','الباحة'],
  'Unayzah': ['Unayzah','Unaizah','عنيزة'],
  'An Nairyah': ['An Nairyah','Al Nairyah','النعيرية'],
};

// expand variants
function expandCity(city){
  const v = VARIANTS[city] || VARIANTS[normalize(city)] || null;
  return v ? v : [city];
}
function normalize(s){ return s.replace(/\s+/g,' ').trim(); }

async function autoScroll(page){
  for (let i=0;i<SCROLL_STEPS;i++){
    await page.evaluate(()=>window.scrollBy(0, window.innerHeight*0.9));
    await page.waitForTimeout(SCROLL_DELAY);
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
function uniqBy(arr, keyFn){ const st=new Set(); const out=[]; for (const x of arr){ const k=keyFn(x); if (st.has(k)) continue; st.add(k); out.push(x);} return out; }
function byPriceAsc(a,b){ const ax=Number.isFinite(a.lowestPrice)?a.lowestPrice:1e15; const bx=Number.isFinite(b.lowestPrice)?b.lowestPrice:1e15; return ax-bx; }

// ---------- providers ----------
const providers = {
  Booking: {
    name:'Booking',
    searchUrl: (q)=>`https://www.booking.com/searchresults.html?ss=${encodeURIComponent(q)}&checkin=${ci}&checkout=${co}&group_adults=2&no_rooms=1&group_children=0&selected_currency=SAR&lang=en-us`,
    async search(page, query){
      await page.goto(this.searchUrl(query), { waitUntil:'domcontentloaded', timeout: TIMEOUT });
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
      for (const r of rooms.slice(0, MAX_UNIT_ROWS_PER_HOTEL)){
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
      await page.goto(this.searchUrl(query), { waitUntil:'domcontentloaded', timeout: TIMEOUT });
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
    name:'Expedia',
    searchUrl: (q)=>`https://www.expedia.com/Hotel-Search?destination=${encodeURIComponent(q)}&startDate=${ci}&endDate=${co}&adults=2&rooms=1&langid=1033&currency=SAR`,
    async search(page, query){
      await page.goto(this.searchUrl(query), { waitUntil:'domcontentloaded', timeout: TIMEOUT });
      await acceptCookies(page);
      await page.waitForTimeout(800);
      await autoScroll(page);

      // Try __NEXT_DATA__ or visible cards text fallback
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
        } catch {}
      }
      return out;
    }
  }
};

// ---------- main ----------
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
  // mask webdriver
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();

  const result = { date: ymd(new Date()), checkIn: ci, checkOut: co, cities: [], meta: {} };
  const CITIES = loadCities();

  for (const city of CITIES){
    const variants = expandCity(city);
    const cityProviders = {};
    const meta = result.meta[city] = {};

    for (const provName of Object.keys(providers)){
      const prov = providers[provName];
      let hits = [];
      let tried = [];
      try {
        for (const q of variants){
          tried.push(q);
          hits = await prov.search(page, `${q}, Saudi Arabia`);
          if (hits && hits.length) break;
        }
      } catch(e){
        meta[provName] = `error:${(e.message||'')}`; 
      }
      if (!hits || !hits.length){
        meta[provName] = (meta[provName]||'') || `no-results:${tried.join('|')}`;
        cityProviders[provName] = [];
        continue;
      }
      const alOnly = hits.filter(h=>isAlEairy(h.hotel));
      const top15 = hits.slice(0, MAX_PER_PROVIDER);
      const chosen = uniqBy(alOnly.concat(top15), h=>`${h.platform}|${h.hotel}`);

      const hotels = [];
      for (const h of chosen){
        let units = [];
        try { units = await prov.units(page, h.url); } catch(e){ /* ignore units errors */ }
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
      cityProviders[provName] = hotels.sort(byPriceAsc);
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
