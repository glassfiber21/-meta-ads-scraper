const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const path = require('path');

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());

const PORT = process.env.PORT || 8080;
const COUNTRY_CODES = { 'USA':'US','UK':'GB','US':'US','GB':'GB','ES':'ES' };

// CACHÉ en memoria: ad_id → product_name
const productCache = new Map();

app.get('/', (req, res) => res.json({ status: 'Meta Ads Scraper activo', version: '4.1', endpoints: ['/scrape-ads','/health'], cache_size: productCache.size }));
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get('/cazador', (req, res) => res.sendFile(path.join(__dirname, 'cazador.html')));
app.use(express.static(__dirname));

function isEnglish(text) {
  if (!text) return false;
  const spanish = ['hogar','cocina','muebles','desde','para','con','que','una','sus','los','las','del','por','más','tiene','este','esta','nuestro','nuestra','también'];
  return spanish.filter(w => text.toLowerCase().includes(w)).length < 3;
}

// NORMALIZACIÓN de nombres de producto
function normalizeProduct(name) {
  if (!name || name === 'unknown') return null;
  let n = name.toLowerCase().trim();
  
  // Normalizar variantes comunes
  const aliases = {
    'ice cream machine': 'ice cream maker',
    'ice cream maker machine': 'ice cream maker',
    'mini ice cream maker': 'ice cream maker',
    'portable ice cream maker': 'ice cream maker',
    'diy ice cream maker': 'ice cream maker',
    'air fryer basket': 'air fryer',
    'air fryer accessories': 'air fryer',
    'mini air fryer': 'air fryer',
    'smart air fryer': 'air fryer',
    'kitchen gadget': 'kitchen gadgets',
    'kitchen tool': 'kitchen gadgets',
    'cooking gadget': 'kitchen gadgets',
    'cooking tool': 'kitchen gadgets',
    'food prep tool': 'kitchen gadgets',
    'kitchen accessory': 'kitchen gadgets',
    'galaxy light projector': 'galaxy projector',
    'star projector light': 'galaxy projector',
    'star light projector': 'galaxy projector',
    'led galaxy projector': 'galaxy projector',
    'robot vacuum mop': 'robot vacuum',
    'robot vacuum cleaner': 'robot vacuum',
    'robotic vacuum': 'robot vacuum',
    'portable blender bottle': 'portable blender',
    'mini blender': 'portable blender',
    'travel blender': 'portable blender',
    'snack spinner tray': 'snack spinner',
    'rotating snack tray': 'snack spinner',
    'lazy susan snack': 'snack spinner',
    'electric wine opener': 'wine opener',
    'automatic wine opener': 'wine opener',
    'cordless wine opener': 'wine opener',
  };
  
  // Buscar alias exacto
  if (aliases[n]) return aliases[n];
  
  // Buscar alias parcial
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (n.includes(alias) || alias.includes(n)) return canonical;
  }
  
  // Capitalizar primera letra de cada palabra
  return n.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// CLAUDE: identifica productos de TODOS los anuncios en UNA sola llamada
async function identifyProductsBatch(ads) {
  // Separar los que ya están en caché
  const toProcess = ads.filter(ad => !productCache.has(ad.ad_archive_id));
  const cached = ads.filter(ad => productCache.has(ad.ad_archive_id));
  
  console.log(`[CLAUDE] Caché: ${cached.length} | Nuevos: ${toProcess.length}`);
  
  // Resultados de caché
  const results = {};
  for (const ad of cached) {
    results[ad.ad_archive_id] = productCache.get(ad.ad_archive_id);
  }
  
  if (toProcess.length === 0) return results;
  
  // Un solo prompt con todos los anuncios nuevos
  const adsJson = toProcess.map(ad => ({
    id: ad.ad_archive_id,
    copy: (ad.ad_copy || '').substring(0, 200)
  }));
  
  const prompt = `You are analyzing Facebook ads to identify physical products being sold.

Here are ${adsJson.length} ads in JSON format:
${JSON.stringify(adsJson, null, 2)}

For each ad, identify the physical product being advertised.

Rules:
- Use generic English names (2-4 words max): "Ice Cream Maker", "Air Fryer", "Galaxy Projector"
- If it's a service, app, subscription, or unclear → use "unknown"
- Group similar products under the same name
- Be consistent: always use the same name for the same product type

Reply ONLY with a JSON array, no explanation:
[{"id":"<ad_id>","product":"<product name>","confidence":<0.0-1.0>}]`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    
    if (data.error) {
      console.error('[CLAUDE ERROR]', data.error.message);
      // Fallback: usar copy como nombre de producto
      for (const ad of toProcess) {
        const fallback = (ad.ad_copy || '').split(/[.!?\n]/)[0].trim().substring(0, 50) || 'unknown';
        results[ad.ad_archive_id] = { product: fallback, confidence: 0.3 };
        productCache.set(ad.ad_archive_id, results[ad.ad_archive_id]);
      }
      return results;
    }

    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    for (const item of parsed) {
      const r = { product: item.product || 'unknown', confidence: item.confidence || 0 };
      results[item.id] = r;
      productCache.set(item.id, r); // guardar en caché
    }

    console.log(`[CLAUDE] ${parsed.length} productos identificados`);
  } catch(e) {
    console.error('[CLAUDE PARSE ERROR]', e.message);
    // Fallback
    for (const ad of toProcess) {
      const r = { product: 'unknown', confidence: 0 };
      results[ad.ad_archive_id] = r;
    }
  }

  return results;
}

