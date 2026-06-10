const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const path = require('path');

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());

const PORT = process.env.PORT || 8080;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const APIFY_API_KEY = process.env.APIFY_API_KEY || '';
const COUNTRY_CODES = { 'USA':'US','UK':'GB','US':'US','GB':'GB','ES':'ES' };

// Caché en memoria
const productCache = new Map();

app.get('/', (req, res) => res.json({ 
  status: 'Cazador de Productos activo', 
  version: '5.0',
  pipeline: 'TikTok → Claude → Meta Ads',
  endpoints: ['/scrape-ads', '/tiktok-products', '/health']
}));
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get('/cazador', (req, res) => res.sendFile(path.join(__dirname, 'cazador.html')));
app.use(express.static(__dirname));

// Hashtags por nicho
const HASHTAGS = {
  'hogar': ['tiktokmademebuyit','amazonfinds','kitchengadgets','homefinds','homeessentials','kitchenhacks','cookinggadgets','homeorganization','homeupgrades','kitchenmusthaves'],
  'mascotas': ['petproducts','petgadgets','dogproducts','dogmusthaves','catproducts','petfinds','petaccessories','dogsoftiktok','catsoftiktok'],
  'fitness': ['fitnesstok','gymtok','workoutgadgets','homegym','fitnessproducts','gymmusthaves'],
  'belleza': ['beautytok','skincareproducts','beautyfinds','skincareroutine','makeupfinds'],
  'gadgets': ['coolgadgets','techgadgets','gadgetsoftiktok','amazontech','usefulproducts'],
  'jardin': ['gardenfinds','gardentools','outdoorproducts','backyardideas','poolproducts'],
  'general': ['tiktokmademebuyit','amazonfinds','viralproducts','musthaves','bestfinds','productfinds']
};

function normalizeProduct(name) {
  if (!name || name === 'unknown') return null;
  let n = name.toLowerCase().trim();
  const aliases = {
    'ice cream machine': 'Ice Cream Maker',
    'ice cream maker machine': 'Ice Cream Maker',
    'mini ice cream maker': 'Ice Cream Maker',
    'portable ice cream maker': 'Ice Cream Maker',
    'air fryer basket': 'Air Fryer',
    'air fryer accessories': 'Air Fryer',
    'mini air fryer': 'Air Fryer',
    'kitchen gadget': 'Kitchen Gadgets',
    'kitchen tool': 'Kitchen Gadgets',
    'cooking gadget': 'Kitchen Gadgets',
    'galaxy light projector': 'Galaxy Projector',
    'star projector light': 'Galaxy Projector',
    'robot vacuum cleaner': 'Robot Vacuum',
    'robotic vacuum': 'Robot Vacuum',
    'portable blender bottle': 'Portable Blender',
    'mini blender': 'Portable Blender',
    'snack spinner tray': 'Snack Spinner',
    'rotating snack tray': 'Snack Spinner',
    'electric wine opener': 'Wine Opener',
    'automatic wine opener': 'Wine Opener',
    'pet hair remover': 'Pet Hair Remover',
    'dog hair remover': 'Pet Hair Remover',
    'cat hair remover': 'Pet Hair Remover',
  };
  if (aliases[n]) return aliases[n];
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (n.includes(alias) || alias.includes(n)) return canonical;
  }
  return name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

