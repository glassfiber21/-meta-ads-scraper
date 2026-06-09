const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const COUNTRY_CODES = {
  'USA': 'US', 'UK': 'GB', 'US': 'US', 'GB': 'GB', 'ES': 'ES'
};

app.get('/', (req, res) => {
  res.json({ status: 'Meta Ads Scraper activo', version: '2.0', endpoints: ['/scrape-ads', '/health'] });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Detecta si el texto es principalmente en inglés
function isEnglish(text) {
  if (!text) return false;
  const spanishWords = ['hogar','cocina','muebles','desde','para','con','que','una','sus','los','las','del','por','más','tiene','este','esta','nuestro','nuestra','también','pero','como','todo','nuevo','nueva','sobre','entre','hasta','cuando','donde','porque'];
  const lower = text.toLowerCase();
  const spanishCount = spanishWords.filter(w => lower.includes(w)).length;
  return spanishCount < 3;
}

// Extrae nombre de producto del copy del anuncio
function extractProductName(copy, pageName) {
  if (!copy) return pageName;
  // Buscar producto concreto: palabras con mayúscula seguidas de descripción
  const productPatterns = [
    /(?:introducing|meet the|try the|get the|shop the|buy the|discover the)\s+([A-Z][^.!?\n]{5,50})/i,
    /^([A-Z][a-zA-Z\s]{3,40}(?:Pro|Max|Plus|Mini|Ultra|Lite)?)\s*[-–—]/,
    /([A-Z][a-zA-Z\s]{3,35}(?:Machine|Maker|Cleaner|Massager|Blender|Cooker|Heater|Fan|Light|Lamp|Bag|Mat|Pad|Brush|Roller|Steamer|Dryer|Trimmer|Shaver|Watch|Tracker|Band|Ring|Bottle|Cup|Mug|Rack|Organizer|Storage|Basket|Hanger|Shower|Pillow|Blanket|Curtain))/i,
  ];
  for (const pattern of productPatterns) {
    const match = copy.match(pattern);
    if (match && match[1] && match[1].length > 5) return match[1].trim().slice(0, 60);
  }
  // Usar las primeras palabras significativas del copy
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
      headless: 'new',
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--no-zygote','--single-process','--disable-extensions']
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 900 });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['font','media'].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    // Buscar en inglés para mercado USA
    const searchUrl = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${countryCode}&q=${encodeURIComponent(niche)}&search_type=keyword_unordered&media_type=all&sort_data[mode]=total_impressions&sort_data[direction]=desc`;
    console.log('[URL]', searchUrl);

    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 6000));

    // Scroll progresivo para cargar más anuncios
    for (let i = 0; i < 3; i++) {
      await page.evaluate((step, total) => window.scrollTo(0, document.body.scrollHeight * step / total), i + 1, 3);
      await new Promise(r => setTimeout(r, 1500));
    }

    const html = await page.content();
    console.log('[HTML length]', html.length);

    const ads = await page.evaluate((limitCount) => {
      const results = [];

      // Selectores actualizados para Meta Ads Library 2025
      const selectors = [
        '[data-testid="ad-archive-card"]',
        '._7jvw', '._8njr', '._7jvs',
        '.x1dr75xp.x1ja2u2z',
        'div[class*="xh8yej3"]',
      ];

      let cards = [];
      for (const sel of selectors) {
        cards = document.querySelectorAll(sel);
        if (cards.length >= 2) break;
      }

      // Fallback: buscar por texto identificativo de anuncios activos
      if (cards.length < 2) {
        const allDivs = Array.from(document.querySelectorAll('div'));
        // Buscar contenedores que tengan ID de biblioteca
        const withId = allDivs.filter(div => {
          const text = div.innerText || '';
          return (text.includes('Library ID') || text.includes('Identificador de la biblioteca')) &&
                 (text.includes('Started running') || text.includes('En circulación desde'));
        });
        cards = withId.slice(0, limitCount);
      }

      Array.from(cards).slice(0, limitCount * 2).forEach((card, index) => {
        try {
          const text = card.innerText || '';
          if (text.length < 20) return;
          const lines = text.split('\n').filter(l => l.trim().length > 2);

          // Extraer ID de biblioteca del HTML
          const idMatch = card.innerHTML.match(/(?:id=|library_id=|"id":")(\d{10,})/);
          const libIdMatch = card.innerHTML.match(/\/ads\/library\/\?id=(\d+)/);
          const adId = libIdMatch ? libIdMatch[1] : (idMatch ? idMatch[1] : `${Date.now()}_${index}`);

          // Extraer nombre de página
          const pageNameEl = card.querySelector('[data-testid="ad-archive-card-page-name"], a[href*="facebook.com/"]');
          let pageName = pageNameEl?.innerText?.trim() || '';
          if (!pageName) {
            // Buscar línea que no sea metadata
            pageName = lines.find(l => l.length > 2 && l.length < 60 && !l.includes(':') && !l.match(/^\d/) && !l.includes('Activo') && !l.includes('Active') && !l.includes('Platform') && !l.includes('Publicidad')) || 'Advertiser';
          }

          // Extraer copy del anuncio (texto del producto)
          const copyLines = lines.filter(l =>
            l.length > 10 &&
            !l.match(/^(Activo|Active|Plataformas|Platforms|Identificador|Library ID|En circulación|Started running|Este anuncio|This ad|Ver detalles|See details|Publicidad|Sponsored)/i) &&
            !l.match(/^\d{5,}$/)
          );
          const adCopy = copyLines.slice(0, 4).join(' ').trim().substring(0, 500);

          // Extraer fecha de inicio
          const dateMatch = text.match(/(?:Started running|En circulación desde el?)\s+(\d+\s+\w+\s+\d{4}|\w+\s+\d+,?\s+\d{4}|\d+\s+\w+\s+\d{4})/i);
          const startDate = dateMatch ? dateMatch[1].trim() : '';

          // Extraer imagen
          const img = card.querySelector('img[src*="fbcdn"], img[src*="facebook"]');
          const imageUrl = img?.src || '';

          // URL de página
          const pageLink = card.querySelector('a[href*="facebook.com/"]:not([href*="ads/library"])');
          const pageUrl = pageLink?.href || '';

          if (adCopy.length > 5 || pageName.length > 2) {
            results.push({
              ad_archive_id: adId,
              page_name: pageName.slice(0, 80),
              ad_copy: adCopy,
              ad_text: adCopy,
              start_date: startDate,
              image_url: imageUrl,
              page_url: pageUrl,
              library_url: adId.match(/^\d{10,}$/) ? `https://www.facebook.com/ads/library/?id=${adId}` : ''
            });
          }
        } catch (e) { console.log('card error:', e.message); }
      });

      return results;
    }, limit);

    await browser.close();
    browser = null;

    // Calcular días activos
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

      // Extraer producto concreto del copy
      const productName = extractProductName(ad.ad_copy, ad.page_name);

      return {
        ...ad,
        product_name: productName,
        days_active: daysActive,
        is_english: isEnglish(ad.ad_copy)
      };
    })
    .filter(ad => {
      // Filtrar anuncios sin contenido útil
      if (!ad.ad_copy || ad.ad_copy.length < 10) return false;
      // Para USA, priorizar inglés
      if (countryCode === 'US' && !ad.is_english) return false;
      // Filtro de días activos
      if (min_days_active && ad.days_active !== null) {
        return ad.days_active >= min_days_active;
      }
      return true;
    })
    .slice(0, limit);

    console.log(`[RESULTADO] ${processedAds.length} anuncios encontrados (de ${ads.length} totales)`);

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

