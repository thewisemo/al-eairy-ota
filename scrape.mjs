// scrape.mjs — v4.4 (robust variants EN-first, waits, retries, scroll; SAR; keep city even if empty)
import { chromium } from 'playwright';
import fs from 'fs';

const TIMEOUT = 55000;
const MAX_PER_PROVIDER = 15;
const MAX_UNIT_ROWS_PER_HOTEL = 40;
const SCROLL_STEPS = 12;
const SCROLL_DELAY = 700;
const RETRIES_PER_PROVIDER = 2;   // إعادة المحاولة لو الصفحة طلعت فاضية

// Dates: next-day check-in, 1 night
const today = new Date();
const ci = ymd(new Date(today.getTime()+1*864e5));
const co = ymd(new Date(today.getTime()+2*864e5));
function ymd(d){ return d.toISOString().slice(0,10); }

// Brand detection
const BRAND_RX = [/al\s*eairy/i, /العييري/, /al-?ayeri/i];
const isAlEairy = (s='') => BRAND_RX.some(r=>r.test(s));

// ---------- Cities ----------
function loadCities(){
  try {
    const txt = fs.readFileSync('data/cities.txt','utf8');
    const arr = txt.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    if (arr.length) return arr;
  } catch {}
  return ['الأحساء','بريدة','الدمام','المدينة المنورة','حائل','الباحة','جازان'];
}

function arNorm(s=''){
  return s.normalize('NFKD')
    .replace(/[\u064B-\u065F\u0670]/g,'')
    .replace(/[^\u0600-\u06FF\w]+/g,'')
    .replace(/[آأإ]/g,'ا').replace(/ة/g,'ه').replace(/ى/g,'ي')
    .replace(/ؤ/g,'و').replace(/ئ/g,'ي').trim();
}

const VARIANTS = {
  'بريدة': ['Buraydah','Buraidah','بريدة'],
  'الدمام': ['Dammam','الدمام'],
  'المدينة المنورة': ['Medina','Madinah','Al Madinah','المدينة المنورة'],
  'الأحساء': ['Al Ahsa','Al-Hasa','Hofuf','Al Hofuf','الأحساء'],
  'حائل': ['Hail','حائل'],
  'جازان': ['Jazan','Jizan','جازان'],
  'جيزان': ['Jazan','Jizan','جيزان'],
  'الباحة': ['Al Bahah','Al Baha','الباحة'],
};

const VAR_KEYS = Object.keys(VARIANTS);
function expandCity(city){
  const n = arNorm(city);
  const exact = VAR_KEYS.find(k => arNorm(k) === n);
  // EN-first ordering
  const base = exact ? VARIANTS[exact] : [city];
  const uniq = (arr)=>Array.from(new Set(arr));
  // لو كتبنا "الأحساء"؛ الأول نجرب Ahsa/Hofuf ثم العربي
  const enFirst = base.filter(x=>/^[A-Za-z]/.test(x)).concat(base.filter(x=>/^[^\x00-\x7F]/.test(x)));
  return uniq([ ...enFirst, city ]);
}

// ---------- helpers ----------
async function autoScroll(page, minCardsSel){
  for (let i=0;i<SCROLL_STEPS;i++){
    await page.evaluate(()=>window.scrollBy(0, window.innerHeight*0.92));
    await page.waitForTimeout(SCROLL_DELAY);
    if (minCardsSel){
      const cnt = await page.$$(minCardsSel);
      if (cnt.length >= MAX_PER_PROVIDER) break;
    }
  }
}
async function acceptCookies(page){
  const selectors = [
    '#onetrust-accept-btn-handler',
    'button[aria-label*="Accept"]',
    'button:has-text("Accept")',
    'button:has-text("I agree")',
    'button:has-text("Got it")',
    'button:has-text("OK")',
    'button:has-text("أوافق")',
    'button:has-text("قبول")',
  ];
  for (const s of selectors){
    try { const el = await page.$(s); if (el) await el.click({timeout:2000}); } catch {}
  }
}
function toNum(s){ const t=(s||'').toString().replace(/[^\d.,]/g,'').replace(/,/g,''); return t?+t:NaN; }
function uniqBy(arr, keyFn){ const st=new Set(); const out=[]; for (const x of arr){ const k=keyFn(x); if (st.has(k)) continue; st.add(k); out.push(x);} return out; }
const byPriceAsc = (a,b)=>((Number.isFinite(a.lowestPrice)?a.lowestPrice:1e15) - (Number.isFinite(b.lowestPrice)?b.lowestPrice:1e15));

async function providerTry(searchFn, unitsFn, page, q, opts={}){
  const { listSel, name } = opts;
  let hits = [];
  for (let i=0;i<=RETRIES_PER_PROVIDER;i++){
    try{
      hits = await searchFn(page, q);
      if (hits && hits.length) break;
      // small wait & retry
      await page.waitForTimeout(1200);
    }catch{}
  }
  return hits || [];
}