// FASE 1: Scraping TikTok via Apify
async function scrapeTikTok(hashtags, videosPerHashtag = 50) {
  console.log(`[TIKTOK] Scraping ${hashtags.length} hashtags × ${videosPerHashtag} vídeos`);
  
  const input = {
    hashtags: hashtags,
    resultsPerPage: videosPerHashtag,
    maxProfilesPerQuery: 1,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
    proxyCountryCode: 'US',
    searchSection: 'video',
    maxRequestRetries: 3
  };

  try {
    // Lanzar run en Apify
    const runRes = await fetch('https://api.apify.com/v2/acts/clockworks~tiktok-scraper/runs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${APIFY_API_KEY}`
      },
      body: JSON.stringify({ input, memory: 4096 })
    });
    
    const runData = await runRes.json();
    const runId = runData.data?.id;
    if (!runId) throw new Error('No se pudo iniciar el run de Apify');
    
    console.log(`[APIFY] Run iniciado: ${runId}`);
    
    // Esperar a que termine (máx 5 min)
    let status = 'RUNNING';
    let attempts = 0;
    while (status === 'RUNNING' && attempts < 60) {
      await new Promise(r => setTimeout(r, 5000));
      const statusRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, {
        headers: { 'Authorization': `Bearer ${APIFY_API_KEY}` }
      });
      const statusData = await statusRes.json();
      status = statusData.data?.status;
      attempts++;
      console.log(`[APIFY] Estado: ${status} (${attempts * 5}s)`);
    }
    
    if (status !== 'SUCCEEDED') throw new Error(`Run Apify terminó con estado: ${status}`);
    
    // Obtener resultados
    const datasetId = runData.data?.defaultDatasetId;
    const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?limit=1000`, {
      headers: { 'Authorization': `Bearer ${APIFY_API_KEY}` }
    });
    const items = await itemsRes.json();
    console.log(`[APIFY] ${items.length} vídeos obtenidos`);
    return items;
    
  } catch(e) {
    console.error('[APIFY ERROR]', e.message);
    return [];
  }
}

// FASE 2: Claude identifica productos en batch
async function identifyProductsBatch(videos) {
  const toProcess = videos.filter(v => !productCache.has(v.id));
  const cached = videos.filter(v => productCache.has(v.id));
  
  console.log(`[CLAUDE] Caché: ${cached.length} | Nuevos: ${toProcess.length}`);
  
  const results = {};
  for (const v of cached) results[v.id] = productCache.get(v.id);
  if (toProcess.length === 0) return results;

  // Procesar en batches de 50
  const batchSize = 50;
  for (let i = 0; i < toProcess.length; i += batchSize) {
    const batch = toProcess.slice(i, i + batchSize);
    
    const adsJson = batch.map(v => ({
      id: v.id,
      text: ((v.text || v.description || '') + ' ' + (v.hashtags?.join(' ') || '')).substring(0, 300)
    }));

    const prompt = `Analyze these TikTok videos and identify the physical product being shown/sold in each one.

Videos:
${JSON.stringify(adsJson, null, 2)}

Rules:
- Use generic English names (2-5 words): "Ice Cream Maker", "Air Fryer", "Pet Hair Remover"
- If it's a service, app, personal content, music, dance, meme → use "unknown"
- Be consistent: same product type = same name
- Focus on PHYSICAL PRODUCTS only

Reply ONLY with JSON array, no explanation:
[{"id":"<id>","product":"<product name>","confidence":<0.0-1.0>}]`;

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 2000,
          messages: [{ role: 'user', content: prompt }]
        })
      });

      const data = await response.json();
      if (data.error) { console.error('[CLAUDE ERROR]', data.error.message); continue; }

      const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      const clean = text.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(clean);

      for (const item of parsed) {
        const r = { product: item.product || 'unknown', confidence: item.confidence || 0 };
        results[item.id] = r;
        productCache.set(item.id, r);
      }
      console.log(`[CLAUDE] Batch ${i/batchSize + 1}: ${parsed.length} productos identificados`);
    } catch(e) {
      console.error('[CLAUDE PARSE ERROR]', e.message);
    }
  }
  return results;
}

// FASE 3: Agrupar y puntuar productos
function groupAndScore(videos, productMap) {
  const groups = {};
  
  for (const video of videos) {
    const raw = productMap[video.id];
    if (!raw || raw.confidence < 0.6 || raw.product === 'unknown') continue;
    
    const normalized = normalizeProduct(raw.product);
    if (!normalized) continue;
    
    const key = normalized.toLowerCase();
    if (!groups[key]) {
      groups[key] = {
        product_name: normalized,
        videos: [],
        creators: new Set(),
        hashtags_seen: new Set(),
        total_likes: 0,
        total_views: 0,
        total_comments: 0,
        best_cover: '',
        best_video_url: ''
      };
    }
    
    const g = groups[key];
    g.videos.push(video);
    g.creators.add(video.authorMeta?.name || video.author || '');
    if (video.hashtags) video.hashtags.forEach(h => g.hashtags_seen.add(h.toLowerCase()));
    g.total_likes += parseInt(video.diggCount || video.likes || 0);
    g.total_views += parseInt(video.playCount || video.views || 0);
    g.total_comments += parseInt(video.commentCount || video.comments || 0);
    if (!g.best_cover && (video.covers?.default || video.coverUrl || video.cover)) {
      g.best_cover = video.covers?.default || video.coverUrl || video.cover || '';
    }
    if (!g.best_video_url && video.webVideoUrl) {
      g.best_video_url = video.webVideoUrl;
    }
  }

  // Score = apariciones×40% + vistas×30% + likes×20% + comentarios×10%
  return Object.values(groups)
    .filter(g => g.videos.length >= 2) // mínimo 2 vídeos
    .map(g => {
      const maxViews = 1000000;
      const maxLikes = 100000;
      const maxComments = 10000;
      const score = Math.round(
        (g.videos.length / 20 * 100 * 0.4) +
        (Math.min(g.total_views, maxViews) / maxViews * 100 * 0.3) +
        (Math.min(g.total_likes, maxLikes) / maxLikes * 100 * 0.2) +
        (Math.min(g.total_comments, maxComments) / maxComments * 100 * 0.1)
      );
      return {
        product_name: g.product_name,
        tiktok_score: score,
        video_count: g.videos.length,
        creator_count: g.creators.size,
        hashtag_count: g.hashtags_seen.size,
        total_likes: g.total_likes,
        total_views: g.total_views,
        total_comments: g.total_comments,
        cover_url: g.best_cover,
        tiktok_search_url: `https://www.tiktok.com/search?q=${encodeURIComponent(g.product_name)}`,
        // Campos para compatibilidad con cazador.html
        page_name: g.product_name,
        ad_copy: `${g.video_count} vídeos virales · ${g.total_views.toLocaleString()} views · ${g.creators.size} creadores`,
        image_url: g.best_cover,
        days_active: null,
        total_ads: g.video_count,
        advertiser_count: g.creator_count,
        advertisers_list: Array.from(g.creators).slice(0, 3),
        library_url: `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US&q=${encodeURIComponent(g.product_name)}&search_type=keyword_unordered`,
        score
      };
    })
    .sort((a, b) => b.score - a.score);
}

