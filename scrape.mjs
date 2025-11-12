// scrape.mjs — v4.7  (Booking-first; longer waits; retries; EN→AR variants with daily rotation; ALL units; force brand row)
import { chromium } from 'playwright';
import fs from 'fs';

/* ---------- knobs ---------- */
const TIMEOUT = 75000;
const MAX_PER_PROVIDER = 15;
const MAX_UNIT_ROWS_PER_HOTEL = 120;
const SCROLL_STEPS = 20;
const SCROLL_DELAY = 800;
const RETRIES_PER_QUERY = 3;
/* --------------------------- */

// dates (next-day, 1 night)
const today = new Date();
const ci = ymd(new Date(today.getTime()+1*864e5));
const co = ymd(new Date(today.getTime()+2*864e5));
function ymd(d){ return d.toISOString().slice(0,10); }

// args
const ARGS = process.argv.slice(2);
const getArg = (k, def) => {
  const i = ARGS.indexOf(`--${k}`);
  return i >= 0 ? (ARGS[i+1] || '') : def;
};
const ENABLED = (getArg('enabled','Booking')||'Booking').split(',').map(s=>s.trim()).filter(Boolean);
const SEED = getArg('seed', `${Date.now()}`);

// brand detection
const BRAND_RX = [/al\s*eairy/i, /العييري/, /al-?ayeri/i];
const isAlEairy = (s='') => BRAND_RX.some(r=>r.test(s));

// helpers
function toNum(s){ const t=(s||'').toString().replace(/[^\d.,]/g,'').replace(/,/g,''); return t?+t:NaN; }
function uniqBy(arr, keyFn){ const st=new Set(); const out=[]; for (const x of arr){ const k=keyFn(x); if (st.has(k)) continue; st.add(k); out.push(x);} return out; }
const byPriceAsc = (a,b)=>((Number.isFinite(a.lowestPrice)?a.lowestPrice:1e15) - (Number.isFinite(b.lowestPrice)?b.lowestPrice:1e15));
function arNorm(s=''){return s.normalize('NFKD').replace(/[\u064B-\u065F\u0670]/g,'').replace(/[^\u0600-\u06FF\w]+/g,'').replace(/[آأإ]/g,'ا').replace(/ة/g,'ه').replace(/ى/g,'ي').replace(/ؤ/g,'و').replace(/ئ/g,'ي').trim();}
function djb2(str){ let h=5381; for (let i=0;i<str.length;i++) h=((h<<5)+h) ^ str.charCodeAt(i); return Math.abs(h)>>>0; }
function pickLocale(str){ return (djb2(SEED+str+ci)%3) ? 'en-us' : 'ar-sa'; }
function dailyRotate(arr, seed){ if (arr.length<2) return arr; const k = djb2(seed) % arr.length; return arr.slice(k).concat(arr.slice(0,k)); }

async function acceptCookies(page){
  const sels = ['#onetrust-accept-btn-handler','button[aria-label*="Accept"]','button:has-text("Accept")','button:has-text("I agree")','button:has-text("OK")','button:has-text("قبول")','button:has-text("أوافق")'];
  for (const s of sels){ try{ const el = await page.$(s); if (el) await el.click({timeout:2000}); }catch{} }
}
async function autoScroll(page, minCardsSel){
  for (let i=0;i<SCROLL_STEPS;i++){
    await page.evaluate(()=>window.scrollBy(0, window.innerHeight*0.92));
    await page.waitForTimeout(SCROLL_DELAY);
    if (minCardsSel){
      const n = (await page.$$(minCardsSel)).length;
      if (n >= MAX_PER_PROVIDER) break;
    }
  }
}

// cities (daily only – من ملفك)
function loadCities(){
  try {
    const txt = fs.readFileSync('data/cities.txt','utf8');
    const arr = txt.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    if (arr.length) return arr;
  } catch {}
  // fallback لو الملف مش موجود
  return ['بريدة','المدينة المنورة','الدمام','الأحساء','حائل','جازان'];
}

// variants/tokens
const VARIANTS = {
  'بريدة': ['Buraydah','Buraidah','بريدة'],
  'المدينة المنورة': ['Medina','Madinah','Al Madinah','المدينة المنورة'],
  'الدمام': ['Dammam','الدمام'],
  'الأحساء': ['Al Ahsa','Al-Hasa','Hofuf','Al Hofuf','الأحساء'],
  'حائل': ['Hail','حائل'],
  'جازان': ['Jazan','Jizan','جازان','جيزان'],
};
const TOK_EN = ['', ' apartments', ' furnished apartments', ' hotel apartments'];
const TOK_AR = ['', ' شقق مفروشة', ' شقق فندقية'];

const VAR_KEYS = Object.keys(VARIANTS);
function expandCity(city){
  const exact = VAR_KEYS.find(k=>arNorm(k)===arNorm(city));
  const base = exact ? VARIANTS[exact] : [city];
  const en = base.filter(x=>/^[A-Za-z]/.test(x));
  const ar = base.filter(x=>!/^[A-Za-z]/.test(x));
  const enQ = en.flatMap(v=>TOK_EN.map(t=>v+t));
  const arQ = ar.flatMap(v=>TOK_AR.map(t=>v+t));
  return dailyRotate(Array.from(new Set([...enQ, ...arQ])), city+ci+SEED);
}

/* ---------------- providers ---------------- */

