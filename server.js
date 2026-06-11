const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const path = require('path');

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());

const PORT = process.env.PORT || 8080;
const TEST_MODE = true; // Cambiar a false para producción

// Job queue para búsquedas asíncronas
const jobs = new Map();
function createJob() {
  const id = Date.now().toString(36) + Math.random().toString(36).substr(2);
  jobs.set(id, { status: 'running', progress: '', result: null, error: null, created: Date.now() });
  return id;
}
function updateJob(id, data) { if (jobs.has(id)) jobs.set(id, { ...jobs.get(id), ...data }); }
// Limpiar jobs viejos cada 30 min
setInterval(() => { const now = Date.now(); jobs.forEach((v,k) => { if (now - v.created > 1800000) jobs.delete(k); }); }, 600000);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const APIFY_API_KEY = process.env.APIFY_API_KEY || '';
const COUNTRY_CODES = { 'USA':'US','UK':'GB','US':'US','GB':'GB','ES':'ES' };

// Caché en memoria
const productCache = new Map();

console.log('APIFY KEY EXISTS:', !!process.env.APIFY_API_KEY);
console.log('APIFY KEY LENGTH:', process.env.APIFY_API_KEY?.length || 0);
console.log('ANTHROPIC KEY EXISTS:', !!process.env.ANTHROPIC_API_KEY);

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

const GENERIC_BLACKLIST = [
  'product', 'products', 'bundle', 'kit', 'tool', 'tools', 'accessory', 'accessories',
  'equipment', 'makeup', 'beauty product', 'hair product', 'home product', 'kitchen gadget',
  'kitchen tool', 'cooking tool', 'beauty', 'skincare product', 'hair care', 'home decor',
  'cleaning product', 'fitness equipment', 'tech gadget', 'electronic', 'electronics',
  'device', 'gadget', 'item', 'thing', 'stuff', 'finds', 'must have', 'viral product'
];

function isGeneric(name) {
  if (!name) return true;
  const n = name.toLowerCase().trim();
  return GENERIC_BLACKLIST.some(b => n === b || n === b + 's');
}

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
  // Normalización agresiva para agrupar variantes del mismo producto
  let norm = n
    .replace(/\bportable\b/g, '').replace(/\bhandheld\b/g, '').replace(/\bmini\b/g, '')
    .replace(/\belectric\b/g, '').replace(/\bwireless\b/g, '').replace(/\bsmart\b/g, '')
    .replace(/\bautomatic\b/g, '').replace(/\bpro\b/g, '').replace(/\bpremium\b/g, '')
    .replace(/\bdigital\b/g, '').replace(/\bcordless\b/g, '').replace(/\bcompact\b/g, '')
    .replace(/s\b/g, '').replace(/\s+/g, ' ').trim();
  if (!norm || norm.length < 3) norm = n;
  return norm.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// FASE 1: Scraping TikTok via Apify