// ENDPOINT PRINCIPAL: TikTok → Claude → Top productos
app.get('/tiktok-products', async (req, res) => {
  const { niche = 'general', limit = 10 } = req.query;
  const hashtags = HASHTAGS[niche] || HASHTAGS['general'];
  const selectedHashtags = hashtags.slice(0, 5); // 5 hashtags × 50 vídeos = 250 vídeos
  
  console.log(`[PIPELINE] Nicho: ${niche} | Hashtags: ${selectedHashtags.join(', ')}`);
  
  try {
    // Fase 1: TikTok
    const videos = await scrapeTikTok(selectedHashtags, 50);
    if (!videos.length) return res.json({ success: false, error: 'No se obtuvieron vídeos de TikTok', ads: [] });
    
    // Fase 2: Claude
    const productMap = await identifyProductsBatch(videos);
    
    // Fase 3: Agrupar y puntuar
    const products = groupAndScore(videos, productMap);
    
    console.log(`[RESULTADO] ${products.length} productos detectados de ${videos.length} vídeos`);
    
    res.json({
      success: true,
      source: 'tiktok',
      niche,
      total_videos: videos.length,
      total_products: products.length,
      ads: products.slice(0, parseInt(limit)),
      debug: { hashtags: selectedHashtags, cache_size: productCache.size }
    });
    
  } catch(e) {
    console.error('[PIPELINE ERROR]', e.message);
    res.status(500).json({ success: false, error: e.message, ads: [] });
  }
});

