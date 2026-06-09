const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const COUNTRY_CODES = {
  'USA': 'US',
  'UK': 'GB',
  'US': 'US',
  'GB': 'GB',
  'ES': 'ES'
};

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'Meta Ads Scraper activo',
    version: '1.0',
    endpoints: ['/scrape-ads', '/health']
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Lógica central de scraping (compartida por GET y POST)
async function handleScrape(params, res) {
  const {
    country = 'US',
    niche = '',
    min_days_active = 30,
    platform = 'all',
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
  dumpio: true,
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

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    await page.setViewport({ width: 1280, height: 800 });

    // Bloquear recursos innecesarios para ir más rápido
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['font', 'media'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    const searchUrl = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${countryCode}&q=${encodeURIComponent(niche)}&search_type=keyword_unordered&media_type=all`;
    console.log('[URL]', searchUrl);

    await page.goto(searchUrl, {
      waitUntil: 'networkidle2',
      timeout: 45000
    });

    // Esperar carga inicial
    await new Promise(r => setTimeout(r, 5000));

    // Scroll para cargar más resultados
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
    await new Promise(r => setTimeout(r, 2000));
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise(r => setTimeout(r, 2000));

    // Extraer HTML para debugging
    const html = await page.content();
    console.log('[HTML length]', html.length);

    // Extraer anuncios
    const ads = await page.evaluate((limitCount) => {
      const results = [];
      
      // Múltiples selectores por si cambia el DOM de Facebook
      const selectors = [
        '[data-testid="ad-archive-card"]',
        '._7jvw',
        '.x1dr75xp.x1ja2u2z',
        '[class*="adCard"]',
        'div[class*="_7j"]'
      ];

      let cards = [];
      for (const sel of selectors) {
        cards = document.querySelectorAll(sel);
        if (cards.length > 0) break;
      }

      // Si no encontramos cards con selectores específicos, buscamos por estructura
      if (cards.length === 0) {
        // Buscar divs que contengan información de anuncios
        const allDivs = document.querySelectorAll('div');
        cards = Array.from(allDivs).filter(div => {
          const text = div.innerText || '';
          return text.includes('Comenzó a publicarse') || 
                 text.includes('Started running') ||
                 text.includes('Active since');
        }).slice(0, limitCount);
      }

      Array.from(cards).slice(0, limitCount).forEach((card, index) => {
        try {
          const text = card.innerText || '';
          const lines = text.split('\n').filter(l => l.trim().length > 0);
          
          // Nombre de página (primera línea significativa)
          const pageName = lines[0]?.trim() || 'Página desconocida';
          
          // Texto del anuncio
          const adText = lines.slice(1, 4).join(' ').trim().substring(0, 400);
          
          // Fecha de inicio
          const dateMatch = text.match(/(Started running|Comenzó a publicarse|Active since)[:\s]+([^\n]+)/i);
          const startDate = dateMatch ? dateMatch[2].trim() : '';

          // Links
          const links = Array.from(card.querySelectorAll('a')).map(a => a.href).filter(h => h && !h.includes('javascript'));
          const pageUrl = links.find(l => l.includes('facebook.com/') && !l.includes('ads/library')) || '';
          
          // Imagen
          const img = card.querySelector('img');
          const imageUrl = img?.src || '';

          // ID del anuncio desde el DOM
          const adIdMatch = card.innerHTML.match(/\/ads\/library\/\?id=(\d+)/);
          const adId = adIdMatch ? adIdMatch[1] : `${Date.now()}_${index}`;

          results.push({
            ad_archive_id: adId,
            page_name: pageName,
            ad_copy: adText,
            ad_text: adText,
            start_date: startDate,
            image_url: imageUrl,
            page_url: pageUrl,
            library_url: adId.match(/^\d+$/) ? `https://www.facebook.com/ads/library/?id=${adId}` : ''
          });
        } catch (e) {}
      });

      return results;
    }, limit);

    await browser.close();
    browser = null;

    // Calcular días activos
    const processedAds = ads.map(ad => {
      let daysActive = null;
      if (ad.start_date) {
        const now = new Date();
        // Formato: "January 15, 2024" o "hace X días/semanas"
        const dateObj = new Date(ad.start_date);
        if (!isNaN(dateObj.getTime())) {
          daysActive = Math.floor((now - dateObj) / (1000 * 60 * 60 * 24));
        }
        // Formato relativo en inglés
        const daysMatch = ad.start_date.match(/(\d+)\s*day/i);
        const weeksMatch = ad.start_date.match(/(\d+)\s*week/i);
        const monthsMatch = ad.start_date.match(/(\d+)\s*month/i);
        if (daysMatch) daysActive = parseInt(daysMatch[1]);
        else if (weeksMatch) daysActive = parseInt(weeksMatch[1]) * 7;
        else if (monthsMatch) daysActive = parseInt(monthsMatch[1]) * 30;
      }
      return { ...ad, days_active: daysActive };
    }).filter(ad => {
      if (min_days_active && ad.days_active !== null) {
        return ad.days_active >= min_days_active;
      }
      return true;
    });

    console.log(`[RESULTADO] ${processedAds.length} anuncios encontrados`);

    res.json({
      success: true,
      query: { niche, country: countryCode, min_days_active, limit },
      total_found: processedAds.length,
      ads: processedAds,
      search_url: `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${countryCode}&q=${encodeURIComponent(niche)}&search_type=keyword_unordered`
    });

  } catch (error) {
    if (browser) {
      try { await browser.close(); } catch(e) {}
    }
    console.error('[ERROR]', error.message);
    res.status(500).json({ 
      success: false,
      error: error.message,
      query: { niche, country: countryCode }
    });
  }
}

// POST /scrape-ads (uso original)
app.post('/scrape-ads', async (req, res) => {
  if (!req.body.niche) {
    return res.status(400).json({ error: 'El parámetro niche es obligatorio' });
  }
  await handleScrape({
    ...req.body,
    min_days_active: parseInt(req.body.min_days_active) || 30,
    limit: parseInt(req.body.limit) || 10
  }, res);
});

// GET /scrape-ads (para llamadas desde web_fetch / Claude tools)
app.get('/scrape-ads', async (req, res) => {
  const { country = 'US', niche = '', min_days_active = 30, limit = 10, platform = 'all' } = req.query;
  if (!niche) {
    return res.status(400).json({ error: 'El parámetro niche es obligatorio' });
  }
  await handleScrape({
    country,
    niche,
    min_days_active: parseInt(min_days_active),
    limit: parseInt(limit),
    platform
  }, res);
});

app.listen(PORT, () => {
  console.log(`Meta Ads Scraper corriendo en puerto ${PORT}`);
});