async function scrapeTikTok(hashtags, videosPerHashtag = 50) {
  console.log(`[TIKTOK] Scraping ${hashtags.length} hashtags × ${videosPerHashtag} vídeos`);
  
  const queries = TEST_MODE
    ? ['tiktokmademebuyit', 'amazonfinds', 'amazonmusthaves', 'amazonfavorites', 'viralproducts']
    : ['TIKTOK MADE ME BUY IT', 'AMAZON FINDS', 'HOME MUST HAVES', 'KITCHEN GADGETS', 'LIFE HACK PRODUCTS'];
  const perPage = TEST_MODE ? 20 : 100;

  console.log(`[APIFY] TEST_MODE: ${TEST_MODE} | Queries: ${queries.join(', ')} | PerPage: ${perPage}`);

  const input = {
    searchQueries: queries,
    searchSection: '/video',
    videoSearchDateFilter: 'PAST_MONTH',
    videoSearchSorting: 'MOST_RELEVANT',
    resultsPerPage: perPage,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
    proxyCountryCode: 'US',
    maxRequestRetries: 3
  };

  try {
    // Lanzar run en Apify — input va directo en body, memory como query param
    const runRes = await fetch('https://api.apify.com/v2/acts/clockworks~tiktok-scraper/runs?memory=4096', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${APIFY_API_KEY}`
      },
      body: JSON.stringify(input)
    });
    
    console.log('[APIFY] HTTP Status:', runRes.status);
    
    const runData = await runRes.json();
    console.log('================ APIFY RUN DATA ================');
    console.log(JSON.stringify(runData, null, 2));
    console.log('================================================');
    const runId = runData.data?.id;
    console.log('RUN ID:', runId);
    console.log('DEFAULT DATASET:', runData.data?.defaultDatasetId);
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
    const datasetLimit = TEST_MODE ? 100 : 1000;
    const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?limit=${datasetLimit}`, {
      headers: { 'Authorization': `Bearer ${APIFY_API_KEY}` }
    });
    const items = await itemsRes.json();
    console.log('ITEMS LENGTH:', items.length);
    if (items.length > 0) {
      console.log('FIRST ITEM:');
      console.log(JSON.stringify(items[0], null, 2));
    }
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

    const prompt = `Analyze these TikTok videos and identify the SPECIFIC physical product being shown/sold.

Videos:
${JSON.stringify(adsJson, null, 2)}

Rules:
- Identify ONE specific product per video (e.g. "Portable Mini Fan", "Vegetable Chopper", "Oil Sprayer Bottle")
- Be SPECIFIC: "Portable Mini Fan" not "Fan" or "Electronics"
- Be SPECIFIC: "Vegetable Chopper" not "Kitchen Tool" or "Kitchen Gadget"
- If it's a service, app, tutorial, lifestyle content, music, dance → use "unknown"
- If it's a CATEGORY (makeup, hair care, home decor) not a specific product → use "unknown"
- Focus only on products a dropshipper could sell

For specificityScore:
- 90-100: Very specific single product clearly shown (Portable Mini Fan, Garlic Press, Oil Sprayer)
- 60-89: Specific product but slightly generic name (Hair Dryer, Phone Stand)
- 30-59: Generic category (Kitchen Gadget, Hair Tool, Makeup Product)
- 0-29: Not a product or too vague (Bundle, Kit, Home Product)

Reply ONLY with JSON array, no explanation:
[{"id":"<id>","product":"<product name>","confidence":<0.0-1.0>,"specificityScore":<0-100>}]`;

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
        const r = { 
          product: item.product || 'unknown', 
          confidence: item.confidence || 0,
          specificityScore: item.specificityScore || 0
        };
        results[item.id] = r;
        productCache.set(item.id, r);
      }
      const unknown_count = parsed.filter(p => p.product === 'unknown').length;
    console.log(`[CLAUDE] Batch ${Math.floor(i/batchSize) + 1}: ${parsed.length} identificados | ${unknown_count} unknown | ${parsed.length - unknown_count} productos`);
    } catch(e) {
      console.error('[CLAUDE PARSE ERROR]', e.message);
    }
  }
  return results;
}

