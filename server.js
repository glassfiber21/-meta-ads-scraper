const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const path = require('path');

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());

const PORT = process.env.PORT || 8080;
const COUNTRY_CODES = { 'USA':'US','UK':'GB','US':'US','GB':'GB','ES':'ES' };

app.get('/', (req, res) => res.json({ status: 'Meta Ads Scraper activo', version: '3.0', endpoints: ['/scrape-ads','/health'] }));
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get('/cazador', (req, res) => res.sendFile(path.join(__dirname, 'cazador.html')));
app.use(express.static(__dirname));

function isEnglish(text) {
  if (!text) return false;
  const spanishWords = ['hogar','cocina','muebles','desde','para','con','que','una','sus','los','las','del','por','más','tiene','este','esta','nuestro','nuestra','también','pero','como','todo','nuevo','nueva'];
  const lower = text.toLowerCase();
  return spanishWords.filter(w => lower.includes(w)).length < 3;
}

function slugToTitle(slug) {
  if (!slug) return '';
  return slug
    .replace(/[-_]/g, ' ')
    .replace(/\.(html?|php|aspx?)$/i, '')
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
    .trim();
}

function extractProductFromUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const path = u.pathname;
    // Shopify: /products/product-name
    const shopify = path.match(/\/products\/([^/?#]+)/i);
    if (shopify) return slugToTitle(shopify[1]);
    // WooCommerce: /product/product-name
    const woo = path.match(/\/product\/([^/?#]+)/i);
    if (woo) return slugToTitle(woo[1]);
    // Generic last segment
    const parts = path.split('/').filter(Boolean);
    const last = parts[parts.length - 1];
    if (last && last.length > 3 && !last.match(/^(index|home|shop|store|cart|checkout)$/i)) {
      return slugToTitle(last);
    }
  } catch(e) {}
  return '';
}

async function handleScrape(params, res) {
  const { country = 'US', niche = '', min_days_active = 30, limit = 6 } = params;
  if (!niche) return res.status(400).json({ error: 'El parámetro niche es obligatorio' });

  const countryCode = COUNTRY_CODES[country.toUpperCase()] || 'US';
  console.log(`[v3] nicho="${niche}" | país=${countryCode} | días_min=${min_days_active} | límite=${limit}`);

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable',
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--no-zygote','--disable-extensions']
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 900 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['font','media'].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    // FASE 1: Extraer muchos anuncios (hasta 100 internamente)
    const searchUrl = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${countryCode}&q=${encodeURIComponent(niche)}&search_type=keyword_unordered&media_type=all&sort_data[mode]=total_impressions&sort_data[direction]=desc`;
    console.log('[URL]', searchUrl);

    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 6000));

    for (let i = 0; i < 4; i++) {
      await page.evaluate(s => window.scrollTo(0, document.body.scrollHeight * s / 4), i + 1);
      await new Promise(r => setTimeout(r, 1500));
    }

    const html = await page.content();
    console.log('[HTML length]', html.length);

    // FASE 1: Parse anuncios del texto de la página
    const rawAds = await page.evaluate(() => {
      const results = [];
      const fullText = document.body.innerText;
      const blocks = fullText.split(/(?=Active\nLibrary ID:)/);

      blocks.forEach((block, index) => {
        if (!block.includes('Library ID:')) return;

        const idMatch = block.match(/Library ID:\s*(\d+)/);
        if (!idMatch) return;
        const adId = idMatch[1];

        const dateMatch = block.match(/Started running on\s+([^\n]+)/);
        const startDate = dateMatch ? dateMatch[1].trim() : '';

        const pageMatch = block.match(/See ad details\n([^\n]+)/);
        let pageName = pageMatch ? pageMatch[1].trim() : '';

        const sponsoredIdx = block.indexOf('Sponsored\n');
        let adCopy = '';
        let ctaLink = '';

        if (sponsoredIdx !== -1) {
          const afterSponsored = block.substring(sponsoredIdx + 10);
          const lines = afterSponsored.split('\n').filter(l => l.trim().length > 3);

          // Copy: primeras líneas de texto que no sean metadatos
          const copyLines = lines.filter(l =>
            !l.match(/^(http|www|\[|Shop Now|Learn More|Buy Now|Download|Sign Up|Get Started|See More|Watch More|Subscribe)/i) &&
            !l.match(/^\d+:\d+/) &&
            l.length > 5
          ).slice(0, 5);
          adCopy = copyLines.join(' ').trim().substring(0, 600);

          // Extraer CTA link (URL de la landing page)
          const urlMatch = block.match(/https?:\/\/[^\s\n]+\.(com|co|io|net|org|shop|store)[^\s\n]*/gi);
          if (urlMatch) {
            ctaLink = urlMatch.find(u => !u.includes('facebook.com') && !u.includes('fb.com')) || '';
          }
        }

        // Extraer imagen
        const imgEl = document.querySelector(`[href*="${adId}"] img, [id*="${adId}"] img`);
        const imageUrl = imgEl?.src || '';

        if (pageName && (adCopy || ctaLink)) {
          results.push({
            ad_archive_id: adId,
            page_name: pageName.substring(0, 80),
            ad_copy: adCopy,
            start_date: startDate,
            cta_link: ctaLink,
            image_url: imageUrl,
            library_url: `https://www.facebook.com/ads/library/?id=${adId}`
          });
        }
      });

      return results;
    });

    console.log(`[FASE 1] ${rawAds.length} anuncios extraídos`);

    // FASE 2 + 3: Para cada anuncio, extraer producto real de la landing page
    const processedAds = [];
    for (const ad of rawAds.slice(0, Math.min(rawAds.length, 40))) {
      let productName = '';
      let landingDomain = '';

      // Intentar extraer producto de la URL del CTA
      if (ad.cta_link) {
        productName = extractProductFromUrl(ad.cta_link);
        try { landingDomain = new URL(ad.cta_link).hostname.replace('www.',''); } catch(e) {}
      }

      // Si no tenemos producto de la URL, intentar desde el copy
      if (!productName) {
        const copyLines = (ad.ad_copy || '').split(/[.!?\n]/);
        const firstLine = copyLines[0]?.trim();
        if (firstLine && firstLine.length > 5 && firstLine.length < 80) {
          productName = firstLine;
        } else {
          productName = ad.page_name;
        }
      }

      // Calcular días activos
      let daysActive = null;
      if (ad.start_date) {
        const dateObj = new Date(ad.start_date);
        if (!isNaN(dateObj.getTime())) {
          daysActive = Math.floor((Date.now() - dateObj.getTime()) / (1000 * 60 * 60 * 24));
        }
        const daysMatch = ad.start_date.match(/(\d+)\s*day/i);
        const weeksMatch = ad.start_date.match(/(\d+)\s*week/i);
        const monthsMatch = ad.start_date.match(/(\d+)\s*month/i);
        if (daysMatch) daysActive = parseInt(daysMatch[1]);
        else if (weeksMatch) daysActive = parseInt(weeksMatch[1]) * 7;
        else if (monthsMatch) daysActive = parseInt(monthsMatch[1]) * 30;
      }

      processedAds.push({
        ...ad,
        product_name: productName.substring(0, 80),
        landing_domain: landingDomain,
        days_active: daysActive,
        is_english: isEnglish(ad.ad_copy)
      });
    }

    // FASE 4: Agrupar por producto similar
    const productGroups = {};
    for (const ad of processedAds) {
      if (!ad.ad_copy || ad.ad_copy.length < 10) continue;
      if (countryCode === 'US' && !ad.is_english) continue;
      if (ad.ad_copy.includes('play.google.com') || ad.ad_copy.includes('apps.apple.com')) continue;
      if (ad.page_name.toLowerCase() === 'tiktok' || ad.page_name.toLowerCase() === 'tiktok - us') continue;
      if (min_days_active && ad.days_active !== null && ad.days_active < min_days_active) continue;

      // Agrupar por dominio de landing o por nombre de producto normalizado
      const groupKey = ad.landing_domain || ad.product_name.toLowerCase().substring(0, 30);

      if (!productGroups[groupKey]) {
        productGroups[groupKey] = {
          product_name: ad.product_name,
          landing_domain: ad.landing_domain,
          ads: [],
          best_copy: ad.ad_copy,
          best_image: ad.image_url,
          max_days: ad.days_active || 0,
          library_url: ad.library_url,
          ad_archive_id: ad.ad_archive_id,
          page_name: ad.page_name
        };
      }

      productGroups[groupKey].ads.push(ad);
      if ((ad.days_active || 0) > productGroups[groupKey].max_days) {
        productGroups[groupKey].max_days = ad.days_active;
        productGroups[groupKey].best_copy = ad.ad_copy;
        productGroups[groupKey].best_image = ad.image_url;
        productGroups[groupKey].library_url = ad.library_url;
        productGroups[groupKey].ad_archive_id = ad.ad_archive_id;
      }
    }

    // FASE 5: Calcular score y ordenar
    const scored = Object.values(productGroups).map(group => {
      const score = (group.ads.length * 3) + ((group.max_days || 0) * 0.5);
      return {
        ad_archive_id: group.ad_archive_id,
        page_name: group.page_name,
        product_name: group.product_name,
        landing_domain: group.landing_domain,
        ad_copy: group.best_copy,
        ad_text: group.best_copy,
        image_url: group.best_image,
        library_url: group.library_url,
        days_active: group.max_days,
        total_ads: group.ads.length,
        score: Math.round(score),
        advertiser_count: new Set(group.ads.map(a => a.page_name)).size
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

    await browser.close();
    browser = null;

    console.log(`[RESULTADO] ${scored.length} productos agrupados (de ${rawAds.length} anuncios)`);

    res.json({
      success: true,
      query: { niche, country: countryCode, min_days_active, limit },
      total_found: scored.length,
      ads: scored,
      search_url: searchUrl
    });

  } catch (error) {
    if (browser) { try { await browser.close(); } catch(e) {} }
    console.error('[ERROR]', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
}

app.post('/scrape-ads', async (req, res) => {
  if (!req.body.niche) return res.status(400).json({ error: 'niche es obligatorio' });
  await handleScrape({ ...req.body, min_days_active: parseInt(req.body.min_days_active)||30, limit: parseInt(req.body.limit)||6 }, res);
});

app.get('/scrape-ads', async (req, res) => {
  const { country='US', niche='', min_days_active=30, limit=6 } = req.query;
  if (!niche) return res.status(400).json({ error: 'niche es obligatorio' });
  await handleScrape({ country, niche, min_days_active: parseInt(min_days_active), limit: parseInt(limit) }, res);
});

app.listen(PORT, () => console.log(`Meta Ads Scraper v3.0 en puerto ${PORT}`));