// ---------- Providers ----------
const providers = {
  Booking: {
    name:'Booking',
    searchUrl: q => `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(q)}&checkin=${ci}&checkout=${co}&group_adults=2&no_rooms=1&group_children=0&selected_currency=SAR&lang=en-us`,
    async search(page, query){
      await page.goto(this.searchUrl(query+', Saudi Arabia'), { waitUntil:'domcontentloaded', timeout: TIMEOUT });
      await acceptCookies(page);
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(()=>{});
      await page.waitForSelector('div[data-testid="property-card"], #search_results_table', { timeout: 15000 }).catch(()=>{});
      await autoScroll(page, 'div[data-testid="property-card"]');

      const cards = await page.$$('div[data-testid="property-card"]');
      const out = [];
      let idx=0;
      for (const card of cards){
        const titleEl = await card.$('div[data-testid="title"]');
        const name = titleEl ? (await titleEl.innerText()) : null;
        const priceEl = await card.$('[data-testid="price-and-discounted-price"], [aria-label="Price"], span:has-text("SAR")');
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
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(()=>{});
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
    searchUrl: q => `https://www.agoda.com/search?checkIn=${ci}&los=1&rooms=1&adults=2&children=0&pslc=SAR&locale=en-us&text=${encodeURIComponent(q)}`,
    async search(page, query){
      await page.goto(this.searchUrl(query+' Saudi Arabia'), { waitUntil:'domcontentloaded', timeout: TIMEOUT });
      await acceptCookies(page);
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(()=>{});
      await autoScroll(page);  // الصفحه بتجيب كروت أثناء السكرول

      const cards = await page.$$('[data-testid="hotel-name"], a[data-selenium="hotel-name"], [itemprop="name"]');
      const out = [];
      let idx=0;
      for (const el of cards){
        const hotel = (await el.innerText().catch(()=>''))?.trim();
        const rootHandle = await el.evaluateHandle(n => n.closest('a') || n.closest('div'));
        let href = '';
        try {
          const rootEl = rootHandle.asElement();
          if (rootEl) href = (await rootEl.getAttribute('href')) || '';
        } catch {}
        if (href && !href.startsWith('http')) href = 'https://www.agoda.com'+href;

        // السعر من نفس الكارت
        let seg = '';
        try {
          const rootEl = rootHandle.asElement();
          if (rootEl) seg = (await rootEl.innerText()) || '';
        } catch {}
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
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(()=>{});
      const rooms = await page.$$('[data-component="room-name"], .RoomName, [data-selenium="room-name"]');
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
    searchUrl: q => `https://www.expedia.com/Hotel-Search?destination=${encodeURIComponent(q)}&startDate=${ci}&endDate=${co}&adults=2&rooms=1&langid=1033&currency=SAR`,
    async search(page, query){
      await page.goto(this.searchUrl(query+', Saudi Arabia'), { waitUntil:'domcontentloaded', timeout: TIMEOUT });
      await acceptCookies(page);
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(()=>{});
      await autoScroll(page);

      const out = [];
      let idx=0;

      // Preferred: __NEXT_DATA__
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
              platform:'Expedia', rank: idx, hotel: name?.trim(),
              url: path ? (path.startsWith('http') ? path : `https://www.expedia.com${path}`) : '',
              lowestPrice: Number.isFinite(amount)?amount:NaN, currency:'SAR'
            });
            if (out.length>=MAX_PER_PROVIDER) break;
          }
        } catch {}
      }

      // Fallback: visible cards
      if (!out.length){
        const cards = await page.$$('[data-stid="property-listing"], [data-test-id="property-card"]');
        for (const c of cards){
          const nameEl = await c.$('h3[data-stid="content-hotel-title"], [itemprop="name"]');
          const name = nameEl ? (await nameEl.innerText()).trim() : '';
          const priceEl = await c.$('[data-stid="price-lockup"], span:has-text("SAR")');
          const priceTxt = priceEl ? (await priceEl.innerText()) : '';
          const price = toNum(priceTxt);
          const hrefEl = await c.$('a');
          let href = hrefEl ? await hrefEl.getAttribute('href') : '';
          if (href && !href.startsWith('http')) href = 'https://www.expedia.com'+href;
          if (!name || !href) continue;
          idx++;
          out.push({ platform:'Expedia', rank: idx, hotel: name, url: href, lowestPrice: Number.isFinite(price)?price:NaN, currency:'SAR' });
          if (out.length>=MAX_PER_PROVIDER) break;
        }
      }
      return out;
    },
    async units(page, hotelUrl){
      const out = [];
      await page.goto(hotelUrl, { waitUntil:'domcontentloaded', timeout: TIMEOUT });
      await acceptCookies(page);
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(()=>{});
      const script = await page.$('script[type="application/json"]#__NEXT_DATA__');
      if (script){
        try {
          const json = JSON.parse(await script.innerText());
          const roomsMatch = JSON.stringify(json).match(/"rooms":\s*(\[[\s\S]*?\])/);
          const rooms = roomsMatch ? JSON.parse(roomsMatch[1]) : [];
          for (const r of rooms.slice(0, MAX_UNIT_ROWS_PER_HOTEL)){
            const prices = [];
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

// --------------- Main ---------------
(async ()=>{
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled']
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    timezoneId: 'Asia/Riyadh',
    locale: 'en-US',
    viewport: { width: 1366, height: 768 }
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();

  const result = { date: ymd(new Date()), checkIn: ci, checkOut: co, cities: [], meta: {} };
  const CITIES = loadCities();
  console.log('Loaded cities:', CITIES.join(', '));

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
          hits = await providerTry(prov.search.bind(prov), prov.units, page, q, { listSel: null, name: provName });
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
      const chosen = uniqBy(alOnly.concat(top15), h=>`${h.platform}|${h.hotel}`);

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
      cityProviders[provName] = hotels.sort(byPriceAsc);
    }

    result.cities.push({ city, providers: cityProviders });
  }

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(`data/al-eairy-ota-${ci}.json`, JSON.stringify(result, null, 2));
  fs.writeFileSync(`data/latest.json`, JSON.stringify(result, null, 2));
  await browser.close();
  console.log('DONE', ci);
})();