async function handleScrape(params, res) {
  const { country = 'US', niche = '', min_days_active = 30, limit = 6 } = params;
  if (!niche) return res.status(400).json({ error: 'niche es obligatorio' });

  const countryCode = COUNTRY_CODES[country.toUpperCase()] || 'US';
  console.log(`[v4.1] nicho="${niche}" | ${countryCode} | días≥${min_days_active} | límite=${limit}`);

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

    const searchUrl = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${countryCode}&q=${encodeURIComponent(niche)}&search_type=keyword_unordered&media_type=all&sort_data[mode]=total_impressions&sort_data[direction]=desc`;
    console.log('[URL]', searchUrl);

    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 8000));

    // Scroll para cargar ~100 anuncios
    for (let i = 0; i < 10; i++) {
      await page.evaluate(s => window.scrollTo(0, document.body.scrollHeight * s / 10), i + 1);
      await new Promise(r => setTimeout(r, 1000));
    }

    const rawAds = await page.evaluate(() => {
      const results = [];
      const fullText = document.body.innerText;
      const blocks = fullText.split(/(?=Active\nLibrary ID:)/);

      blocks.forEach((block) => {
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

    console.log(`[SCRAPER] ${rawAds.length} anuncios extraídos`);

    // Filtrar y calcular días activos
    const filtered = rawAds.map(ad => {
      if (!isEnglish(ad.ad_copy)) return null;
      if (ad.ad_copy.includes('play.google.com') || ad.ad_copy.includes('apps.apple.com')) return null;
      if (['tiktok','tiktok - us','facebook','instagram'].includes(ad.page_name.toLowerCase())) return null;

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

    console.log(`[FILTRO] ${filtered.length} anuncios válidos`);

    // CLAUDE: un solo batch para todos
    const productMap = await identifyProductsBatch(filtered);

    // AGRUPACIÓN con normalización
    const groups = {};
    for (const ad of filtered) {
      const raw = productMap[ad.ad_archive_id];
      if (!raw || raw.confidence < 0.5) continue;

      const normalized = normalizeProduct(raw.product);
      if (!normalized) continue;

      const key = normalized.toLowerCase();
      if (!groups[key]) {
        groups[key] = {
          product_name: normalized,
          ads: [],
          advertisers: new Set(),
          total_days: 0,
          days_count: 0,
          best_copy: '',
          best_image: '',
          best_days: 0,
          library_url: ''
        };
      }

      groups[key].ads.push(ad);
      groups[key].advertisers.add(ad.page_name);
      if (ad.days_active) {
        groups[key].total_days += ad.days_active;
        groups[key].days_count++;
      }
      if ((ad.days_active || 0) >= groups[key].best_days) {
        groups[key].best_days = ad.days_active || 0;
        groups[key].best_copy = ad.ad_copy;
        groups[key].best_image = ad.image_url;
        groups[key].library_url = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${countryCode}&q=${encodeURIComponent(normalized)}&search_type=keyword_unordered`;
      }
    }

    // SCORE y ordenar
    const scored = Object.values(groups)
      .map(g => {
        const avgDays = g.days_count > 0 ? Math.round(g.total_days / g.days_count) : 0;
        const score = (g.advertisers.size * 10) + (g.ads.length * 3) + (avgDays * 0.3);
        return {
          product_name: g.product_name,
          page_name: g.product_name,
          ad_copy: g.best_copy,
          ad_text: g.best_copy,
          image_url: g.best_image,
          library_url: g.library_url,
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

    console.log(`[RESULTADO] ${scored.length} productos (${productCache.size} en caché)`);

    res.json({
      success: true,
      query: { niche, country: countryCode, min_days_active, limit },
      total_found: scored.length,
      ads: scored,
      debug: { raw: rawAds.length, filtered: filtered.length, cache_size: productCache.size }
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

app.listen(PORT, () => console.log(`Meta Ads Scraper v4.1 en puerto ${PORT}`));