// POST /scrape-ads
app.post('/scrape-ads', async (req, res) => {
  if (!req.body.niche) return res.status(400).json({ error: 'El parámetro niche es obligatorio' });
  await handleScrape({
    ...req.body,
    min_days_active: parseInt(req.body.min_days_active) || 30,
    limit: parseInt(req.body.limit) || 10
  }, res);
});

// GET /scrape-ads
app.get('/scrape-ads', async (req, res) => {
  const { country = 'US', niche = '', min_days_active = 30, limit = 10 } = req.query;
  if (!niche) return res.status(400).json({ error: 'El parámetro niche es obligatorio' });
  await handleScrape({
    country, niche,
    min_days_active: parseInt(min_days_active),
    limit: parseInt(limit)
  }, res);
});

app.get('/chrome-test', async (req, res) => {
  let browser;

  try {

    console.log('=== CHROME TEST INICIADO ===');

    browser = await puppeteer.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      headless: true,
      dumpio: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    console.log('=== CHROME ARRANCADO ===');

    const page = await browser.newPage();

   console.log('ANTES DEL GOTO');

await page.goto(searchUrl, {
  waitUntil: 'domcontentloaded',
  timeout: 45000
});

console.log('DESPUÉS DEL GOTO');

    const title = await page.title();

    await browser.close();

    res.json({
      success: true,
      title
    });

  } catch (error) {

    console.error('CHROME TEST ERROR:', error);

    if (browser) {
      try {
        await browser.close();
      } catch(e) {}
    }

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
app.listen(PORT, () => {
  console.log(`Meta Ads Scraper v2.0 corriendo en puerto ${PORT}`);
});