// FASE 3: Agrupar y puntuar productos
function groupAndScore(videos, productMap) {
  const groups = {};
  
  console.log('=== PIPELINE TRACE ===');
  console.log('Vídeos recibidos desde Apify:', videos.length);
  const validVideos = videos.filter(v => productMap[v.id] && productMap[v.id].product !== 'unknown' && productMap[v.id].confidence >= 0.6 && (productMap[v.id].specificityScore || 0) >= 70);
  console.log('Vídeos válidos tras filtros:', validVideos.length);
  console.log('Vídeos descartados:', videos.length - validVideos.length);

  for (const video of videos) {
    const raw = productMap[video.id];
    if (!raw) continue;
    if (raw.product === 'unknown') continue;
    if (raw.confidence < 0.6) continue;
    if ((raw.specificityScore || 0) < 70) { console.log('DESCARTADO (genérico):', raw.product, '| specificity:', raw.specificityScore); continue; }
    if (isGeneric(raw.product)) { console.log('DESCARTADO (blacklist):', raw.product); continue; }
    
    const normalized = normalizeProduct(raw.product);
    if (!normalized) continue;
    
    const key = normalized.toLowerCase();
    if (!groups[key]) {
      groups[key] = {
        product_name: normalized,
        videos: [],
        creators: new Set(),
        hashtags_seen: new Set(),
        search_queries_seen: new Set(),
        total_likes: 0,
        total_views: 0,
        total_comments: 0,
        best_cover: '',
        best_video_url: '',
        newest_days: null,
        oldest_days: null
      };
    }
    
    const g = groups[key];
    g.videos.push(video);
    g.creators.add(video.authorMeta?.name || video.author || '');
    if (video.hashtags) video.hashtags.forEach(h => { const tag = typeof h === 'string' ? h : (h?.name || h?.title || String(h)); g.hashtags_seen.add(tag.toLowerCase()); });
    if (video.searchQuery) g.search_queries_seen.add(video.searchQuery.toLowerCase());
    // Track date range
    const createTime = video.createTime || video.createTimeISO;
    if (createTime) {
      const daysAgo = Math.floor((Date.now() - new Date(typeof createTime === 'number' ? createTime * 1000 : createTime).getTime()) / 86400000);
      if (!isNaN(daysAgo)) {
        if (g.newest_days === null || daysAgo < g.newest_days) g.newest_days = daysAgo;
        if (g.oldest_days === null || daysAgo > g.oldest_days) g.oldest_days = daysAgo;
      }
    }
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

  // Log productos detectados por Claude
  console.log('=== PRODUCTOS DETECTADOS POR CLAUDE ===');
  Object.entries(productMap).slice(0, 100).forEach(([id, p]) => {
    if (p.product !== 'unknown') console.log(`${p.product} | ${p.confidence}`);
  });

  // Log resumen final
  const allGroups = Object.values(groups).sort((a,b) => b.videos.length - a.videos.length);
  const totalIdentified = Object.values(productMap).filter(p => p.product !== 'unknown').length;
  console.log('=== RESUMEN ===');
  console.log(`Vídeos analizados: ${videos.length}`);
  console.log(`Productos identificados por Claude: ${totalIdentified}`);
  console.log(`Productos agrupados: ${allGroups.length}`);
  console.log('=== TOP 10 PRODUCTOS ===');
  allGroups.slice(0, 10).forEach(g => {
    const queries = Array.from(g.search_queries_seen).join(', ');
    const hashtags = Array.from(g.hashtags_seen).slice(0, 3).join(', ');
    console.log(`${g.product_name} | ${g.videos.length} vídeos | ${g.creators.size} creadores | queries: ${queries} | hashtags: ${hashtags}`);
  });
  // Distribución
  const dist = {1:0, 2:0, 3:0, 5:0, 10:0};
  allGroups.forEach(g => {
    if (g.videos.length >= 10) dist[10]++;
    else if (g.videos.length >= 5) dist[5]++;
    else if (g.videos.length >= 3) dist[3]++;
    else if (g.videos.length >= 2) dist[2]++;
    else dist[1]++;
  });
  console.log(`DISTRIBUCIÓN → 1v: ${dist[1]} | 2v: ${dist[2]} | 3v: ${dist[3]} | 5v+: ${dist[5]} | 10v+: ${dist[10]}`);

  // Score basado en replicación (creadores únicos tiene máximo peso)
  return Object.values(groups)
    .filter(g => {
      const v = g.videos.length;
      const c = g.creators.size;
      if (v < 3 || c < 2) {
        console.log(`FILTRADO: ${g.product_name} → ${v}v / ${c}c (insuficiente)`);
        return false;
      }
      return true;
    }) // mínimo 2 vídeos y 2 creadores
    .map(g => {
      const maxViews = 1000000;
      const maxLikes = 100000;
      const maxComments = 10000;
      // Freshness score: qué tan reciente es la conversación
      const newestDays = g.newest_days || 999;
      const oldestDays = g.oldest_days || 0;
      const freshnessScore = newestDays <= 7 ? 100 :
                             newestDays <= 14 ? 80 :
                             newestDays <= 30 ? 60 :
                             newestDays <= 60 ? 40 : 20;

      // Penalización temporal: si el vídeo más antiguo es muy viejo, no es tendencia
      const agePenalty = oldestDays > 180 ? 0.5 :
                         oldestDays > 90  ? 0.75 : 1.0;

      // Replication score: creadores únicos tiene máximo peso
      const creator_score  = Math.round(g.creators.size / 10 * 100);
      const video_score    = Math.round(g.videos.length / 20 * 100);
      const views_score    = Math.round(Math.min(g.total_views, maxViews) / maxViews * 100);
      const likes_score    = Math.round(Math.min(g.total_likes, maxLikes) / maxLikes * 100);

      const base_score = Math.round(
        (creator_score  * 0.40) +
        (video_score    * 0.25) +
        (freshnessScore * 0.20) +
        (views_score    * 0.10) +
        (likes_score    * 0.05)
      );
      const score = Math.round(base_score * agePenalty);

      const score_breakdown = {
        creator_score, video_score, freshness_score: freshnessScore,
        views_score, likes_score, age_penalty: agePenalty, final_score: score
      };
      console.log(`SCORE ${g.product_name}: creators=${creator_score} videos=${video_score} fresh=${freshnessScore} age_penalty=${agePenalty} → ${score}`);
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
        search_queries: Array.from(g.search_queries_seen),
        hashtag_count: g.hashtags_seen.size,
        query_count: g.search_queries_seen.size,
        newest_days: g.newest_days,
        oldest_days: g.oldest_days,
        // Campos para compatibilidad con cazador.html
        page_name: g.product_name,
        ad_copy: `${g.videos.length} vídeos virales · ${g.total_views.toLocaleString()} views · ${g.creators.size} creadores`,
        video_count_display: g.videos.length,
        creator_count_display: g.creators.size,
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

// ENDPOINT PRINCIPAL: lanza job asíncrono y devuelve job_id inmediatamente
app.get('/tiktok-products', async (req, res) => {
  const { niche = 'general', limit = 10 } = req.query;
  const hashtags = HASHTAGS[niche] || HASHTAGS['general'];
  const selectedHashtags = hashtags.slice(0, 5);
  
  const jobId = createJob();
  console.log(`[JOB ${jobId}] Iniciado | Nicho: ${niche}`);
  
  // Responder inmediatamente con job_id
  res.json({ success: true, job_id: jobId, status: 'running', message: 'Búsqueda iniciada' });
  
  // Procesar en background
  (async () => {
    try {
      updateJob(jobId, { progress: 'Conectando con TikTok...' });
      const videos = await scrapeTikTok(selectedHashtags, 100);
      if (!videos.length) { updateJob(jobId, { status: 'done', result: { success: false, error: 'No se obtuvieron vídeos', ads: [] } }); return; }
      
      console.log(`[JOB ${jobId}] Vídeos TikTok: ${videos.length}`);
      updateJob(jobId, { progress: `${videos.length} vídeos obtenidos. Analizando con IA...` });
      
      const productMap = await identifyProductsBatch(videos);
      const identified = Object.keys(productMap).length;
      console.log(`[JOB ${jobId}] Productos Claude: ${identified}`);
      updateJob(jobId, { progress: `${identified} productos identificados. Agrupando...` });
      
      const products = groupAndScore(videos, productMap);
      console.log(`[JOB ${jobId}] Productos agrupados: ${products.length}`);
      
      console.log('PRODUCTS LENGTH:', products.length);
      if (products.length > 0) console.log('FIRST PRODUCT:', JSON.stringify(products[0], null, 2));

      const result = {
        success: true, source: 'tiktok', niche,
        total_videos: videos.length,
        total_products: products.length,
        ads: products.slice(0, parseInt(limit)),
        debug: { identified, cache_size: productCache.size }
      };
      updateJob(jobId, { status: 'done', result, progress: `Completado: ${products.length} productos` });
      console.log(`[JOB ${jobId}] DONE | ${products.length} productos de ${videos.length} vídeos`);
    } catch(e) {
      console.error(`[JOB ${jobId}] ERROR:`, e.message);
      updateJob(jobId, { status: 'error', error: e.message, result: { success: false, error: e.message, ads: [] } });
    }
  })();
});

// Consultar estado de un job
app.get('/job-status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job no encontrado' });
  if (job.status === 'done' || job.status === 'error') {
    return res.json({ status: job.status, progress: job.progress, result: job.result });
  }
  res.json({ status: 'running', progress: job.progress });
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
