const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const path = require('path');

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(express.json({ limit: '50mb' }));

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

// Caché en memoria — se limpia automáticamente cada hora
const productCache = new Map();
setInterval(() => { productCache.clear(); console.log('[CACHE] Limpiada automáticamente'); }, 3600000);

console.log('APIFY KEY EXISTS:', !!process.env.APIFY_API_KEY);
console.log('APIFY KEY LENGTH:', process.env.APIFY_API_KEY?.length || 0);
console.log('ANTHROPIC KEY EXISTS:', !!process.env.ANTHROPIC_API_KEY);

app.get('/', (req, res) => res.json({ 
  status: 'Cazador de Productos activo', 
  version: '5.0',
  pipeline: 'TikTok → Claude → Meta Ads',
  endpoints: ['/scrape-ads', '/tiktok-products', '/health']
}));
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString(), cache_size: productCache.size }));
app.get('/clear-cache', (req, res) => { const size = productCache.size; productCache.clear(); res.json({ cleared: size }); });
app.get('/cazador', (req, res) => res.sendFile(path.join(__dirname, 'cazador.html')));
app.use(express.static(__dirname));

// ─────────────────────────────────────────────────────────────────────────────
// ESTRATEGIA DE BÚSQUEDA — MUY IMPORTANTE
//
// OBJETIVO: descubrir qué productos DESCONOCIDOS están siendo comprados ahora.
//
// MAL ENFOQUE (antes): queries de haul → 'amazonfinds', 'amazonmusthaves'
//   → cada vídeo muestra 5-10 productos distintos → 90 grupos de 1 vídeo → todo filtrado
//
// BUEN ENFOQUE (ahora): hashtags de categoría donde cada vídeo = 1 producto
//   'kitchengadgets', 'tiktokmademebuyit', 'homehacks'
//   → cada vídeo muestra UN solo producto → repetición natural → grupos de 10-30 vídeos
//
// PRINCIPIO: buscar por CATEGORÍA (qué tipo de producto), no por CANAL (Amazon, haul...)
// ─────────────────────────────────────────────────────────────────────────────
const SEARCH_QUERIES = {
  // Cada query es un hashtag donde los vídeos muestran UN solo producto físico
  'cocina':       ['kitchengadgets', 'kitchenhack', 'kitchentool', 'cookinggadgets', 'mealprep'],
  'hogar':        ['homehacks', 'homeupgrade', 'homegadgets', 'smarthome', 'roomtransformation'],
  'limpieza':     ['cleaninghacks', 'cleantok', 'deepcleaning', 'cleanwithme', 'cleaninggadgets'],
  'organizacion': ['organizationhacks', 'homeorganization', 'declutter', 'storagehacks', 'drawerorganization'],
  'mascotas':     ['petproducts', 'petgadgets', 'dogproducts', 'dogtok', 'cattok'],
  'jardin':       ['gardentools', 'gardeningtips', 'backyardideas', 'outdoorgadgets', 'poolhacks'],
  'bano':         ['bathroomgadgets', 'bathroomorganization', 'showerhacks', 'bathroomupgrade', 'bathroomdecor'],
  'verano':       ['summergadgets', 'summerhacks', 'coolproducts', 'beachgadgets', 'poolmusthave'],
  'viaje':        ['travelgadgets', 'travelhacks', 'travelmusthave', 'travelproducts', 'packinghacks'],
  // GENERAL: los mejores hashtags de descubrimiento — un vídeo = un producto
  'general':      ['tiktokmademebuyit', 'viralproducts', 'lifehacks', 'gadgets', 'coolgadgets']
};

const GENERIC_BLACKLIST = [
  // Genéricos absolutos
  'product', 'products', 'bundle', 'kit', 'tool', 'tools', 'accessory', 'accessories',
  'equipment', 'device', 'gadget', 'gadgets', 'item', 'thing', 'stuff', 'finds',
  'must have', 'viral product', 'viral products',
  // Categorías de cocina demasiado amplias
  'kitchen gadget', 'kitchen gadgets', 'kitchen tool', 'kitchen tools', 'cooking tool',
  'cooking gadget', 'cooking gadgets', 'kitchen item', 'kitchen items',
  // Categorías de belleza/moda
  'makeup', 'beauty product', 'beauty products', 'hair product', 'hair products',
  'skincare product', 'hair care', 'beauty',
  // Categorías de hogar demasiado amplias
  'home product', 'home products', 'home decor', 'home gadget', 'home gadgets',
  'cleaning product', 'cleaning products', 'cleaning tool',
  // Categorías de fitness/tech
  'fitness equipment', 'tech gadget', 'tech gadgets', 'electronic', 'electronics',
  // Términos de slicer/cutter genéricos — solos sin modificador específico
  'vegetable slicer', 'vegetable cutter', 'vegetable peeler', 'vegetable chopper',
  'food slicer', 'food cutter', 'food chopper', 'salad cutter',
  // Otros de una sola palabra que son categoría
  'organizer', 'storage', 'cleaner', 'spray', 'brush',
  'toy', 'toys', 'pet toy', 'dog toy', 'cat toy',
];

