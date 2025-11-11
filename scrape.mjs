// scrape.mjs — Playwright headless scraper (free, public repo)
// هدفه: لكل مدينة سعودية يظهر فيها "العييري" على المنصات، يجيب أرخص 15
// على مستوى المدينة (مجمعة من المنصات) + يجرب يقرأ وحدات/غرف الفندق من صفحته.
//
// ملاحظات: سِلِكتورات المنصات تتغير أحيانًا؛ لو حصل، نُعدّلها ببساطة.
// رجاءً احترم شروط كل منصة. هذا حلّ تشغيلي منخفض التكلفة وليس شراكة رسمية.

import { chromium } from 'playwright';
import fs from 'fs';

const CITIES = [
  'Riyadh','Jeddah','Dammam','Al Ahsa','Al Hofuf','Khobar','Madinah','Mecca',
  'Buraidah','Hail','Tabuk','Abha','Khamis Mushait','Najran','Jazan','Al Baha',
  'Al Nairyah','Qatif','Yanbu','Arar','Sakaka','Hafar Al-Batin','Jubail','Unaizah'
];

// استخدم فحص الاسم لتحديد هل الفندق العييري
const BRAND_RX = [/al\s*eairy/i, /العييري/, /al-?ayeri/i];

const MAX_PER_PROVIDER = 15;
const MAX_UNIT_ROWS_PER_HOTEL = 20; // لحماية زمن التشغيل
const TIMEOUT = 35000;

const today = new Date();
const checkIn = new Date(today.getTime() + 1 * 24*60*60*1000);
const checkOut = new Date(today.getTime() + 2 * 24*60*60*1000);
const ymd = d => d.toISOString().slice(0,10);
const CHECKIN = ymd(checkIn);
const CHECKOUT = ymd(checkOut);

function isAlEairy(name=''){ return BRAND_RX.some(rx=>rx.test(name)); }
function toNum(s){ const t=(s||'').toString().replace(/[^\d.,]/g,'').replace(/,/g,''); return t?+t:NaN; }

async function go(page, url){
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
}

function sortByPriceAsc(arr){
  return arr.sort((a,b)=>{
    const ax = Number.isFinite(a.lowestPrice)?a.lowestPrice:Infinity;
    const bx = Number.isFinite(b.lowestPrice)?b.lowestPrice:Infinity;
    return ax-bx;
  });
}

