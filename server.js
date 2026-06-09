const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const path = require('path');
const https = require('https');

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());

const PORT = process.env.PORT || 8080;
const COUNTRY_CODES = { 'USA':'US','UK':'GB','US':'US','GB':'GB','ES':'ES' };

app.get('/', (req, res) => res.json({ status: 'Meta Ads Scraper activo', version: '4.0', endpoints: ['/scrape-ads','/health'] }));
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get('/cazador', (req, res) => res.sendFile(path.join(__dirname, 'cazador.html')));
app.use(express.static(__dirname));

function isEnglish(text) {
  if (!text) return false;
  const spanish = ['hogar','cocina','muebles','desde','para','con','que','una','sus','los','las','del','por','más','tiene','este','esta','nuestro','nuestra','también'];
  return spanish.filter(w => text.toLowerCase().includes(w)).length < 3;
}

// Descarga imagen y la convierte a base64
async function imageToBase64(url) {
  if (!url || !url.startsWith('http')) return null;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 5000);
    const req = https.get(url, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timeout);
        const buf = Buffer.concat(chunks);
        const b64 = buf.toString('base64');
        const type = res.headers['content-type'] || 'image/jpeg';
        resolve({ data: b64, type });
      });
      res.on('error', () => { clearTimeout(timeout); resolve(null); });
    });
    req.on('error', () => { clearTimeout(timeout); resolve(null); });
  });
}

// Claude Vision: identifica producto de copy + imagen
async function identifyProduct(ad) {
  try {
    const messages = [];
    const content = [];

    // Añadir imagen si existe
    if (ad.image_url) {
      const img = await imageToBase64(ad.image_url);
      if (img) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: img.type, data: img.data }
        });
      }
    }

    content.push({
      type: 'text',
      text: `This is a Facebook ad. Ad copy: "${(ad.ad_copy || '').substring(0, 300)}"

Identify the PHYSICAL PRODUCT being sold. Reply ONLY with valid JSON:
{"product":"<product name in English, 2-4 words max>","confidence":<0.0-1.0>}

Rules:
- Product must be a physical item (not a service, app, or brand)
- Use generic name (e.g. "Ice Cream Maker" not "Ninja Creami")
- If no clear physical product, use {"product":"unknown","confidence":0}
- NO explanation, ONLY the JSON`
    });

    messages.push({ role: 'user', content });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 100,
        messages
      })
    });

    const data = await response.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    return parsed;
  } catch(e) {
    return { product: 'unknown', confidence: 0 };
  }
}