// Sufijos que solos (con 1 adjetivo genérico) forman un nombre de categoría, no de producto
// Ej: "Vegetable Slicer" → 2 palabras, última = 'slicer' → genérico
// Ej: "5-in-1 Mandoline Slicer" → 3+ palabras → específico → NO bloqueado
const GENERIC_SUFFIXES = ['slicer','cutter','chopper','peeler','grater','organizer','cleaner','gadget','tool','toy','spray'];

function isGeneric(name) {
  if (!name) return true;
  const n = name.toLowerCase().trim();
  // Coincidencia exacta con blacklist
  if (GENERIC_BLACKLIST.some(b => n === b || n === b + 's')) return true;
  // Nombre de exactamente 2 palabras donde la última es un sufijo genérico
  // Ej: "Vegetable Slicer" → bloqueado. "Mandoline Slicer" → bloqueado.
  // Ej: "Garlic Mincer" → 'mincer' no está en GENERIC_SUFFIXES → pasa
  const words = n.split(/\s+/).filter(w => w.length > 1);
  if (words.length === 2 && GENERIC_SUFFIXES.includes(words[1])) return true;
  return false;
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
    // Steamer variants
    'portable handheld steamer': 'Handheld Steamer',
    'handheld steamer iron': 'Handheld Steamer',
    'travel steamer': 'Handheld Steamer',
    'garment steamer': 'Handheld Steamer',
    'clothes steamer': 'Handheld Steamer',
    'fabric steamer': 'Handheld Steamer',
    // Fan variants
    'portable mini fan': 'Portable Fan',
    'handheld fan': 'Portable Fan',
    'personal fan': 'Portable Fan',
    'desk fan': 'Portable Fan',
    'clip on fan': 'Portable Fan',
    // Chopper/slicer variants
    'vegetable cutter': 'Vegetable Chopper',
    'food chopper': 'Vegetable Chopper',
    'manual food chopper': 'Vegetable Chopper',
    'veggie chopper': 'Vegetable Chopper',
    'onion chopper': 'Vegetable Chopper',
    // Blender variants
    'bullet blender': 'Portable Blender',
    'personal blender': 'Portable Blender',
    'smoothie blender': 'Portable Blender',
    // Storage variants
    'storage container': 'Storage Containers',
    'food storage container': 'Storage Containers',
    'airtight container': 'Storage Containers',
    'meal prep container': 'Storage Containers',
    // Cleaner variants
    'steam cleaner': 'Steam Cleaner',
    'portable steam cleaner': 'Steam Cleaner',
    'handheld steam cleaner': 'Steam Cleaner',
    'electric steam cleaner': 'Steam Cleaner',
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
  
  // TEST_MODE: los 2 mejores hashtags de descubrimiento de producto único
  // 'tiktokmademebuyit' y 'kitchengadgets' → vídeos de 1 producto → grupos naturales de 10-30
  const queries = TEST_MODE ? ['tiktokmademebuyit', 'kitchengadgets'] : hashtags;
  const perPage = videosPerHashtag; // controlado por el llamador

  console.log(`[APIFY] Queries: ${queries.join(', ')} | PerPage: ${perPage}`);

  const input = {
    searchQueries: queries,
    searchSection: '/video',
    videoSearchDateFilter: 'PAST_MONTH',
    videoSearchSorting: 'MOST_LIKED', // Opciones: MOST_RELEVANT | MOST_LIKED | MOST_VIEWED — MOST_LIKED prioriza viralidad
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
    // Log por hashtag
    const byQuery = {};
    items.forEach(v => {
      const q = v.searchQuery || 'unknown';
      byQuery[q] = (byQuery[q] || 0) + 1;
    });
    console.log('=== VÍDEOS POR HASHTAG ===');
    Object.entries(byQuery).forEach(([q, n]) => console.log(`  ${q} → ${n} vídeos`));
    console.log(`  TOTAL: ${items.length} vídeos`);
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

    const prompt = `Analyze these TikTok videos to find VIRAL PHYSICAL PRODUCTS being sold/promoted.

Videos:
${JSON.stringify(adsJson, null, 2)}

CRITICAL RULES:
1. Each video must show ONE single specific product. If the video is a HAUL (shows many products), use "unknown"
2. Be VERY SPECIFIC: "Kitchen Exhaust Fan" not "Fan", "Vegetable Chopper" not "Kitchen Tool"
3. Use "unknown" for: hauls, collections, lifestyle, fashion, food, services, apps, tutorials, dances
4. Use "unknown" for: vague descriptions like "Amazon finds", "must haves", "essentials", "gadgets assortment"
5. Only return a product name if the ENTIRE video is about that ONE product

HAUL DETECTION — use "unknown" if text contains: haul, finds, favorites, must haves, essentials, restock, roundup, unboxing of multiple items

specificityScore:
- 90-100: Single specific product, entire video dedicated to it (Kitchen Exhaust Fan, Garlic Press, Oil Sprayer)
- 60-89: Specific product but video may show variants (Portable Fan, Drawer Organizer)
- 30-59: Too generic or vague (Kitchen Gadget, Cool Product)
- 0-29: Haul / multiple products / non-product content → use "unknown"

Reply ONLY with a JSON array, no explanation, no markdown:
[{"id":"<id>","product":"<product name or unknown>","confidence":<0.0-1.0>,"specificityScore":<0-100>}]`;

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
      let clean = text.replace(/```json|```/g, '').trim();
      // Extraer solo el array JSON aunque haya texto extra
      const arrayMatch = clean.match(/\[[\s\S]*\]/);
      if (!arrayMatch) { console.error('[CLAUDE] No se encontró array JSON en respuesta:', clean.substring(0,200)); continue; }
      clean = arrayMatch[0];
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
  const validVideos = videos.filter(v => productMap[v.id] && productMap[v.id].product !== 'unknown' && productMap[v.id].confidence >= 0.6 && (productMap[v.id].specificityScore || 0) >= 60);
  console.log('Vídeos válidos tras filtros:', validVideos.length);
  console.log('Vídeos descartados:', videos.length - validVideos.length);

  for (const video of videos) {
    const raw = productMap[video.id];
    if (!raw) continue;
    if (raw.product === 'unknown') continue;
    if (raw.confidence < 0.6) continue;
    if ((raw.specificityScore || 0) < 60) { console.log('DESCARTADO (genérico):', raw.product, '| specificity:', raw.specificityScore); continue; }
    if (isGeneric(raw.product)) { console.log('DESCARTADO (blacklist):', raw.product); continue; }
    
    const normalized = normalizeProduct(raw.product);
    if (!normalized) continue;
    
    const key = normalized.toLowerCase();
    if (!groups[key]) {
      groups[key] = {
        product_name: normalized,
        all_videos: [],      // todos los vídeos (incluyendo no virales)
        viral_videos: [],    // solo vídeos con likes>=500 OR views>=10k
        creators: new Set(), // creadores únicos de vídeos VIRALES
        hashtags_seen: new Set(),
        search_queries_seen: new Set(),
        total_likes: 0,      // suma solo de vídeos virales
        total_views: 0,      // suma solo de vídeos virales
        total_comments: 0,
        best_cover: '',
        best_video_url: '',
        best_video_urls: [],
        best_video_likes: 0,
        newest_days: null,
        oldest_days: null
      };
    }
    
    const videoLikes = parseInt(video.diggCount || video.likes || 0);
    const videoViews = parseInt(video.playCount || video.views || 0);
    const isViral = videoLikes >= 500 || videoViews >= 10000;
    
    const g = groups[key];
    g.all_videos.push(video); // todos los vídeos del producto
    
    if (isViral) {
      g.viral_videos.push(video);
      // Solo los creadores de vídeos virales cuentan como "creadores reales"
      g.creators.add(video.authorMeta?.name || video.author || '');
    }
    
    if (video.hashtags) video.hashtags.forEach(h => { const tag = typeof h === 'string' ? h : (h?.name || h?.title || String(h)); g.hashtags_seen.add(tag.toLowerCase()); });
    if (video.searchQuery) g.search_queries_seen.add(video.searchQuery.toLowerCase());
    
    // Fechas: basadas en vídeos virales (más fiables)
    const createTime = video.createTime || video.createTimeISO;
    if (createTime && isViral) {
      const daysAgo = Math.floor((Date.now() - new Date(typeof createTime === 'number' ? createTime * 1000 : createTime).getTime()) / 86400000);
      if (!isNaN(daysAgo)) {
        if (g.newest_days === null || daysAgo < g.newest_days) g.newest_days = daysAgo;
        if (g.oldest_days === null || daysAgo > g.oldest_days) g.oldest_days = daysAgo;
      }
    }
    
    // Métricas: acumular solo vídeos virales para que el total refleje calidad real
    if (isViral) {
      g.total_likes += videoLikes;
      g.total_views += videoViews;
      g.total_comments += parseInt(video.commentCount || video.comments || 0);
    }
    
    // Cover: preferir el vídeo viral con más likes
    if (isViral && videoLikes > (g.best_video_likes || 0)) {
      g.best_video_likes = videoLikes;
      g.best_cover = video.covers?.default || video.coverUrl || video.cover || g.best_cover || '';
      g.best_video_url = video.webVideoUrl || g.best_video_url || '';
      g.best_video_urls = (g.best_video_urls || []);
      if (video.webVideoUrl) g.best_video_urls.push(video.webVideoUrl);
    }
  }

  // Log productos detectados por Claude
  console.log('=== PRODUCTOS DETECTADOS POR CLAUDE ===');
  Object.entries(productMap).slice(0, 100).forEach(([id, p]) => {
    if (p.product !== 'unknown') console.log(`${p.product} | ${p.confidence}`);
  });

  // Log detallado de todos los grupos ANTES del filtro
  const allGroupsPreFilter = Object.values(groups).sort((a,b) => b.viral_videos.length - a.viral_videos.length);
  console.log('=== GRUPOS PRE-FILTRO (vídeos virales × creadores únicos) ===');
  allGroupsPreFilter.forEach(g => {
    const vv = g.viral_videos.length;
    const av = g.all_videos.length;
    const c = g.creators.size;
    const pass = vv >= 2 && c >= 2;
    const reason = vv < 2 ? `solo ${vv} virales (min 2)` : c < 2 ? `solo ${c} creadores (min 2)` : 'OK';
    console.log(`${pass ? '✓' : '✗'} ${g.product_name} | ${vv}vv/${av}vt | ${c}c | ${g.total_likes}L ${g.total_views}V | newest=${g.newest_days}d oldest=${g.oldest_days}d | ${reason}`);
  });

  // Log resumen final
  const allGroups = Object.values(groups).sort((a,b) => b.viral_videos.length - a.viral_videos.length);
  const totalIdentified = Object.values(productMap).filter(p => p.product !== 'unknown').length;
  console.log('=== RESUMEN ===');
  console.log(`Vídeos analizados: ${videos.length}`);
  console.log(`Productos identificados por Claude: ${totalIdentified}`);
  console.log(`Grupos formados: ${allGroups.length}`);
  console.log('=== TOP 10 PRODUCTOS (por vídeos virales) ===');
  allGroups.slice(0, 10).forEach(g => {
    console.log(`${g.product_name} | ${g.viral_videos.length}vv/${g.all_videos.length}vt | ${g.creators.size}c | ${g.total_likes}L ${g.total_views}V`);
  });
  const dist = {1:0, 2:0, 3:0, 5:0, 10:0};
  allGroups.forEach(g => {
    const v = g.viral_videos.length;
    if (v >= 10) dist[10]++; else if (v >= 5) dist[5]++; else if (v >= 3) dist[3]++; else if (v >= 2) dist[2]++; else dist[1]++;
  });
  console.log(`DISTRIBUCIÓN VIRALES → 1v: ${dist[1]} | 2v: ${dist[2]} | 3v: ${dist[3]} | 5v+: ${dist[5]} | 10v+: ${dist[10]}`);

  // Score basado en replicación VIRAL (creadores únicos con vídeos virales)
  return Object.values(groups)
    .filter(g => {
      const vv = g.viral_videos.length;
      const c = g.creators.size;
      if (vv < 2 || c < 2) {
        console.log(`FILTRADO: ${g.product_name} → ${vv}vv / ${c}c (insuficiente)`);
        return false;
      }
      return true;
    })
    .map(g => {
      const maxViews = 1000000;
      const maxLikes = 100000;
      const newestDays = g.newest_days || 999;
      const oldestDays = g.oldest_days || 0;
      const freshnessScore = newestDays <= 7 ? 100 :
                             newestDays <= 14 ? 80 :
                             newestDays <= 30 ? 60 :
                             newestDays <= 60 ? 40 : 20;
      const agePenalty = oldestDays > 180 ? 0.5 :
                         oldestDays > 90  ? 0.75 : 1.0;

      // Score basado en vídeos VIRALES únicamente
      const creator_score = Math.round(g.creators.size / 10 * 100);
      const video_score   = Math.round(g.viral_videos.length / 20 * 100);
      const views_score   = Math.round(Math.min(g.total_views, maxViews) / maxViews * 100);
      const likes_score   = Math.round(Math.min(g.total_likes, maxLikes) / maxLikes * 100);

      const base_score = Math.round(
        (creator_score  * 0.40) +
        (video_score    * 0.25) +
        (freshnessScore * 0.20) +
        (views_score    * 0.10) +
        (likes_score    * 0.05)
      );
      const score = Math.round(base_score * agePenalty);

      console.log(`SCORE ${g.product_name}: ${g.viral_videos.length}vv ${g.creators.size}c creators=${creator_score} fresh=${freshnessScore} → ${score}`);

      return {
        product_name: g.product_name,
        tiktok_score: score,
        video_count: g.viral_videos.length,        // solo virales
        video_count_total: g.all_videos.length,    // total incluyendo ruido
        creator_count: g.creators.size,
        hashtag_count: g.hashtags_seen.size,
        total_likes: g.total_likes,
        total_views: g.total_views,
        total_comments: g.total_comments,
        cover_url: g.best_cover,
        viral_video_urls: (g.best_video_urls || []).slice(0, 5),
        tiktok_search_url: `https://www.tiktok.com/search?q=${encodeURIComponent(g.product_name)}`,
        search_queries: Array.from(g.search_queries_seen),
        query_count: g.search_queries_seen.size,
        newest_days: g.newest_days,
        oldest_days: g.oldest_days,
        // Compatibilidad con cazador.html
        page_name: g.product_name,
        ad_copy: `${g.viral_videos.length} vídeos virales · ${g.total_views.toLocaleString()} views · ${g.creators.size} creadores`,
        video_count_display: g.viral_videos.length,
        creator_count_display: g.creators.size,
        image_url: g.best_cover,
        days_active: null,
        total_ads: g.viral_videos.length,
        advertiser_count: g.creators.size,
        advertisers_list: Array.from(g.creators).slice(0, 3),
        library_url: `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US&q=${encodeURIComponent(g.product_name)}&search_type=keyword_unordered`,
        score
      };
    })
    .sort((a, b) => b.score - a.score);
}

// ─────────────────────────────────────────────────────────────────────────────
// groupAndScoreV2 — Pipeline de 2 fases
// Devuelve { confirmed, signals }
//   confirmed: productos con 2+ vídeos virales de 2+ creadores (listos para mostrar)
//   signals:   productos con 1 vídeo viral de >100k views (candidatos para Fase 2)
// ─────────────────────────────────────────────────────────────────────────────
function groupAndScoreV2(videos, productMap) {
  // Reutilizar la lógica de agrupación existente
  const allProducts = groupAndScore(videos, productMap);

  // También construir grupos completos para detectar señales únicas
  // (groupAndScore ya filtra los que no llegan a 2vv/2c — necesitamos los de 1vv)
  const groups = {};
  for (const video of videos) {
    const raw = productMap[video.id];
    if (!raw || raw.product === 'unknown' || raw.confidence < 0.6) continue;
    if ((raw.specificityScore || 0) < 60) continue;
    if (isGeneric(raw.product)) continue;
    const normalized = normalizeProduct(raw.product);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (!groups[key]) groups[key] = { product_name: normalized, viral_videos: [], creators: new Set(), total_views: 0, total_likes: 0, newest_days: null };
    const likes = parseInt(video.diggCount || 0);
    const views = parseInt(video.playCount || 0);
    const isViral = likes >= 500 || views >= 10000;
    if (isViral) {
      groups[key].viral_videos.push(video);
      groups[key].creators.add(video.authorMeta?.name || video.author || '');
      groups[key].total_views += views;
      groups[key].total_likes += likes;
      const createTime = video.createTime || video.createTimeISO;
      if (createTime) {
        const daysAgo = Math.floor((Date.now() - new Date(typeof createTime === 'number' ? createTime * 1000 : createTime).getTime()) / 86400000);
        if (!isNaN(daysAgo) && (groups[key].newest_days === null || daysAgo < groups[key].newest_days)) groups[key].newest_days = daysAgo;
      }
    }
  }

  // Separar: señales únicas = exactamente 1 vídeo viral con >100k views
  const SIGNAL_MIN_VIEWS = 100000;
  const signals = [];
  for (const g of Object.values(groups)) {
    const vv = g.viral_videos.length;
    const c = g.creators.size;
    // Solo los que NO pasaron el filtro de confirmed (1 vídeo viral O 1 creador)
    // Y que tengan views suficientes para ser una señal real
    if (vv === 1 && c === 1 && g.total_views >= SIGNAL_MIN_VIEWS) {
      const newestDays = g.newest_days || 999;
      const freshnessScore = newestDays <= 7 ? 100 : newestDays <= 14 ? 80 : newestDays <= 30 ? 60 : 40;
      const views_score = Math.round(Math.min(g.total_views, 2000000) / 2000000 * 100);
      const score = Math.round((views_score * 0.6) + (freshnessScore * 0.4));
      signals.push({
        product_name: g.product_name,
        tiktok_score: score,
        score,
        video_count: 1,
        creator_count: 1,
        total_views: g.total_views,
        total_likes: g.total_likes,
        newest_days: g.newest_days,
        label: 'Señal única',
        signal_tier: g.total_views >= 1000000 ? 'mega' : g.total_views >= 500000 ? 'alta' : 'media',
        // Compatibilidad con cazador.html
        page_name: g.product_name,
        ad_copy: `1 vídeo viral · ${g.total_views.toLocaleString()} views · pendiente validación`,
        video_count_display: 1,
        creator_count_display: 1,
        image_url: '',
        days_active: null,
        total_ads: 1,
        advertiser_count: 1,
        advertisers_list: Array.from(g.creators).slice(0, 3),
        library_url: `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US&q=${encodeURIComponent(g.product_name)}&search_type=keyword_unordered`,
        tiktok_search_url: `https://www.tiktok.com/search?q=${encodeURIComponent(g.product_name)}`
      });
    }
  }

  // Ordenar señales por views descendente (las más virales primero para validar)
  signals.sort((a, b) => b.total_views - a.total_views);

  console.log(`[FASE1] Confirmados directos: ${allProducts.length} | Señales únicas (>100k views): ${signals.length}`);
  if (signals.length > 0) {
    console.log('[FASE1] Top señales:');
    signals.slice(0, 8).forEach(s => console.log(`  ${s.product_name}: ${s.total_views.toLocaleString()} views [${s.signal_tier}]`));
  }

  return { confirmed: allProducts, signals };
}


// ENDPOINT PRINCIPAL: lanza job asíncrono y devuelve job_id inmediatamente
app.get('/tiktok-products', async (req, res) => {
  const { niche = 'general', limit = 10 } = req.query;
  // Normalizar el nicho al key del mapa
  const nicheMap = {
    'kitchen gadgets': 'cocina', 'hogar & cocina': 'cocina', 'hogar': 'hogar',
    'cocina': 'cocina', 'limpieza': 'limpieza', 'organizacion': 'organizacion',
    'mascotas': 'mascotas', 'jardin': 'jardin', 'bano': 'bano',
    'verano': 'verano', 'viaje': 'viaje', 'general': 'general',
    'pets': 'mascotas', 'garden': 'jardin', 'cleaning': 'limpieza'
  };
  const nicheKey = nicheMap[niche.toLowerCase()] || niche.toLowerCase();
  const hashtags = SEARCH_QUERIES[nicheKey] || SEARCH_QUERIES['general'];
  console.log(`[NICHE] "${niche}" → key="${nicheKey}" → queries: ${hashtags.join(', ')}`);
  const selectedHashtags = hashtags; // ya son exactamente 5 por nicho
  
  const jobId = createJob();
  const videosPerHashtag = TEST_MODE ? 50 : 100; // TEST_MODE: 2 queries × 50 = 100 vídeos enfocados
  console.log(`[JOB ${jobId}] Iniciado | Nicho: ${niche} | TEST_MODE: ${TEST_MODE} | ${selectedHashtags.length} hashtags × ${videosPerHashtag} vídeos = ${selectedHashtags.length * videosPerHashtag} vídeos máx`);
  
  // Responder inmediatamente con job_id
  res.json({ success: true, job_id: jobId, status: 'running', message: 'Búsqueda iniciada' });
  
  // ─── PIPELINE DE 2 FASES ────────────────────────────────────────────────────
  // FASE 1: 100 vídeos genéricos → detectar productos → separar en dos cubos:
  //   A) Replicados: 2+ vídeos virales de 2+ creadores distintos → mostrar directamente
  //   B) Señales únicas: 1 vídeo viral con >100k views → validar con Fase 2
  // FASE 2 (solo para señales únicas): buscar el producto por nombre (20 vídeos)
  //   → Si aparecen 2+ vídeos virales nuevos → promover a tarjeta confirmada
  //   → Si no → descartar
  // ─────────────────────────────────────────────────────────────────────────────
  (async () => {
    try {
      // ── FASE 1 ──────────────────────────────────────────────────────────────
      updateJob(jobId, { progress: 'Fase 1: Escaneando tendencias TikTok...' });
      const videos = await scrapeTikTok(selectedHashtags, videosPerHashtag);
      if (!videos.length) { updateJob(jobId, { status: 'done', result: { success: false, error: 'No se obtuvieron vídeos', ads: [] } }); return; }

      console.log(`[JOB ${jobId}] Vídeos TikTok: ${videos.length}`);
      updateJob(jobId, { progress: `${videos.length} vídeos obtenidos. Identificando productos...` });

      const productMap = await identifyProductsBatch(videos);
      console.log(`[JOB ${jobId}] Productos Claude: ${Object.keys(productMap).length}`);
      updateJob(jobId, { progress: 'Agrupando y filtrando...' });

      // groupAndScore devuelve dos arrays: replicados + señales únicas
      const { confirmed, signals } = groupAndScoreV2(videos, productMap);
      console.log(`[JOB ${jobId}] Confirmados (2+vv 2+c): ${confirmed.length} | Señales únicas (>100k views): ${signals.length}`);

      // ── FASE 2: validar señales únicas ──────────────────────────────────────
      const validated = [];
      if (signals.length > 0) {
        updateJob(jobId, { progress: `Fase 2: Validando ${signals.length} señales únicas...` });
        console.log(`[FASE2] Validando ${signals.length} señales: ${signals.map(s => s.product_name).join(', ')}`);

        for (const signal of signals.slice(0, 5)) { // máx 5 validaciones para controlar coste
          console.log(`[FASE2] Buscando: "${signal.product_name}" (${signal.total_views.toLocaleString()} views)`);
          try {
            // Buscar 20 vídeos específicos del producto por nombre
            const validationVideos = await scrapeTikTok([signal.product_name], 20);
            if (!validationVideos.length) { console.log(`[FASE2] Sin resultados para: ${signal.product_name}`); continue; }

            const validationMap = await identifyProductsBatch(validationVideos);
            // Contar cuántos de los vídeos nuevos confirman el mismo producto
            const confirming = validationVideos.filter(v => {
              const p = validationMap[v.id];
              if (!p || p.product === 'unknown') return false;
              const norm = normalizeProduct(p.product);
              const signalNorm = signal.product_name.toLowerCase();
              return norm && (norm.toLowerCase().includes(signalNorm.split(' ')[0]) || signalNorm.includes(norm.toLowerCase().split(' ')[0]));
            });
            const viralConfirming = confirming.filter(v => (v.diggCount || 0) >= 500 || (v.playCount || 0) >= 10000);
            const newCreators = new Set(confirming.map(v => v.authorMeta?.name || v.author || '')).size;

            console.log(`[FASE2] "${signal.product_name}": ${viralConfirming.length} vídeos virales confirmados de ${newCreators} creadores`);

            if (viralConfirming.length >= 2 && newCreators >= 2) {
              // Promover: añadir señal + vídeos de validación al confirmed
              const promoted = {
                ...signal,
                validation_source: 'fase2',
                phase2_viral_count: viralConfirming.length,
                phase2_creator_count: newCreators,
                // Actualizar métricas combinando Fase1 + Fase2
                video_count: signal.video_count + viralConfirming.length,
                creator_count: signal.creator_count + newCreators,
                ad_copy: `${signal.video_count + viralConfirming.length} vídeos virales · ${signal.total_views.toLocaleString()} views · ${signal.creator_count + newCreators} creadores`,
                video_count_display: signal.video_count + viralConfirming.length,
                creator_count_display: signal.creator_count + newCreators,
                label: 'Validado'
              };
              validated.push(promoted);
              console.log(`[FASE2] ✓ PROMOVIDO: ${signal.product_name}`);
            } else {
              console.log(`[FASE2] ✗ DESCARTADO: ${signal.product_name} (insuficientes confirmaciones)`);
            }
          } catch (e) {
            console.error(`[FASE2] Error validando ${signal.product_name}:`, e.message);
          }
        }
      }

      // Combinar: confirmados directos + validados en fase 2
      const allProducts = [
        ...confirmed.map(p => ({ ...p, label: p.label || 'Trending' })),
        ...validated
      ].sort((a, b) => b.score - a.score).slice(0, parseInt(limit));

      console.log(`[JOB ${jobId}] Productos finales: ${allProducts.length} (${confirmed.length} directos + ${validated.length} validados)`);

      // Stats pipeline
      const stats_unknown = Object.values(productMap).filter(p => p.product === 'unknown').length;
      const stats_valid = Object.values(productMap).filter(p => p.product !== 'unknown' && (p.specificityScore||0) >= 60).length;
      console.log('=== STATS PIPELINE ===');
      console.log(`Vídeos obtenidos: ${videos.length}`);
      console.log(`Productos Claude: ${Object.keys(productMap).length} | unknown: ${stats_unknown} | válidos: ${stats_valid}`);
      console.log(`Señales únicas encontradas: ${signals.length} | Validadas en Fase 2: ${validated.length}`);
      console.log(`[JOB ${jobId}] DONE | ${allProducts.length} productos de ${videos.length} vídeos`);

      updateJob(jobId, {
        status: 'done',
        result: {
          success: true,
          ads: allProducts,
          total_products: allProducts.length,
          pipeline_stats: {
            videos_scraped: videos.length,
            confirmed_direct: confirmed.length,
            signals_found: signals.length,
            signals_validated: validated.length
          }
        }
      });
    } catch (e) {
      console.error(`[JOB ${jobId}] ERROR:`, e.message);
      updateJob(jobId, { status: 'error', error: e.message, result: { success: false, error: e.message, ads: [] } });
    }
  })();
});

// Consultar estado de un job
// ── Endpoint: analizar JSON ya descargados (sin gastar Apify) ────────────────
// Recibe un array de vídeos de TikTok (formato Apify) ya descargados
// y ejecuta todo el pipeline: Claude → filtro dropshipping → Fase 2
// USO TEMPORAL para reutilizar runs ya pagados
app.post('/analyze-cached', async (req, res) => {
  const { videos: rawVideos = [], niche = 'general', limit = 10 } = req.body;
  if (!rawVideos.length) return res.json({ success: false, error: 'No se recibieron vídeos' });

  const jobId = createJob();
  console.log(`[CACHED] Job ${jobId} | ${rawVideos.length} vídeos recibidos | niche: ${niche}`);
  res.json({ success: true, job_id: jobId, message: `Analizando ${rawVideos.length} vídeos cacheados...` });

  (async () => {
    try {
      // Deduplicar por ID
      const seen = new Set();
      const videos = rawVideos.filter(v => {
        const id = String(v.id || v.videoId || Math.random());
        if (seen.has(id)) return false;
        seen.add(id);
        v.id = id; // asegurar campo id consistente
        return true;
      });
      console.log(`[CACHED] Vídeos únicos tras dedup: ${videos.length}`);

      updateJob(jobId, { progress: `${videos.length} vídeos cargados. Identificando productos con IA...` });

      // PASO 1: Claude identifica productos
      const productMap = await identifyProductsBatch(videos);
      const identified = Object.values(productMap).filter(p => p.product !== 'unknown').length;
      console.log(`[CACHED] Productos identificados: ${identified}`);
      updateJob(jobId, { progress: `${identified} productos identificados. Agrupando...` });

      // PASO 2: Agrupar y separar confirmados vs señales
      const { confirmed, signals } = groupAndScoreV2(videos, productMap);
      console.log(`[CACHED] Confirmados: ${confirmed.length} | Señales únicas: ${signals.length}`);

      // PASO 3: Filtro dropshipping sobre las señales
      const validated = [];
      let signalsForFase2 = [];
      let pendingSignals = [];

      if (signals.length > 0) {
        updateJob(jobId, { progress: `Evaluando ${signals.length} señales para dropshipping...` });

        const signalList = signals.map(s => ({
          name: s.product_name, views: s.total_views, likes: s.total_likes,
          days_ago: s.newest_days, tier: s.tier
        }));

        const dropshipPrompt = `You are a dropshipping expert evaluating products for the European market (Spain, France, Germany, Italy).
A seller in Europe wants to find products that are viral in the USA and replicate them in Europe 2-4 weeks later.

Evaluate each product for dropshipping viability:

Products to evaluate:
${JSON.stringify(signalList, null, 2)}

HIGH SCORE (70-100): Kitchen gadgets, home organization, cleaning tools, garden tools, pet accessories, bathroom gadgets, travel accessories. No dominant brand, sourced from China/AliExpress, price €15-€80, demonstrable in video.
LOW SCORE (0-40): Branded products (Ninja, Apple, etc.), fashion/clothing, food/supplements, services/apps, very cheap (<€5) or very expensive (>€150).
MEDIUM (40-70): Works but has complications (fragile, bulky, highly seasonal).

Reply ONLY with JSON array:
[{"name":"<product name>","dropship_score":<0-100>,"reason":"<1 sentence>","viable":true|false}]`;

        let dropshipScores = {};
        try {
          const dsRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1500,
              messages: [{ role: 'user', content: dropshipPrompt }] })
          });
          const dsData = await dsRes.json();
          const dsText = (dsData.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
          const dsMatch = dsText.replace(/```json|```/g,'').trim().match(/\[[\s\S]*\]/);
          if (dsMatch) {
            JSON.parse(dsMatch[0]).forEach(r => { dropshipScores[r.name.toLowerCase()] = r; });
            console.log('[CACHED] Dropship scores:');
            Object.values(dropshipScores).sort((a,b)=>b.dropship_score-a.dropship_score).forEach(r =>
              console.log(`  ${r.dropship_score>=70?'✓':r.dropship_score>=40?'~':'✗'} ${r.name}: ${r.dropship_score}/100 — ${r.reason}`)
            );
          }
        } catch(e) { console.error('[CACHED] Dropship eval error:', e.message); }

        const enriched = signals.map(s => {
          const ds = dropshipScores[s.product_name.toLowerCase()] || {};
          return { ...s, dropship_score: ds.dropship_score||50, dropship_reason: ds.reason||'',
            dropship_viable: ds.viable!==false,
            combined_score: Math.round((s.score*0.4)+((ds.dropship_score||50)*0.6)) };
        });

        const viable = enriched.filter(s=>s.dropship_score>=50).sort((a,b)=>b.combined_score-a.combined_score);
        const discarded = enriched.filter(s=>s.dropship_score<50);
        console.log(`[CACHED] Viables: ${viable.length} | Descartados por dropshipping: ${discarded.length}`);

        const FASE2_MAX = 10;
        signalsForFase2 = viable.slice(0, FASE2_MAX);
        pendingSignals = viable.slice(FASE2_MAX).map(s=>({...s,label:'Pendiente',pending:true}));

        // PASO 4: Fase 2 — validar cada señal con 20 vídeos frescos de Apify
        if (signalsForFase2.length > 0) {
          updateJob(jobId, { progress: `Fase 2: Validando ${signalsForFase2.length} productos en TikTok...` });
          for (const signal of signalsForFase2) {
            console.log(`[CACHED F2] Buscando: "${signal.product_name}" (dropship:${signal.dropship_score} views:${signal.total_views.toLocaleString()})`);
            updateJob(jobId, { progress: `Validando: ${signal.product_name}...` });
            try {
              const vv = await scrapeTikTok([signal.product_name], 20);
              if (!vv.length) continue;
              const vm = await identifyProductsBatch(vv);
              const confirming = vv.filter(v => {
                const p = vm[v.id]; if (!p||p.product==='unknown') return false;
                const norm = normalizeProduct(p.product);
                const sn = signal.product_name.toLowerCase();
                return norm&&(norm.toLowerCase().includes(sn.split(' ')[0])||sn.includes(norm.toLowerCase().split(' ')[0]));
              });
              const viral = confirming.filter(v=>(v.diggCount||0)>=500||(v.playCount||0)>=10000);
              const creators = new Set(confirming.map(v=>v.authorMeta?.name||v.author||'')).size;
              console.log(`[CACHED F2] "${signal.product_name}": ${viral.length}vv ${creators}c`);
              if (viral.length>=2&&creators>=2) {
                validated.push({ ...signal, label:'Validado', phase2_viral:viral.length, phase2_creators:creators,
                  video_count:signal.video_count+viral.length, creator_count:signal.creator_count+creators,
                  score:signal.combined_score+10, tiktok_score:signal.combined_score+10,
                  ad_copy:`${signal.video_count+viral.length} vídeos virales · ${signal.total_views.toLocaleString()} views · ${signal.creator_count+creators} creadores`,
                  dropship_insight:signal.dropship_reason });
                console.log(`[CACHED F2] ✓ PROMOVIDO: ${signal.product_name}`);
              }
            } catch(e) { console.error(`[CACHED F2] Error ${signal.product_name}:`, e.message); }
          }
        }
      }

      const allProducts = [
        ...confirmed.map(p=>({...p,label:p.label||'Trending'})),
        ...validated
      ].sort((a,b)=>b.score-a.score).slice(0,parseInt(limit));

      console.log(`[CACHED] DONE | ${allProducts.length} productos finales`);
      updateJob(jobId, {
        status: 'done',
        result: {
          success: true, ads: allProducts, total_products: allProducts.length,
          pipeline_stats: { videos_scraped: videos.length, confirmed_direct: confirmed.length,
            signals_found: signals.length, signals_dropship_viable: signalsForFase2.length+pendingSignals.length,
            signals_validated: validated.length, signals_pending_count: pendingSignals.length },
          pending_signals: pendingSignals.map(s=>({ product_name:s.product_name, total_views:s.total_views,
            total_likes:s.total_likes, tier:s.tier, score:s.combined_score||s.score,
            dropship_score:s.dropship_score, dropship_reason:s.dropship_reason,
            newest_days:s.newest_days, tiktok_search_url:s.tiktok_search_url, label:'Pendiente' }))
        }
      });
    } catch(e) {
      console.error('[CACHED] ERROR:', e.message);
      updateJob(jobId, { status:'error', error:e.message, result:{ success:false, error:e.message, ads:[] } });
    }
  })();
});


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
