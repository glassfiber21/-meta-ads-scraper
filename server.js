const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;

const COUNTRY_CODES = {
  'USA': 'US', 'UK': 'GB', 'US': 'US', 'GB': 'GB', 'ES': 'ES'
};

app.get('/', (req, res) => {
  res.json({ status: 'Meta Ads Scraper activo', version: '2.0', endpoints: ['/scrape-ads', '/health'] });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

function isEnglish(text) {
  if (!text) return false;
  const spanishWords = ['hogar','cocina','muebles','desde','para','con','que','una','sus','los','las','del','por','más','tiene','este','esta','nuestro','nuestra','también','pero','como','todo','nuevo','nueva','sobre','entre','hasta','cuando','donde','porque'];
  const lower = text.toLowerCase();
  const spanishCount = spanishWords.filter(w => lower.includes(w)).length;
  return spanishCount < 3;
}

function extractProductName(copy, pageName) {
  if (!copy) return pageName;
  const productPatterns = [
    /(?:introducing|meet the|try the|get the|shop the|buy the|discover the)\s+([A-Z][^.!?\n]{5,50})/i,
    /^([A-Z][a-zA-Z\s]{3,40}(?:Pro|Max|Plus|Mini|Ultra|Lite)?)\s*[-–—]/,
    /([A-Z][a-zA-Z\s]{3,35}(?:Machine|Maker|Cleaner|Massager|Blender|Cooker|Heater|Fan|Light|Lamp|Bag|Mat|Pad|Brush|Roller|Steamer|Dryer|Trimmer|Shaver|Watch|Tracker|Band|Ring|Bottle|Cup|Mug|Rack|Organizer|Storage|Basket|Hanger|Shower|Pillow|Blanket|Curtain))/i,
  ];
  for (const pattern of productPatterns) {
    const match = copy.match(pattern);
    if (match && match[1] && match[1].length > 5) return match[1].trim().slice(0, 60);
  }
  const firstLine = copy.split(/[.!?\n]/)[0].trim();
  if (firstLine.length > 8 && firstLine.length < 80) return firstLine;
  return pageName;
}

async function handleScrape(params, res) {
  const {
    country = 'US',
    niche = '',
    min_days_active = 30,
    limit = 10
  } = params;

  if (!niche) {
    return res.status(400).json({ error: 'El parámetro niche es obligatorio' });
  }

  const countryCode = COUNTRY_CODES[country.toUpperCase()] || 'US';
  console.log(`[SCRAPING] nicho="${niche}" | país=${countryCode} | días_min=${min_days_active} | límite=${limit}`);

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable',
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--disable-extensions'
      ]
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 900 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9'
    });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['font', 'media'].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    const searchUrl = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${countryCode}&q=${encodeURIComponent(niche)}&search_type=keyword_unordered&media_type=all&sort_data[mode]=total_impressions&sort_data[direction]=desc`;
    console.log('[URL]', searchUrl);

    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await new Promise(r => setTimeout(r, 6000));

    for (let i = 0; i < 3; i++) {
      await page.evaluate((step, total) => window.scrollTo(0, document.body.scrollHeight * step / total), i + 1, 3);
      await new Promise(r => setTimeout(r, 1500));
    }

    const html = await page.content();
    console.log('[HTML length]', html.length);

    const ads = await page.evaluate((limitCount) => {
      const results = [];

      // Parse the full page text into individual ad blocks
      const fullText = document.body.innerText;
      
      // Split by "Active\nLibrary ID:" pattern which starts each ad
      const adBlocks = fullText.split(/(?=Active\nLibrary ID:)/);
      
      adBlocks.slice(0, limitCount * 2).forEach((block, index) => {
        try {
          if (!block.includes('Library ID:')) return;
          
          // Extract Library ID
          const idMatch = block.match(/Library ID:\s*(\d+)/);
          if (!idMatch) return;
          const adId = idMatch[1];
          
          // Extract start date
          const dateMatch = block.match(/Started running on\s+([^\n]+)/);
          const startDate = dateMatch ? dateMatch[1].trim() : '';
          
          // Extract page name (line after "See ad details\n")
          const pageMatch = block.match(/See ad details\n([^\n]+)/);
          let pageName = pageMatch ? pageMatch[1].trim() : '';
          
          // Remove "Sponsored" suffix if present
          pageName = pageName.replace(/\nSponsored$/, '').trim();
          
          // Extract ad copy (lines after "Sponsored\n")
          const sponsoredIdx = block.indexOf('Sponsored
');
          let adCopy = '';
          if (sponsoredIdx !== -1) {
            const afterSponsored = block.substring(sponsoredIdx + 10);
            // Take first 4 meaningful lines
            const copyLines = afterSponsored.split('\n')
              .filter(l => l.trim().length > 5 && !l.match(/^(http|www|\[)/i) && !l.match(/^#\w+/))
              .slice(0, 4);
            adCopy = copyLines.join(' ').trim().substring(0, 500);
          }
          
          // Get image from DOM using the ad ID
          const imgEl = document.querySelector(`[id*="${adId}"] img, a[href*="${adId}"] img`);
          const imageUrl = imgEl?.src || '';
          
          if (pageName && adCopy) {
            results.push({
              ad_archive_id: adId,
              page_name: pageName.substring(0, 80),
              ad_copy: adCopy,
              ad_text: adCopy,
              start_date: startDate,
              image_url: imageUrl,
              page_url: '',
              library_url: `https://www.facebook.com/ads/library/?id=${adId}`
            });
          }
        } catch(e) {}
      });

      return results;
    }, limit);

    await browser.close();
    browser = null;

    const now = new Date();
    const processedAds = ads.map(ad => {
      let daysActive = null;
      if (ad.start_date) {
        const dateObj = new Date(ad.start_date);
        if (!isNaN(dateObj.getTime())) {
          daysActive = Math.floor((now - dateObj) / (1000 * 60 * 60 * 24));
        }
        const daysMatch = ad.start_date.match(/(\d+)\s*day/i);
        const weeksMatch = ad.start_date.match(/(\d+)\s*week/i);
        const monthsMatch = ad.start_date.match(/(\d+)\s*month/i);
        if (daysMatch) daysActive = parseInt(daysMatch[1]);
        else if (weeksMatch) daysActive = parseInt(weeksMatch[1]) * 7;
        else if (monthsMatch) daysActive = parseInt(monthsMatch[1]) * 30;
      }
      const productName = extractProductName(ad.ad_copy, ad.page_name);
      return { ...ad, product_name: productName, days_active: daysActive, is_english: isEnglish(ad.ad_copy) };
    })
    .filter(ad => {
      if (!ad.ad_copy || ad.ad_copy.length < 10) return false;
      if (countryCode === 'US' && !ad.is_english) return false;
      if (min_days_active && ad.days_active !== null) return ad.days_active >= min_days_active;
      return true;
    })
    .slice(0, limit);

    console.log(`[RESULTADO] ${processedAds.length} anuncios (de ${ads.length} totales)`);

    res.json({
      success: true,
      query: { niche, country: countryCode, min_days_active, limit },
      total_found: processedAds.length,
      ads: processedAds,
      search_url: searchUrl
    });

  } catch (error) {
    if (browser) { try { await browser.close(); } catch(e) {} }
    console.error('[ERROR]', error.message);
    res.status(500).json({ success: false, error: error.message, query: { niche, country: countryCode } });
  }
}

app.post('/scrape-ads', async (req, res) => {
  if (!req.body.niche) return res.status(400).json({ error: 'El parámetro niche es obligatorio' });
  await handleScrape({
    ...req.body,
    min_days_active: parseInt(req.body.min_days_active) || 30,
    limit: parseInt(req.body.limit) || 10
  }, res);
});

app.get('/scrape-ads', async (req, res) => {
  const { country = 'US', niche = '', min_days_active = 30, limit = 10 } = req.query;
  if (!niche) return res.status(400).json({ error: 'El parámetro niche es obligatorio' });
  await handleScrape({
    country, niche,
    min_days_active: parseInt(min_days_active),
    limit: parseInt(limit)
  }, res);
});

const path = require('path');

// Servir el cazador de productos
app.get('/cazador', (req, res) => {
  res.sendFile(path.join(__dirname, 'cazador.html'));
});

// Servir archivos estáticos
app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`Meta Ads Scraper v2.0 corriendo en puerto ${PORT}`);
});