/* -------- Providers (search + units) -------- */
const providers = {
  booking: {
    name: 'Booking',
    buildSearch(city){
      const q = encodeURIComponent(`${city}, Saudi Arabia`);
      return `https://www.booking.com/searchresults.html?ss=${q}&checkin=${CHECKIN}&checkout=${CHECKOUT}&group_adults=2&no_rooms=1&group_children=0&selected_currency=SAR&lang=en-us`;
    },
    async search(page, city){
      await go(page, this.buildSearch(city));
      // جرّب سيلكتورات متعددة (الديسكتوب)
      const cards = await page.$$('div[data-testid="property-card"]');
      const out = [];
      for (const card of cards){
        const titleEl = await card.$('div[data-testid="title"]');
        const name = titleEl ? (await titleEl.innerText()) : null;
        const priceEl = await card.$('[data-testid="price-and-discounted-price"], [aria-label="Price"]');
        const priceTxt = priceEl ? (await priceEl.innerText()).replace(/\s+/g,' ') : '';
        const price = toNum(priceTxt);
        const linkEl = await card.$('a[data-testid="title-link"]');
        const href = linkEl ? await linkEl.getAttribute('href') : null;
        if (!name || !href) continue;
        out.push({
          platform:'Booking',
          hotel: name.trim(),
          url: 'https://www.booking.com' + href,
          lowestPrice: Number.isFinite(price)?price:NaN,
          currency:'SAR'
        });
        if (out.length >= MAX_PER_PROVIDER) break;
      }
      return out;
    },
    async units(page, hotelUrl){
      const out = [];
      await go(page, hotelUrl);
      const roomSel = '[data-testid="room-name"], .hprt-roomtype-icon-link';
      const rooms = await page.$$(roomSel);
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

  agoda: {
    name: 'Agoda',
    buildSearch(city){
      const q = encodeURIComponent(`${city} Saudi Arabia`);
      return `https://www.agoda.com/search?checkIn=${CHECKIN}&los=1&rooms=1&adults=2&children=0&pslc=SAR&locale=en-us&text=${q}`;
    },
    async search(page, city){
      await go(page, this.buildSearch(city));
      const out = [];
      const cards = await page.$$('[data-testid="hotel-name"], [itemprop="name"]');
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
        out.push({ platform:'Agoda', hotel, url: href, lowestPrice: Number.isFinite(price)?price:NaN, currency:'SAR' });
        if (out.length >= MAX_PER_PROVIDER) break;
      }
      return out;
    },
    async units(page, hotelUrl){
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

  expedia: {
    name: 'Expedia',
    buildSearch(city){
      const q = encodeURIComponent(`${city}, Saudi Arabia`);
      return `https://www.expedia.com/Hotel-Search?destination=${q}&startDate=${CHECKIN}&endDate=${CHECKOUT}&adults=2&rooms=1&langid=1033&currency=SAR`;
    },
    async search(page, city){
      await go(page, this.buildSearch(city));
      const out = [];
      const dataEl = await page.$('#__NEXT_DATA__');
      if (dataEl){
        try {
          const json = JSON.parse(await dataEl.innerText());
          const items = (json?.props?.pageProps?.apolloState && Object.values(json.props.pageProps.apolloState).find(x=>x?.hotelResults)?.hotelResults) || [];
          for (const it of items){
            const name = it.name || it.hotelName;
            const price = +(it?.price?.lead?.amount || it?.price?.displayMessages?.[0]?.value?.amount || NaN);
            const path = it?.hotelPath || '';
            if (!name) continue;
            out.push({ platform:'Expedia', hotel:name.trim(),
              url: path ? (path.startsWith('http') ? path : `https://www.expedia.com${path}`) : '',
              lowestPrice: Number.isFinite(price)?price:NaN, currency:'SAR' });
            if (out.length >= MAX_PER_PROVIDER) break;
          }
        } catch(_){}
      }
      return out;
    },
    async units(page, hotelUrl){
      const out = [];
      await go(page, hotelUrl);
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
        } catch(_){}
      }
      return out;
    }
  }
};

function hasAlEairy(list){ return list.some(h => isAlEairy(h.hotel)); }

(async ()=>{
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
  });

  const result = { date: ymd(today), checkIn: CHECKIN, checkOut: CHECKOUT, cities: [] };

  for (const city of CITIES){
    let perProvider = [];
    for (const key of ['booking','agoda','expedia']){
      const p = providers[key];
      try {
        const hits = await p.search(page, city);
        perProvider = perProvider.concat(hits);
      } catch(e){ /* ignore */ }
    }

    if (!hasAlEairy(perProvider)) continue;

    sortByPriceAsc(perProvider);
    const cheapest15 = perProvider.slice(0, 15);

    const hotels = [];
    for (const h of cheapest15){
      const prov = providers[h.platform.toLowerCase()];
      let units = [];
      try {
        units = prov ? (await prov.units(page, h.url)) : [];
      } catch(e){ units = []; }
      hotels.push({
        platform: h.platform,
        rank: h.rank || null,
        hotel: h.hotel,
        url: h.url,
        lowestPrice: Number.isFinite(h.lowestPrice) ? h.lowestPrice : null,
        currency: h.currency || 'SAR',
        taxesIncluded: null,
        isAlEairy: isAlEairy(h.hotel),
        units: units.map(u=>({ name: u.name, price: u.price, cancellable: u.cancellable ?? null, nonRefundable: u.nonRefundable ?? null }))
      });
    }

    result.cities.push({ city, providers: ['Booking','Agoda','Expedia'], hotels });
  }

  await browser.close();

  fs.mkdirSync('data', { recursive: true });
  const fname = `data/al-eairy-ota-${ymd(today)}.json`;
  fs.writeFileSync(fname, JSON.stringify(result, null, 2));
  fs.writeFileSync('data/latest.json', JSON.stringify(result, null, 2));
  console.log('Written:', fname, 'and data/latest.json');
})();