const providers = {
  Booking: {
    name:'Booking',
    searchUrl: (q, locale) => `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(q)}&checkin=${ci}&checkout=${co}&group_adults=2&no_rooms=1&group_children=0&selected_currency=SAR&lang=${locale}`,
    async search(page, query){
      const locale = pickLocale(query);
      await page.goto(this.searchUrl(query+', Saudi Arabia', locale), { waitUntil:'domcontentloaded', timeout: TIMEOUT });
      await acceptCookies(page);
      await page.waitForTimeout(800 + (djb2(query+SEED)%1200));
      await page.waitForLoadState('networkidle', { timeout: 18000 }).catch(()=>{});
      await page.waitForSelector('div[data-testid="property-card"], #search_results_table', { timeout: 18000 }).catch(()=>{});
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
          url: 'https://www.booking.com'+href+`&checkin=${ci}&checkout=${co}&group_adults=2&no_rooms=1&group_children=0&selected_currency=SAR&lang=${locale}`,
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
      await page.waitForLoadState('networkidle', { timeout: 18000 }).catch(()=>{});

      const rows = await page.$$('tr, [data-testid*="availability-room"]');
      for (const r of rows.slice(0, MAX_UNIT_ROWS_PER_HOTEL)){
        const nameEl = await r.$('[data-testid="room-name"], .hprt-roomtype-icon-link, [data-room-name]');
        const title = nameEl ? (await nameEl.innerText().catch(()=>'')) : '';
        const blockTxt = (await r.innerText().catch(()=>'')) || '';
        const priceMatches = blockTxt.match(/(SAR|ر\.س|ريال)\s*([\d\.,]+)/g) || [];
        const nums = priceMatches.map(x=>toNum(x)).filter(Number.isFinite);
        if (!title || !nums.length) continue;
        const cheapest = Math.min(...nums);
        let canc = null, nonref = null;
        const lines = blockTxt.split(/\n+/);
        for (const ln of lines){
          const n = toNum(ln);
          if (!Number.isFinite(n)) continue;
          if (/إلغاء مجاني|free cancellation/i.test(ln)) canc = (canc==null)?n:Math.min(canc,n);
          if (/غير قابل للاسترداد|non-?refundable/i.test(ln)) nonref = (nonref==null)?n:Math.min(nonref,n);
        }
        out.push({ name: title.trim(), price: cheapest, cancellable: canc, nonRefundable: nonref });
      }
      // merge same unit by cheapest prices
      const merged = Object.values(out.reduce((acc, u)=>{
        const k = u.name.replace(/\s+/g,' ');
        if (!acc[k]) acc[k] = { name:k, price:u.price, cancellable:u.cancellable??null, nonRefundable:u.nonRefundable??null };
        else {
          acc[k].price = Math.min(acc[k].price, u.price);
          acc[k].cancellable = acc[k].cancellable==null ? u.cancellable : Math.min(acc[k].cancellable??1e15, u.cancellable??1e15);
          acc[k].nonRefundable = acc[k].nonRefundable==null ? u.nonRefundable : Math.min(acc[k].nonRefundable??1e15, u.nonRefundable??1e15);
        }
        return acc;
      }, {}));
      return merged;
    }
  },
};

/* ------- brand fallback: try "Al Eairy + city" if not found in Top15 ------- */
async function ensureBrandRow(page, cityName, provider, hits){
  if (hits.some(h=>isAlEairy(h.hotel))) return hits; // already there

  const variants = expandCity(cityName);
  const probes = [
    ...variants.map(v=>`Al Eairy ${v}`),
    ...variants.map(v=>`العييري ${v}`)
  ];
  for (const q of probes){
    try{
      for (let i=0;i<RETRIES_PER_QUERY;i++){
        const more = await provider.search(page, q);
        const brand = (more||[]).find(h=>isAlEairy(h.hotel));
        if (brand){
          // ضع رُتبة وهمية بعد آخر عنصر، بس هنرتب حسب السعر بعدين
          brand.rank = brand.rank || 99;
          return uniqBy([brand, ...hits], h=>`${h.platform}|${h.hotel}`);
        }
      }
    }catch{}
  }
  return hits; // ما لقيناهش
}

/* ---------------- main ---------------- */
(async ()=>{
  const UAS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/119 Safari/537.36'
  ];
  const ua = UAS[djb2(SEED)%UAS.length];

  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
  const context = await browser.newContext({ userAgent: ua, timezoneId: 'Asia/Riyadh', locale: 'en-US', viewport: { width: 1366, height: 768 } });
  await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const page = await context.newPage();

  const result = { date: ymd(new Date()), checkIn: ci, checkOut: co, cities: [], meta: {} };
  const CITIES = loadCities();

  function logMeta(city, prov, msg){
    if (!result.meta[city]) result.meta[city] = {};
    result.meta[city][prov] = msg;
  }

  for (const city of CITIES){
    const cityProviders = {};
    for (const provName of ENABLED){
      const prov = providers[provName];
      const tried = [];
      let hits = [];
      try{
        for (const q of expandCity(city)){
          tried.push(`${q}|${pickLocale(q)}`);
          for (let r=0;r<RETRIES_PER_QUERY;r++){
            hits = await prov.search(page, q);
            if (hits?.length) break;
            await page.waitForTimeout(1000 + (djb2(q+SEED)%1200));
          }
          if (hits?.length) break;
        }
      }catch(e){
        logMeta(city, provName, `error:${e.message||''}`);
      }
      if (!hits?.length){
        logMeta(city, provName, `no-results:${tried.join(',')}`);
        cityProviders[provName] = [];
        continue;
      }

      // أضمن سطر العييري حتى لو مش في Top15
      hits = await ensureBrandRow(page, city, prov, hits);

      const chosen = uniqBy(hits.slice(0, MAX_PER_PROVIDER), h=>`${h.platform}|${h.hotel}`);
      const hotels = [];
      for (const h of chosen){
        let units = [];
        try { units = await prov.units(page, h.url); } catch {}
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
})();