// ENDPOINT META ADS (mantener el anterior)
async function handleMetaScrape(params, res) {
  const { country = 'US', niche = '', min_days_active = 30, limit = 6 } = params;
  if (!niche) return res.status(400).json({ error: 'niche es obligatorio' });

  const countryCode = COUNTRY_CODES[country.toUpperCase()] || 'US';
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
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 8000));

    let previousCount = 0, sameCount = 0;
    while (sameCount < 5) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await new Promise(r => setTimeout(r, 4000));
      const count = await page.evaluate(() => (document.body.innerText.match(/Library ID:/g) || []).length);
      console.log(`[META SCROLL] Anuncios: ${count}`);
      if (count === previousCount) sameCount++;
      else sameCount = 0;
      previousCount = count;
      if (count >= 100) break;
    }

    const rawAds = await page.evaluate(() => {
      const results = [];
      const fullText = document.body.innerText;
      const blocks = fullText.split(/(?=Active\nLibrary ID:)/);
      blocks.forEach((block) => {
        if (!block.includes('Library ID:')) return;
        const idMatch = block.match(/Library ID:\s*(\d+)/);
        if (!idMatch) return;
        const dateMatch = block.match(/Started running on\s+([^\n]+)/);
        const pageMatch = block.match(/See ad details\n([^\n]+)/);
        const sponsoredIdx = block.indexOf('Sponsored\n');
        let adCopy = '';
        if (sponsoredIdx !== -1) {
          const after = block.substring(sponsoredIdx + 10);
          const lines = after.split('\n').filter(l => l.trim().length > 5 && !l.match(/^(http|www|\[)/i));
          adCopy = lines.slice(0, 5).join(' ').trim().substring(0, 400);
        }
        const imgEl = document.querySelector(`[id*="${idMatch[1]}"] img`);
        if (pageMatch && adCopy) {
          results.push({
            ad_archive_id: idMatch[1],
            page_name: pageMatch[1].trim().substring(0, 80),
            ad_copy: adCopy,
            start_date: dateMatch ? dateMatch[1].trim() : '',
            image_url: imgEl?.src || '',
            library_url: `https://www.facebook.com/ads/library/?id=${idMatch[1]}`
          });
        }
      });
      return results.slice(0, 100);
    });

    await browser.close();
    browser = null;

    const isEnglish = text => {
      const spanish = ['hogar','cocina','desde','para','con','que','una','los','las','del','por','más'];
      return spanish.filter(w => (text||'').toLowerCase().includes(w)).length < 3;
    };

    const filtered = rawAds.filter(ad => {
      if (!isEnglish(ad.ad_copy)) return false;
      if (ad.ad_copy.includes('play.google.com')) return false;
      if (['tiktok','tiktok - us'].includes(ad.page_name.toLowerCase())) return false;
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

    const productMap = await identifyProductsBatch(filtered);
    const groups = {};
    for (const ad of filtered) {
      const raw = productMap[ad.ad_archive_id];
      if (!raw || raw.confidence < 0.5 || raw.product === 'unknown') continue;
      const normalized = normalizeProduct(raw.product);
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      if (!groups[key]) {
        groups[key] = { product_name: normalized, ads: [], advertisers: new Set(), total_days: 0, days_count: 0, best_copy: '', best_image: '', best_days: 0, library_url: '' };
      }
      const g = groups[key];
      g.ads.push(ad);
      g.advertisers.add(ad.page_name);
      if (ad.days_active) { g.total_days += ad.days_active; g.days_count++; }
      if ((ad.days_active || 0) >= g.best_days) {
        g.best_days = ad.days_active || 0;
        g.best_copy = ad.ad_copy;
        g.best_image = ad.image_url;
        g.library_url = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${countryCode}&q=${encodeURIComponent(normalized)}&search_type=keyword_unordered`;
      }
    }

    const scored = Object.values(groups).map(g => {
      const avgDays = g.days_count > 0 ? Math.round(g.total_days / g.days_count) : 0;
      return {
        product_name: g.product_name, page_name: g.product_name,
        ad_copy: g.best_copy, ad_text: g.best_copy,
        image_url: g.best_image, library_url: g.library_url,
        days_active: g.best_days, avg_days_active: avgDays,
        total_ads: g.ads.length, advertiser_count: g.advertisers.size,
        advertisers_list: Array.from(g.advertisers).slice(0, 5),
        score: (g.advertisers.size * 10) + (g.ads.length * 3) + (avgDays * 0.3)
      };
    }).sort((a, b) => b.score - a.score).slice(0, limit);

    res.json({ success: true, source: 'meta', query: { niche, country: countryCode }, total_found: scored.length, ads: scored, debug: { raw: rawAds.length, filtered: filtered.length } });

  } catch(e) {
    if (browser) { try { await browser.close(); } catch(e) {} }
    res.status(500).json({ success: false, error: e.message });
  }
}

app.post('/scrape-ads', async (req, res) => {
  if (!req.body.niche) return res.status(400).json({ error: 'niche es obligatorio' });
  await handleMetaScrape({ ...req.body, min_days_active: parseInt(req.body.min_days_active)||30, limit: parseInt(req.body.limit)||6 }, res);
});

app.get('/scrape-ads', async (req, res) => {
  const { country='US', niche='', min_days_active=30, limit=6 } = req.query;
  if (!niche) return res.status(400).json({ error: 'niche es obligatorio' });
  await handleMetaScrape({ country, niche, min_days_active: parseInt(min_days_active), limit: parseInt(limit) }, res);
});

app.listen(PORT, () => console.log(`Cazador de Productos v5.0 en puerto ${PORT}`));