async function handleScrape(params, res) {
  const { country = 'US', niche = '', min_days_active = 30, limit = 6 } = params;
  if (!niche) return res.status(400).json({ error: 'niche es obligatorio' });

  const countryCode = COUNTRY_CODES[country.toUpperCase()] || 'US';
  console.log(`[v4] nicho="${niche}" | ${countryCode} | días≥${min_days_active} | límite=${limit}`);

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

    // FASE 1: Scraping de 100 anuncios
    const searchUrl = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${countryCode}&q=${encodeURIComponent(niche)}&search_type=keyword_unordered&media_type=all&sort_data[mode]=total_impressions&sort_data[direction]=desc`;
    console.log('[URL]', searchUrl);

    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 6000));

    // Scroll agresivo para cargar más anuncios
    for (let i = 0; i < 6; i++) {
      await page.evaluate(s => window.scrollTo(0, document.body.scrollHeight * s / 6), i + 1);
      await new Promise(r => setTimeout(r, 1200));
    }

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
        const pageName = pageMatch ? pageMatch[1].trim() : '';

        const sponsoredIdx = block.indexOf('Sponsored\n');
        let adCopy = '';
        if (sponsoredIdx !== -1) {
          const after = block.substring(sponsoredIdx + 10);
          const lines = after.split('\n').filter(l => l.trim().length > 5 && !l.match(/^(http|www|\[)/i));
          adCopy = lines.slice(0, 5).join(' ').trim().substring(0, 400);
        }

        // Imagen: buscar img asociada al ad ID
        const imgEl = document.querySelector(`[id*="${adId}"] img`) ||
                      document.querySelector(`[data-id="${adId}"] img`);
        const imageUrl = imgEl?.src || '';

        if (pageName && adCopy) {
          results.push({ ad_archive_id: adId, page_name: pageName, ad_copy: adCopy, start_date: startDate, image_url: imageUrl });
        }
      });

      return results.slice(0, 100);
    });

    await browser.close();
    browser = null;

    console.log(`[FASE 1] ${rawAds.length} anuncios extraídos`);

    // Filtrar inglés y calcular días activos
    const filtered = rawAds.filter(ad => {
      if (!isEnglish(ad.ad_copy)) return false;
      if (ad.ad_copy.includes('play.google.com') || ad.ad_copy.includes('apps.apple.com')) return false;
      if (ad.page_name.toLowerCase() === 'tiktok' || ad.page_name.toLowerCase() === 'tiktok - us') return false;
      return true;
    }).map(ad => {
      let daysActive = null;
      if (ad.start_date) {
        const d = new Date(ad.start_date);
        if (!isNaN(d.getTime())) daysActive = Math.floor((Date.now() - d.getTime()) / 86400000);
        const dm = ad.start_date.match(/(\d+)\s*day/i);
        const wm = ad.start_date.match(/(\d+)\s*week/i);
        const mm = ad.start_date.match(/(\d+)\s*month/i);
        if (dm) daysActive = parseInt(dm[1]);
        else if (wm) daysActive = parseInt(wm[1]) * 7;
        else if (mm) daysActive = parseInt(mm[1]) * 30;
      }
      if (min_days_active && daysActive !== null && daysActive < min_days_active) return null;
      return { ...ad, days_active: daysActive };
    }).filter(Boolean);

    console.log(`[FILTRO] ${filtered.length} anuncios en inglés y días OK`);

    // FASE 2+3: Claude Vision identifica producto por copy + imagen
    // Procesamos en paralelo en batches de 5 para no saturar la API
    const identified = [];
    const batchSize = 5;
    for (let i = 0; i < Math.min(filtered.length, 60); i += batchSize) {
      const batch = filtered.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(async ad => {
        const id = await identifyProduct(ad);
        return { ...ad, product_name: id.product, confidence: id.confidence };
      }));
      identified.push(...results);
      console.log(`[FASE 2] Procesados ${Math.min(i + batchSize, filtered.length)}/${Math.min(filtered.length, 60)}`);
    }

    // FASE 4: Agrupar por producto (solo si confidence >= 0.5 y no "unknown")
    const groups = {};
    for (const ad of identified) {
      if (!ad.product_name || ad.product_name === 'unknown' || ad.confidence < 0.5) continue;
      const key = ad.product_name.toLowerCase().trim();
      if (!groups[key]) {
        groups[key] = {
          product_name: ad.product_name,
          ads: [],
          advertisers: new Set(),
          total_days: 0,
          days_count: 0,
          best_copy: '',
          best_image: '',
          best_days: 0,
          best_library_url: '',
          best_archive_id: ''
        };
      }
      groups[key].ads.push(ad);
      groups[key].advertisers.add(ad.page_name);
      if (ad.days_active) {
        groups[key].total_days += ad.days_active;
        groups[key].days_count++;
      }
      if ((ad.days_active || 0) > groups[key].best_days) {
        groups[key].best_days = ad.days_active || 0;
        groups[key].best_copy = ad.ad_copy;
        groups[key].best_image = ad.image_url;
        groups[key].best_library_url = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${countryCode}&q=${encodeURIComponent(ad.product_name)}&search_type=keyword_unordered`;
        groups[key].best_archive_id = ad.ad_archive_id;
      }
    }

    // FASE 5: Score y filtro mínimo 3 anunciantes
    const scored = Object.values(groups)
      .filter(g => g.advertisers.size >= 2) // mínimo 2 anunciantes distintos
      .map(g => {
        const avgDays = g.days_count > 0 ? Math.round(g.total_days / g.days_count) : 0;
        const score = (g.advertisers.size * 10) + (g.ads.length * 3) + (avgDays * 0.3);
        return {
          ad_archive_id: g.best_archive_id,
          product_name: g.product_name,
          page_name: g.product_name,
          ad_copy: g.best_copy,
          ad_text: g.best_copy,
          image_url: g.best_image,
          library_url: g.best_library_url,
          days_active: g.best_days,
          avg_days_active: avgDays,
          total_ads: g.ads.length,
          advertiser_count: g.advertisers.size,
          advertisers_list: Array.from(g.advertisers).slice(0, 5),
          score: Math.round(score)
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    console.log(`[RESULTADO] ${scored.length} productos ganadores (de ${rawAds.length} anuncios)`);

    res.json({
      success: true,
      query: { niche, country: countryCode, min_days_active, limit },
      total_found: scored.length,
      ads: scored,
      debug: { raw: rawAds.length, filtered: filtered.length, identified: identified.length }
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

app.listen(PORT, () => console.log(`Meta Ads Scraper v4.0 en puerto ${PORT}`));
