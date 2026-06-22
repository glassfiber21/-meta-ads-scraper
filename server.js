// ─────────────────────────────────────────────────────────────────────────────
// CAZADOR v9.0 — Run definitivo
// Cambios v9.0:
//  1. 20 hashtags optimizados por datos reales del run v8.6
//  2. Eliminados: #kitchenhacks (0% ratio, vídeos 4 años), #officegadgets (0.1M avg),
//     #storageideas, #homefinds, #cookinggadgets, #petfinds
//  3. Añadidos: #amazonfinds, #tiktokmademebuyit, #gadgetreview, #cleaninghacks, #homeorganization
//  4. 400 vídeos totales (20 hashtags × 20 vídeos)
//  5. Fase 2B: sube de 10 a 40 validaciones por run
//  6. Prompt v9.0: anti-falsos positivos + diccionario de sinónimos
//     (fusiona FlyClense duplicado, closet tours descartados, etc.)
//  7. Umbrales Fase 2B: min 2 creadores / 2 vídeos (más permisivo, más tarjetas)
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const path = require('path');
const app = express();
app.use(require('cors')({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const APIFY_API_KEY = process.env.APIFY_API_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

// ── Configuración ─────────────────────────────────────────────────────────────
// 24 evergreen + 6 estacionales = 30 hashtags × 10 vídeos = 300 vídeos
// Seleccionados por rendimiento real — hashtags de categoría específica > genéricos

function getQuarterHashtags() {
  const month = new Date().getMonth() + 1;
  const Q1 = ['#organizationproducts','#fitnessgadgets','#homegym','#coldweathergear','#weightloss','#newyearproducts'];
  const Q2 = ['#gardentools','#outdoorgadgets','#petfinds','#travelessentials','#springcleaning','#campinggear'];
  const Q3 = ['#summergadgets','#poolproducts','#beachgear','#coolingproducts','#babyoutdoor','#watergadgets'];
  const Q4 = ['#giftideas','#christmasgifts','#stockingstuffers','#blackfridayfinds','#cozyhome','#holidaygadgets'];
  if (month <= 3) return { quarter: 'Q1', hashtags: Q1 };
  if (month <= 6) return { quarter: 'Q2', hashtags: Q2 };
  if (month <= 9) return { quarter: 'Q3', hashtags: Q3 };
  return           { quarter: 'Q4', hashtags: Q4 };
}

const EVERGREEN_HASHTAGS = [
  '#tiktokmademebuyit', '#viralproducts', '#coolgadgets', '#productreview',
  '#petproducts', '#petgadgets', '#dogproducts', '#dogtok', '#petmom',
  '#babygadgets', '#momhacks',
  '#homefinds', '#homeessentials', '#cleaningproducts', '#cleaninghacks', '#organizationhacks',
  '#kitchengadgets', '#kitchenhacks',
  '#gadgets', '#techgadgets', '#gadgetreview',
  '#beautygadgets', '#skincaregadgets', '#wellnessproducts',
];

const { quarter: QUARTER, hashtags: SEASONAL_HASHTAGS } = getQuarterHashtags();
console.log(`[CAZADOR] Trimestre: ${QUARTER} | Hashtags estacionales: ${SEASONAL_HASHTAGS.length}`);

const QUERIES_CONFIG = [
  ...EVERGREEN_HASHTAGS.map(h => ({ query: h, videos: 10, tipo: 'evergreen' })),
  ...SEASONAL_HASHTAGS.map(h => ({ query: h, videos: 10, tipo: 'estacional' })),
];

console.log(`[CAZADOR] Total hashtags: ${QUERIES_CONFIG.length} (24 evergreen + 6 ${QUARTER}) | Total vídeos: ${QUERIES_CONFIG.reduce((s, q) => s + q.videos, 0)}`);

const FILTROS = {
  min_views: 50000,
  min_likes: 1000,
  min_fans: 1000,
  // exclude_ads eliminado del actor — filtramos nosotros (cambio 1)
};

// Keywords que indican que un vídeo lleva a un producto en venta
// Si un vídeo tiene isAd=true PERO tiene estas keywords → CONSERVAR (es dropshipper)
// Si un vídeo tiene isAd=true SIN estas keywords → DESCARTAR (es TikTok Ads Manager puro)
const AD_SALE_KEYWORDS = [
  'link in bio', 'link 🔗 in', 'link in my bio', 'link en bio',
  'link in profile', 'link in our bio', 'link on bio', 'check bio',
  'see bio', 'bio link',
  'shop now', 'shop here', 'available now', 'available at',
  'get it now', 'get yours', 'order now', 'buy now',
  'myshopify.com', '.myshopify', 'shopify',
  'use code', 'discount code', 'promo code',
  'amazon.com', 'amzn.to', 'amazon find',
  'tiktok shop', 'tiktokshop', '#tiktokshop',
];

// Umbrales Fase 2
const FASE2_VIDEOS_POR_PRODUCTO = 10;  // coste controlado
const FASE2_MIN_VIDEOS = 2;            // mínimo vídeos virales para aprobar
const FASE2_MIN_CREATORS = 2;          // mínimo creadores distintos para aprobar
const FASE2_MAX_VALIDACIONES = 100;    // valida TODAS las señales sin límite artificial
const FASE2_PENALIZE_DAYS = 180;       // penalizar si oldest_days > 180

// ── Job queue ─────────────────────────────────────────────────────────────────
const jobs = {};
// Cache de vídeos validados por producto (para página /producto/:slug)
const productCache = {};

function createJob() {
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  jobs[id] = { status: 'running', progress: 'Iniciando...', result: null };
  return id;
}
function updateJob(id, data) { if (jobs[id]) Object.assign(jobs[id], data); }

// ── Scraping Apify ────────────────────────────────────────────────────────────
async function scrapeHashtag(hashtag, n) {
  const slug = hashtag.replace('#', '').toLowerCase();
  console.log(`[SCRAPE] #${slug} × ${n} vídeos`);

  const input = {
    hashtags: [slug],
    resultsPerPage: n,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
    proxyCountryCode: 'US',
    // SIN excludeAds — filtramos nosotros con lógica propia (cambio 1)
  };

  const runRes = await fetch('https://api.apify.com/v2/acts/clockworks~tiktok-scraper/runs?memory=4096', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${APIFY_API_KEY}` },
    body: JSON.stringify(input)
  });

  if (runRes.status !== 200 && runRes.status !== 201) {
    const err = await runRes.json();
    throw new Error(`Apify ${runRes.status}: ${JSON.stringify(err)}`);
  }

  const runData = await runRes.json();
  const runId = runData.data?.id;
  const datasetId = runData.data?.defaultDatasetId;

  let status = 'RUNNING', attempts = 0;
  while (status === 'RUNNING' && attempts < 120) {
    await new Promise(r => setTimeout(r, 5000));
    const s = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, {
      headers: { 'Authorization': `Bearer ${APIFY_API_KEY}` }
    });
    status = (await s.json()).data?.status;
    attempts++;
    if (status !== 'RUNNING') break;
  }

  if (status !== 'SUCCEEDED') throw new Error(`Run terminó: ${status}`);

  const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?limit=200`, {
    headers: { 'Authorization': `Bearer ${APIFY_API_KEY}` }
  });
  const items = await itemsRes.json();
  items.forEach(v => { v._sourceHashtag = `#${slug}`; });
  console.log(`  [OK] #${slug}: ${items.length} vídeos`);
  return items;
}

// ── Filtros backend (cambio 2: nueva lógica AD) ───────────────────────────────
function filtrarVideos(videos, hashtagStats) {
  const antes = videos.length;
  let ads_conservados = 0, ads_descartados = 0, fans_bajos = 0, views_bajos = 0;

  const filtrados = videos.filter(v => {
    const views  = v.playCount || 0;
    const likes  = v.diggCount || 0;
    const fans   = v.authorMeta?.fans || v.authorMeta?.followers || 0;
    const isAd   = !!(v.isSponsored || v.isAd);
    const textLower = (v.text || '').toLowerCase();

    // Nueva lógica AD (cambio 2):
    // - AD con keywords de venta → CONSERVAR (dropshipper activo)
    // - AD sin keywords → DESCARTAR (TikTok Ads Manager puro, ruido artificial)
    if (isAd) {
      const hasSellingSignal = AD_SALE_KEYWORDS.some(k => textLower.includes(k));
      if (!hasSellingSignal) {
        ads_descartados++;
        return false;
      }
      ads_conservados++;
    }

    if (fans < FILTROS.min_fans)                              { fans_bajos++;  return false; }
    if (views < FILTROS.min_views && likes < FILTROS.min_likes) { views_bajos++; return false; }

    // Filtro fecha: descartar vídeos con más de 180 días — independiente del actor
    if (v.createTimeISO) {
      const days = Math.floor((Date.now() - new Date(v.createTimeISO).getTime()) / 86400000);
      if (days > 180) return false;
    }

    // Registrar en stats de hashtag (cambio 16: hashtag ROI)
    if (hashtagStats && v._sourceHashtag) {
      if (!hashtagStats[v._sourceHashtag]) hashtagStats[v._sourceHashtag] = { total: 0, passed: 0, identified: 0, validated: 0 };
      hashtagStats[v._sourceHashtag].passed++;
    }

    return true;
  });

  console.log(`[FILTRO] ${antes} → ${filtrados.length} | ADs descartados: ${ads_descartados} | ADs conservados (venta): ${ads_conservados} | fans<500: ${fans_bajos} | views bajos: ${views_bajos}`);
  return filtrados;
}

// ── Claude: identificar productos (cambio 3: descartar hauls agresivamente) ───
async function identificarProductos(videos, hashtagStats) {
  const batchSize = 25;
  const productMap = {};

  for (let i = 0; i < videos.length; i += batchSize) {
    const batch = videos.slice(i, i + batchSize);
    const adsJson = batch.map(v => ({
      id: String(v.id || i),
      text: ((v.text || '') + ' ' + (v.hashtags || []).map(h => typeof h === 'string' ? h : h.name || '').join(' ')).slice(0, 300)
    }));

    // Prompt v9.0: anti-falsos positivos + fusión de sinónimos + ejemplos negativos
    const prompt = `You are analyzing TikTok videos to find PHYSICAL DROPSHIPPING PRODUCTS — items someone can buy and resell.

Videos:
${JSON.stringify(adsJson, null, 2)}

RULES:
1. Identify ONE specific physical product being SOLD or PROMOTED.
2. Set product = "unknown" if the video is:
   - A LIFESTYLE/TOUR video (e.g. "closet tour", "kitchen organization tour", "my morning routine")
   - A TIPS/TUTORIAL without a specific product (e.g. "how to organize your closet", "kitchen cleaning hacks")
   - A HAUL with 4+ unrelated products
   - Pure dance, vlog, or motivational content
   - A CATEGORY with no specific item ("organization ideas", "kitchen essentials", "cleaning products" as a concept)

3. SYNONYM NORMALIZATION — these are the SAME product, use the canonical name:
   - "Grease-Cutting Cleaner Spray" = "Kitchen Spray Cleaner and Degreaser" = "Heavy-Duty Degreaser Spray" → canonical: "kitchen_degreaser_spray", name: "Kitchen Degreaser Spray"
   - "Closet Organizer System" = "Closet Organization System" = "Wardrobe Organizer" → canonical: "closet_organizer", name: "Closet Organizer"
   - "Cat Water Fountain" = "Pet Water Fountain" = "Dog Water Fountain" → canonical: "pet_water_fountain", name: "Pet Water Fountain"
   - "USB Cleaning Brush" = "Electric Cleaning Brush" = "Rechargeable Cleaning Brush" → canonical: "electric_cleaning_brush", name: "Electric Cleaning Brush"
   - "Steam Mop" = "Steam Cleaner" = "Multi-Purpose Steam Cleaner" → canonical: "steam_cleaner", name: "Steam Cleaner"

4. ACCEPT as valid products:
   - A specific gadget, tool, or accessory shown as THE focus of the video
   - Cleaning products with a clear brand or function (spray, brush, mop)
   - Pet accessories that are the main subject
   - Kitchen tools or organizers that are THE product being shown/sold

5. canonical: lowercase snake_case, max 4 words. Examples:
   - "Cold Press Juicer" → "cold_press_juicer"
   - "Dog Seat Belt" → "dog_seat_belt"
   - unknown → "unknown"

6. specificityScore: 90=exact named product, 70=clear product, 50=product category, 0=lifestyle/unknown
7. confidence: 0.8+=certain, 0.6+=pretty sure, 0.4+=possible, 0=unknown

Reply ONLY with a JSON array, no markdown:
[{"id":"<id>","product":"<name or unknown>","canonical":"<snake_case or unknown>","confidence":<0.0-1.0>,"specificityScore":<0-100>}]`;

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 4096, messages: [{ role: 'user', content: prompt }] })
      });
      const data = await res.json();
      const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      const clean = text.replace(/```json|```/g, '').trim();

      let parsed = null;
      const strategies = [
        () => { const m = clean.match(/\[\s*\{[\s\S]*\}\s*\]/); return m ? JSON.parse(m[0]) : null; },
        () => { const s = clean.indexOf('['); const e = clean.lastIndexOf(']'); return s>=0&&e>s ? JSON.parse(clean.slice(s,e+1)) : null; },
        () => JSON.parse(clean),
      ];
      for (const fn of strategies) {
        try { parsed = fn(); if (Array.isArray(parsed) && parsed.length) break; } catch(e) {}
      }

      if (parsed) {
        parsed.forEach(item => {
          productMap[String(item.id)] = item;
          // Registrar en hashtag stats (cambio 16)
          if (item.product !== 'unknown' && item.confidence >= 0.6 && hashtagStats) {
            const vid = batch.find(v => String(v.id) === String(item.id));
            if (vid && vid._sourceHashtag && hashtagStats[vid._sourceHashtag]) {
              hashtagStats[vid._sourceHashtag].identified++;
            }
          }
        });
        const ok = parsed.filter(p => p.product !== 'unknown').length;
        console.log(`  [CLAUDE] Batch ${Math.floor(i/batchSize)+1}: ${ok}/${batch.length} productos identificados`);
      }
    } catch(e) {
      console.error(`  [CLAUDE ERROR] Batch ${Math.floor(i/batchSize)+1}:`, e.message);
    }
  }
  return productMap;
}

// ── Agrupar productos ─────────────────────────────────────────────────────────
function agrupar(videos, productMap) {
  const groups = {};

  // Deduplicar por video ID — el mismo vídeo puede aparecer en 2 hashtags
  // y falsear el conteo de hashtags distintos
  const seenIds = new Set();
  videos = videos.filter(v => {
    const id = String(v.id || '');
    if (!id || seenIds.has(id)) return false;
    seenIds.add(id);
    return true;
  });
  console.log(`[DEDUP] ${videos.length} vídeos únicos tras deduplicar por ID`);

  for (const v of videos) {
    const raw = productMap[String(v.id)];
    if (!raw || raw.product === 'unknown' || raw.confidence < 0.55 || (raw.specificityScore || 0) < 50) continue;

    // Usar canonical si está disponible — más preciso que el nombre libre
    const key = raw.canonical && raw.canonical !== 'unknown'
      ? raw.canonical
      : raw.product.toLowerCase().trim().replace(/\s+/g, '_');
    if (!groups[key]) {
      groups[key] = {
        product_name: raw.product,
        canonical: key,           // guardar canonical del grupo
        videos: [],
        creators: new Set(),
        total_views: 0,
        total_likes: 0,
        ads_count: 0,
        oldest_days: null,
        newest_days: null,
        hashtags: new Set(),
      };
    }

    const g = groups[key];
    g.videos.push(v);
    g.creators.add(v.authorMeta?.name || '');
    g.total_views += v.playCount || 0;
    g.total_likes += v.diggCount || 0;
    if (v.isAd || v.isSponsored) g.ads_count++;
    g.hashtags.add(v._sourceHashtag || '');

    const ct = v.createTimeISO;
    if (ct) {
      try {
        const days = Math.floor((Date.now() - new Date(ct).getTime()) / 86400000);
        if (g.newest_days === null || days < g.newest_days) g.newest_days = days;
        if (g.oldest_days === null || days > g.oldest_days) g.oldest_days = days;
      } catch(e) {}
    }
  }

  const confirmados2A = [];  // confirmados gratis por cruce de hashtags
  const senales = [];         // pasan a Fase 2B (Apify)

  for (const g of Object.values(groups)) {
    const vv  = g.videos.length;
    const c   = g.creators.size;
    const ht  = g.hashtags.size;   // hashtags distintos donde apareció

    const obj = {
      product_name:    g.product_name,
      canonical:       g.canonical,
      video_count:     vv,
      creator_count:   c,
      hashtag_count:   ht,
      total_views:     g.total_views,
      total_likes:     g.total_likes,
      ads_count:       g.ads_count,
      oldest_days:     g.oldest_days,
      newest_days:     g.newest_days,
      hashtags:        Array.from(g.hashtags),
      score:           calcularScore(vv, c, g.total_views, g.total_likes, g.oldest_days, g.ads_count, ht),
      // Métricas agregadas para mostrar en el dashboard
      metrics: {
        views_totales:  g.total_views,
        likes_totales:  g.total_likes,
        videos_totales: vv,
        creadores:      c,
        hashtags_count: ht,
        ads:            g.ads_count,
        oldest_days:    g.oldest_days,
        newest_days:    g.newest_days,
      },
    };

    // ── Fase 2A: confirmación GRATIS por cruce de hashtags ────────────────────
    // Condición: ≥2 hashtags distintos AND ≥2 creadores distintos
    // Con 5 vídeos/hashtag, pedir vv>=3 es matemáticamente muy restrictivo
    // El cruce de 2 hashtags con 2 creadores distintos ya es señal suficiente
    const fase2A_ok = ht >= 2 && c >= 2;

    const label2A = ht >= 4 ? '✓✓✓✓ CONFIRMADO (4+ hashtags)'
                  : ht === 3 ? '✓✓✓ CONFIRMADO (3 hashtags)'
                  : ht === 2 ? '✓✓ CONFIRMADO (2 hashtags)'
                  : '~ SEÑAL (1 hashtag → Fase 2B)';

    console.log(`  ${label2A} | ${g.product_name}: ${vv}v ${c}c ${ht}ht ${g.total_views.toLocaleString()}V score=${obj.score}`);

    if (fase2A_ok) {
      // Guardar en cache para página /producto/:slug (igual que Fase 2B)
      const slug2a = slugify(g.product_name);
      productCache[slug2a] = {
        product_name:  g.product_name,
        score:         obj.score,
        video_count:   vv,
        creator_count: c,
        total_views:   g.total_views,
        total_likes:   g.total_likes,
        oldest_days:   g.oldest_days,
        newest_days:   g.newest_days,
        ads_count:     g.ads_count,
        hashtags:      Array.from(g.hashtags),
        fase2a:        true,
        videos: g.videos
          .sort((a, b) => (b.playCount || 0) - (a.playCount || 0))
          .map(v => ({
            id:          v.id,
            url:         v.webVideoUrl || `https://www.tiktok.com/@${v.authorMeta?.name}/video/${v.id}`,
            author:      v.authorMeta?.name || '?',
            author_fans: v.authorMeta?.fans || 0,
            views:       v.playCount || 0,
            likes:       v.diggCount || 0,
            text:        (v.text || '').slice(0, 150),
            date:        (v.createTimeISO || '').slice(0, 10),
            cover:       v.videoMeta?.coverUrl || v.covers?.default || '',
            is_ad:       !!(v.isAd || v.isSponsored),
          })),
      };
      confirmados2A.push({ ...obj, label: 'Confirmado', fase2a: true, producto_url: `/producto/${slug2a}` });
    } else {
      senales.push({ ...obj, label: 'Señal' });
    }
  }

  confirmados2A.sort((a,b) => b.score - a.score);
  senales.sort((a,b) => b.total_views - a.total_views);

  console.log(`[GRUPOS] Confirmados 2A (gratis): ${confirmados2A.length} | Señales → Fase 2B: ${senales.length}`);
  return { confirmados: confirmados2A, senales };
}

// ── Scoring ───────────────────────────────────────────────────────────────────
// 50% creadores / 25% vídeos / 15% views / 10% likes
// Bonus hashtags distintos: 1→0 | 2→+15 | 3→+30 | 4+→+40
// Bonus ADs activos: ≥3 → +5
// Penalización producto viejo: oldest_days > 180 → ×0.7
function calcularScore(videoCount, creatorCount, totalViews, totalLikes, oldestDays, adsCount, hashtagCount) {
  const creatorScore = Math.min(creatorCount / 10, 1) * 50;
  const videoScore   = Math.min(videoCount  / 20, 1) * 25;
  const viewsScore   = Math.min(totalViews  / 5000000, 1) * 15;
  const likesScore   = Math.min(totalLikes  / 100000, 1) * 10;

  let score = creatorScore + videoScore + viewsScore + likesScore;

  // Penalización producto viejo
  if (oldestDays !== null && oldestDays > FASE2_PENALIZE_DAYS) {
    score = score * 0.7;
  }

  // Bonus ADs activos = mercado con dinero
  if (adsCount >= 3) score += 5;

  // Bonus hashtags distintos — señal de tendencia cruzada
  const htBonus = hashtagCount >= 4 ? 40
                : hashtagCount === 3 ? 30
                : hashtagCount === 2 ? 15
                : 0;
  score += htBonus;

  return Math.round(score * 10) / 10;
}

// ── Scraping Fase 2 por nombre (cambios 7, 17) ────────────────────────────────
async function scrapeByName(productName, n) {
  console.log(`[FASE2] Buscando: "${productName}" × ${n} vídeos`);

  const input = {
    searchQueries: [productName],
    searchSection: '/video',
    videoSearchSorting: 'MOST_RELEVANT',      // v8.3: más preciso, menos ruido semántico
    videoSearchDateFilter: 'LAST_3_MONTHS',   // v8.5: valor correcto según Apify docs
    resultsPerPage: n,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
    proxyCountryCode: 'US',                   // cambio 17: solo USA/inglés
    // SIN excludeAds
  };

  const runRes = await fetch('https://api.apify.com/v2/acts/clockworks~tiktok-scraper/runs?memory=4096', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${APIFY_API_KEY}` },
    body: JSON.stringify(input)
  });

  if (runRes.status !== 200 && runRes.status !== 201) {
    const err = await runRes.json();
    throw new Error(`Apify ${runRes.status}: ${JSON.stringify(err)}`);
  }

  const runData = await runRes.json();
  const runId = runData.data?.id;
  const datasetId = runData.data?.defaultDatasetId;

  let status = 'RUNNING', attempts = 0;
  while (status === 'RUNNING' && attempts < 120) {
    await new Promise(r => setTimeout(r, 5000));
    const s = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, {
      headers: { 'Authorization': `Bearer ${APIFY_API_KEY}` }
    });
    status = (await s.json()).data?.status;
    attempts++;
    if (status !== 'RUNNING') break;
  }

  if (status !== 'SUCCEEDED') throw new Error(`Run terminó: ${status}`);

  const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?limit=50`, {
    headers: { 'Authorization': `Bearer ${APIFY_API_KEY}` }
  });
  return await itemsRes.json();
}

// ── Fase 2: validar señal ─────────────────────────────────────────────────────
async function validarSenal(senal, hashtagStats) {
  console.log(`[FASE2] Validando: "${senal.product_name}"`);

  try {
    // Buscar 10 vídeos (cambio 6: coste controlado)
    const videos = await scrapeByName(senal.product_name, FASE2_VIDEOS_POR_PRODUCTO);
    if (!videos.length) { console.log(`  Sin resultados`); return null; }

    const now = Date.now();

    // Fase 2B — filtro ENDURECIDO (Opción E):
    // Exige AMBAS condiciones: views>50k AND likes>1000 (antes era OR)
    // Esto reduce drásticamente el ruido de TikTok Search
    const viralesRaw = videos.filter(v => {
      const views = v.playCount || 0;
      const likes = v.diggCount || 0;
      const days  = v.createTimeISO ? Math.floor((now - new Date(v.createTimeISO).getTime()) / 86400000) : 999;
      return views >= FILTROS.min_views && likes >= FILTROS.min_likes && days <= 90;
    });

    if (!viralesRaw.length) { console.log(`  Sin vídeos virales recientes con filtro duro`); return null; }

    // Identificar productos en los vídeos virales
    const newMap = await identificarProductos(viralesRaw, null);

    // ── Matching por canonical (Solución A) con fallback Claude (Solución B) ──
    // El canonical del producto objetivo viene de la señal de Fase 1
    const targetCanonical = senal.canonical || slugify(senal.product_name).replace(/-/g, '_');

    // Primera pasada: matching exacto por canonical
    let confirming = viralesRaw.filter(v => {
      const p = newMap[String(v.id)];
      if (!p || p.product === 'unknown' || p.canonical === 'unknown') return false;
      return p.canonical === targetCanonical;
    });

    // Segunda pasada: si hay vídeos con producto identificado pero canonical no coincide exactamente,
    // preguntar a Claude una sola vez si son el mismo producto (Solución B — fallback)
    const sinConfirmar = viralesRaw.filter(v => {
      const p = newMap[String(v.id)];
      if (!p || p.product === 'unknown') return false;
      if (confirming.includes(v)) return false; // ya confirmado
      return p.canonical !== 'unknown'; // tiene producto pero canonical distinto
    });

    if (sinConfirmar.length > 0) {
      try {
        const comparaciones = sinConfirmar.map(v => ({
          id: String(v.id),
          detected: newMap[String(v.id)].product
        }));
        const fallbackPrompt = `Target product: "${senal.product_name}"
For each detected product, answer if it is CLEARLY the same product as the target (same function, same form factor).
Do NOT approve if it's just in the same category. "Juicer" ≠ "Cold Press Juicer". "Dog Collar" ≠ "Dog Seat Belt".

${JSON.stringify(comparaciones)}

Reply ONLY with JSON array: [{"id":"<id>","match":true/false}]`;

        const fb = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 512, messages: [{ role: 'user', content: fallbackPrompt }] })
        });
        const fbData = await fb.json();
        const fbText = (fbData.content || []).filter(b => b.type === 'text').map(b => b.text).join('').replace(/```json|```/g, '').trim();
        const fbParsed = JSON.parse(fbText.slice(fbText.indexOf('['), fbText.lastIndexOf(']') + 1));
        const matchIds = new Set(fbParsed.filter(x => x.match).map(x => String(x.id)));
        const extraConfirmed = sinConfirmar.filter(v => matchIds.has(String(v.id)));
        confirming = [...confirming, ...extraConfirmed];
        console.log(`  [FALLBACK] Claude confirmó ${extraConfirmed.length} adicionales por similitud`);
      } catch(e) {
        console.log(`  [FALLBACK] Error en comparación Claude: ${e.message} — ignorado`);
      }
    }

    const creators  = new Set(confirming.map(v => v.authorMeta?.name || ''));
    const adsCount  = confirming.filter(v => v.isAd || v.isSponsored).length;

    // Calcular oldest_days y newest_days (cambio 9)
    const daysList = confirming
      .filter(v => v.createTimeISO)
      .map(v => Math.floor((now - new Date(v.createTimeISO).getTime()) / 86400000));
    const oldest_days = daysList.length ? Math.max(...daysList) : null;
    const newest_days = daysList.length ? Math.min(...daysList) : null;

    const totalViews = confirming.reduce((s, v) => s + (v.playCount || 0), 0);
    const totalLikes = confirming.reduce((s, v) => s + (v.diggCount || 0), 0);
    const score = calcularScore(confirming.length, creators.size, totalViews, totalLikes, oldest_days, adsCount, senal.hashtag_count || 1);

    console.log(`  ${confirming.length}v | ${creators.size}c | oldest=${oldest_days}d | score=${score} → ${confirming.length >= FASE2_MIN_VIDEOS && creators.size >= FASE2_MIN_CREATORS ? '✓ PROMOVIDO' : '✗ DESCARTADO'}`);

    // Descarte por umbrales mínimos (cambio 10)
    if (confirming.length < FASE2_MIN_VIDEOS || creators.size < FASE2_MIN_CREATORS) return null;

    // Guardar vídeos en cache para página de detalle (cambio 14/15)
    const slug = slugify(senal.product_name);
    productCache[slug] = {
      product_name:  senal.product_name,
      score,
      video_count:   confirming.length,
      creator_count: creators.size,
      total_views:   totalViews,
      total_likes:   totalLikes,
      oldest_days,
      newest_days,
      ads_count:     adsCount,
      hashtags:      senal.hashtags,
      videos: confirming
        .sort((a, b) => (b.playCount || 0) - (a.playCount || 0))
        .map(v => ({
          id:        v.id,
          url:       v.webVideoUrl || `https://www.tiktok.com/@${v.authorMeta?.name}/video/${v.id}`,
          author:    v.authorMeta?.name || '?',
          author_fans: v.authorMeta?.fans || 0,
          views:     v.playCount || 0,
          likes:     v.diggCount || 0,
          text:      (v.text || '').slice(0, 150),
          date:      (v.createTimeISO || '').slice(0, 10),
          cover:     v.videoMeta?.coverUrl || v.covers?.default || '',
          is_ad:     !!(v.isAd || v.isSponsored),
        })),
    };

    // Actualizar hashtag stats (cambio 16)
    if (hashtagStats && senal.hashtags) {
      senal.hashtags.forEach(ht => {
        if (hashtagStats[ht]) hashtagStats[ht].validated++;
      });
    }

    return {
      ...senal,
      label:               'Validado',
      score,
      fase2_viral_count:   confirming.length,
      fase2_creator_count: creators.size,
      video_count:         senal.video_count + confirming.length,
      creator_count:       senal.creator_count + creators.size,
      total_views:         senal.total_views + totalViews,
      total_likes:         senal.total_likes + totalLikes,
      oldest_days,
      newest_days,
      ads_count:           (senal.ads_count || 0) + adsCount,
      producto_url:        `/producto/${slug}`,
    };
  } catch(e) {
    console.error(`  Error: ${e.message}`);
  }
  return null;
}

// ── Utilidades ────────────────────────────────────────────────────────────────
function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ── Página de detalle de producto (cambio 14) ─────────────────────────────────
function renderProductPage(data) {
  const { product_name, score, video_count, creator_count, total_views, total_likes,
          oldest_days, newest_days, ads_count, hashtags, videos } = data;

  const freshnessTag = newest_days <= 7  ? '🔥 Explota AHORA'
                     : newest_days <= 14 ? '⚡ Muy reciente'
                     : newest_days <= 30 ? '✅ Reciente'
                     : '⚠️ Moderado';

  const oldTag = oldest_days > 180 ? ' ⚠️ producto con historial largo' : '';

  const videoCards = videos.map(v => `
    <a href="${v.url}" target="_blank" class="card">
      <div class="card-header">
        ${v.cover ? `<img src="${v.cover}" alt="cover" onerror="this.style.display='none'">` : '<div class="no-cover">▶</div>'}
        ${v.is_ad ? '<span class="ad-badge">AD vendedor</span>' : ''}
      </div>
      <div class="card-body">
        <div class="metrics">
          <span>👁 ${(v.views/1000).toFixed(0)}K views</span>
          <span>❤️ ${(v.likes/1000).toFixed(1)}K likes</span>
        </div>
        <div class="author">@${v.author} · ${v.author_fans >= 1000 ? (v.author_fans/1000).toFixed(0)+'K' : v.author_fans} fans</div>
        <div class="date">${v.date}</div>
        <div class="text">${v.text}</div>
      </div>
    </a>`).join('');

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${product_name} — Cazador IA</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f1a; color: #e2e8f0; min-height: 100vh; }
    .header { background: #1a1a2e; border-bottom: 1px solid #2d2d44; padding: 20px 32px; display: flex; align-items: center; gap: 16px; }
    .back { color: #7c85f3; text-decoration: none; font-size: 14px; }
    .back:hover { color: #a5b4fc; }
    .product-title { font-size: 22px; font-weight: 700; color: #fff; }
    .score-badge { margin-left: auto; background: #7c3aed; color: #fff; font-size: 18px; font-weight: 800; padding: 6px 18px; border-radius: 20px; }
    .metrics-bar { background: #1a1a2e; padding: 20px 32px; display: flex; gap: 32px; flex-wrap: wrap; border-bottom: 1px solid #2d2d44; }
    .metric { display: flex; flex-direction: column; gap: 4px; }
    .metric-label { font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; }
    .metric-value { font-size: 20px; font-weight: 700; color: #fff; }
    .metric-value.green { color: #4ade80; }
    .metric-value.yellow { color: #fbbf24; }
    .metric-value.red { color: #f87171; }
    .freshness { background: #16213e; padding: 12px 32px; font-size: 13px; color: #94a3b8; }
    .freshness span { color: #a5b4fc; font-weight: 600; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; padding: 24px 32px; }
    .card { background: #1e1e3a; border: 1px solid #2d2d44; border-radius: 12px; overflow: hidden; text-decoration: none; color: inherit; display: block; transition: transform 0.15s, border-color 0.15s; }
    .card:hover { transform: translateY(-2px); border-color: #7c85f3; }
    .card-header { position: relative; background: #0f0f1a; height: 140px; display: flex; align-items: center; justify-content: center; overflow: hidden; }
    .card-header img { width: 100%; height: 100%; object-fit: cover; }
    .no-cover { font-size: 40px; color: #2d2d44; }
    .ad-badge { position: absolute; top: 8px; right: 8px; background: #7c3aed; color: #fff; font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 10px; }
    .card-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; }
    .metrics { display: flex; gap: 12px; font-size: 13px; font-weight: 600; color: #a5b4fc; }
    .author { font-size: 12px; color: #94a3b8; }
    .date { font-size: 11px; color: #64748b; }
    .text { font-size: 12px; color: #cbd5e1; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .hashtags { padding: 0 32px 12px; display: flex; gap: 8px; flex-wrap: wrap; }
    .tag { background: #1e1e3a; border: 1px solid #2d2d44; color: #94a3b8; font-size: 12px; padding: 3px 10px; border-radius: 12px; }
    .empty { text-align: center; padding: 60px; color: #64748b; }
  </style>
</head>
<body>
  <div class="header">
    <a href="/cazador" class="back">← Cazador</a>
    <div class="product-title">${product_name}</div>
    <div class="score-badge">Score ${score}</div>
  </div>

  <div class="metrics-bar">
    <div class="metric">
      <span class="metric-label">Creadores</span>
      <span class="metric-value ${creator_count >= 5 ? 'green' : creator_count >= 3 ? 'yellow' : 'red'}">${creator_count}</span>
    </div>
    <div class="metric">
      <span class="metric-label">Vídeos virales</span>
      <span class="metric-value">${video_count}</span>
    </div>
    <div class="metric">
      <span class="metric-label">Views totales</span>
      <span class="metric-value">${(total_views / 1000000).toFixed(1)}M</span>
    </div>
    <div class="metric">
      <span class="metric-label">Likes totales</span>
      <span class="metric-value">${(total_likes / 1000).toFixed(0)}K</span>
    </div>
    <div class="metric">
      <span class="metric-label">Más antiguo</span>
      <span class="metric-value ${oldest_days > 180 ? 'red' : 'green'}">${oldest_days ?? '?'}d${oldTag}</span>
    </div>
    <div class="metric">
      <span class="metric-label">Más reciente</span>
      <span class="metric-value green">${newest_days ?? '?'}d</span>
    </div>
    ${ads_count > 0 ? `<div class="metric">
      <span class="metric-label">Vendedores AD</span>
      <span class="metric-value ${ads_count >= 3 ? 'green' : ''}">${ads_count} ${ads_count >= 3 ? '🔥' : ''}</span>
    </div>` : ''}
  </div>

  <div class="freshness">
    Tendencia: <span>${freshnessTag}</span>
    &nbsp;·&nbsp; Encontrado en: ${hashtags.map(h => `<span>${h}</span>`).join(', ')}
  </div>

  <div class="hashtags">
    ${hashtags.map(h => `<span class="tag">${h}</span>`).join('')}
  </div>

  <div class="grid">
    ${videoCards || '<div class="empty">No hay vídeos en caché para este producto.</div>'}
  </div>
</body>
</html>`;
}

// ── Endpoints ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status: 'ok', version: 'v9.0',
  fase1: QUERIES_CONFIG,
  filtros: FILTROS,
  fase2: { videos_por_producto: FASE2_VIDEOS_POR_PRODUCTO, min_videos: FASE2_MIN_VIDEOS, min_creators: FASE2_MIN_CREATORS, max_validaciones: FASE2_MAX_VALIDACIONES },
  scoring: { creadores: '50%', videos: '25%', views: '15%', likes: '10%', penalizacion_dias: FASE2_PENALIZE_DAYS, bonus_ads: '≥3 ADs = +5pts' }
}));

app.get('/buscar', async (req, res) => {
  const jobId = createJob();
  res.json({ success: true, job_id: jobId });

  (async () => {
    try {
      // Tabla hashtag ROI (cambio 16)
      const hashtagStats = {};
      QUERIES_CONFIG.forEach(q => {
        hashtagStats[q.query] = { total: q.videos, passed: 0, identified: 0, validated: 0 };
      });

      // ── FASE 1: Scraping ──────────────────────────────────────────────────
      updateJob(jobId, { progress: 'Fase 1: Scrapeando hashtags...' });
      const rawVideos = [];

      for (let i = 0; i < QUERIES_CONFIG.length; i++) {
        const { query, videos } = QUERIES_CONFIG[i];
        updateJob(jobId, { progress: `Fase 1 [${i+1}/${QUERIES_CONFIG.length}]: ${query}...` });
        try {
          const vids = await scrapeHashtag(query, videos);
          rawVideos.push(...vids);
        } catch(e) { console.error(`[ERROR] ${query}:`, e.message); }
      }

      console.log(`[FASE1] ${rawVideos.length} vídeos crudos`);

      // Filtrar (con nueva lógica AD)
      const filtrados = filtrarVideos(rawVideos, hashtagStats);
      updateJob(jobId, { progress: `${filtrados.length} vídeos filtrados. Claude identificando productos...` });

      // ── Claude: identificar productos ────────────────────────────────────
      const productMap = await identificarProductos(filtrados, hashtagStats);

      // ── Agrupar ──────────────────────────────────────────────────────────
      updateJob(jobId, { progress: 'Agrupando productos...' });
      console.log('\n=== AGRUPACIÓN ===');
      const { confirmados, senales } = agrupar(filtrados, productMap);

      // ── FASE 2: Validar señales únicas (máx 10) ──────────────────────────
      const validados = [];
      const pendientes = [];

      if (senales.length > 0) {
        const toValidate = senales.slice(0, FASE2_MAX_VALIDACIONES);
        const remaining = senales.slice(FASE2_MAX_VALIDACIONES);
        pendientes.push(...remaining);

        updateJob(jobId, { progress: `Fase 2: Validando ${toValidate.length} señales...` });
        console.log('\n=== FASE 2 ===');

        for (const senal of toValidate) {
          updateJob(jobId, { progress: `Fase 2: Validando "${senal.product_name}"...` });
          const resultado = await validarSenal(senal, hashtagStats);
          if (resultado) validados.push(resultado);
        }
      }

      // ── Resultado final ───────────────────────────────────────────────────
      const todos = [...confirmados, ...validados].sort((a, b) => b.score - a.score);

      console.log(`\n[DONE] ${todos.length} productos (${confirmados.length} directos + ${validados.length} validados)`);

      // Tabla hashtag ROI para dashboard (cambio 16)
      const hashtag_roi = Object.entries(hashtagStats).map(([ht, s]) => ({
        hashtag: ht, total: s.total, passed: s.passed, identified: s.identified, validated: s.validated
      })).sort((a, b) => b.validated - a.validated);

      updateJob(jobId, {
        status: 'done',
        result: {
          success:                true,
          total:                  todos.length,
          confirmados_directos:   confirmados.length,
          validados_fase2:        validados.length,
          senales_pendientes:     pendientes.length,
          productos:              todos,
          pending_signals:        pendientes,
          hashtag_roi,
          stats: {
            videos_scrapeados:  rawVideos.length,
            videos_filtrados:   filtrados.length,
            videos_descartados: rawVideos.length - filtrados.length,
          }
        }
      });

    } catch(e) {
      console.error('[ERROR GENERAL]', e.message);
      updateJob(jobId, { status: 'error', result: { error: e.message } });
    }
  })();
});

app.get('/job-status/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job no encontrado' });
  res.json(job);
});

// ── Endpoint para validar señales pendientes desde el frontend ────────────────
app.post('/validate-signals', async (req, res) => {
  const { signals } = req.body || {};
  if (!signals || !signals.length) return res.status(400).json({ error: 'No signals provided' });

  const jobId = createJob();
  res.json({ success: true, job_id: jobId });

  (async () => {
    try {
      const toValidate = signals.slice(0, 10);
      const remaining  = signals.slice(10);
      const validados  = [];

      updateJob(jobId, { progress: `Validando ${toValidate.length} señales pendientes...` });

      for (const senal of toValidate) {
        updateJob(jobId, { progress: `Validando "${senal.product_name}"...` });
        const resultado = await validarSenal(senal, null);
        if (resultado) validados.push(resultado);
      }

      validados.sort((a, b) => b.score - a.score);
      console.log(`[VALIDATE-SIGNALS] ${validados.length}/${toValidate.length} validados`);

      updateJob(jobId, {
        status: 'done',
        result: {
          success:         true,
          nuevos:          validados,
          pending_signals: remaining,
        }
      });
    } catch(e) {
      console.error('[VALIDATE-SIGNALS ERROR]', e.message);
      updateJob(jobId, { status: 'error', result: { error: e.message } });
    }
  })();
});

// Página de detalle de producto (cambio 14)
app.get('/producto/:slug', (req, res) => {
  const data = productCache[req.params.slug];
  if (!data) return res.status(404).send(`
    <html><body style="background:#0f0f1a;color:#e2e8f0;font-family:sans-serif;padding:40px;text-align:center">
      <h2>Producto no encontrado en caché</h2>
      <p style="color:#94a3b8;margin-top:12px">Ejecuta una búsqueda primero para generar los datos de este producto.</p>
      <a href="/cazador" style="color:#7c85f3;margin-top:20px;display:block">← Volver al Cazador</a>
    </body></html>
  `);
  res.send(renderProductPage(data));
});

// API para obtener datos del producto en JSON
app.get('/api/producto/:slug', (req, res) => {
  const data = productCache[req.params.slug];
  if (!data) return res.status(404).json({ error: 'No encontrado' });
  res.json(data);
});

app.get('/cazador', (req, res) => res.sendFile(path.join(__dirname, 'cazador.html')));
app.use(express.static(__dirname));


const META_URL    = process.env.META_URL    || 'https://meta-ads-production-c504.up.railway.app';
const TRENDS_URL  = process.env.TRENDS_URL  || 'https://google-trends-production.up.railway.app';
const PROVEED_URL = process.env.PROVEED_URL || 'https://proveedores-production.up.railway.app';
const FILTRO_MARGEN_MIN = 60;

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function pollJob(baseUrl, jobId, maxMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    await new Promise(r => setTimeout(r, 4000));
    const r = await fetch(`${baseUrl}/job-status/${jobId}`);
    const d = await r.json();
    if (d.status === 'done')  return d.result;
    if (d.status === 'error') throw new Error(d.result?.error || 'Job error');
  }
  throw new Error('Timeout polling job');
}

async function runProductoPipeline(res, nombre, score, creators, videos) {
  // META
  sseWrite(res, 'capa', { capa: 2, nombre: 'Meta Ads USA', estado: 'running', producto: nombre, detalle: 'Validando anunciantes...' });
  let metaResult = null;
  try {
    const sr = await fetch(`${META_URL}/validate-one`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product: nombre, tiktok_score: score||0, creators: creators||0, videos: videos||0 }),
      signal: AbortSignal.timeout(15000),
    });
    const sd = await sr.json();
    if (sd.job_id) { const jr = await pollJob(META_URL, sd.job_id, 120000); metaResult = jr?.producto || null; }
  } catch(e) { console.error(`[META] ${nombre}:`, e.message); }

  const pasaMeta    = metaResult?.meta?.pasa_a_trends === true;
  const anunciantes = metaResult?.meta?.operadores_independientes ?? 0;
  const keywordMeta = metaResult?.meta_keyword_used || nombre;
  sseWrite(res, 'meta_result', { producto: nombre, pasa: pasaMeta, anunciantes, keyword: keywordMeta, anuncios: metaResult?.meta?.total_ads_found });

  if (!pasaMeta) {
    sseWrite(res, 'descartado', { producto: nombre, capa: 'Meta', motivo: `${anunciantes} anunciantes (mín 3)` });
    return null;
  }

  // TRENDS BYPASS
  sseWrite(res, 'capa', { capa: 3, nombre: 'Google Trends', estado: 'done', producto: nombre, detalle: '⏭️ Bypassed' });
  sseWrite(res, 'trends_result', { producto: nombre, decision: 'pasa', trend_90d: 'N/A', trend_12m: 'N/A', phase: 'Sin datos', phase_icon: '⏭️' });

  // VIABILIDAD
  sseWrite(res, 'capa', { capa: 4, nombre: 'Viabilidad España', estado: 'running', producto: nombre, detalle: 'Precios en España...' });
  let viabData = null;
  try {
    const r = await fetch(`${META_URL}/viabilidad`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_name: nombre, meta_keyword: keywordMeta, country: 'ES', days: 7 }),
      signal: AbortSignal.timeout(300000),
    });
    viabData = await r.json();
  } catch(e) { console.error(`[VIAB] ${nombre}:`, e.message); }
  const precioMedioEs = viabData?.precios?.precio_medio || null;
  sseWrite(res, 'viabilidad_result', { producto: nombre, competidores: viabData?.anuncios_encontrados, precio_min: viabData?.precios?.precio_minimo, precio_medio: precioMedioEs, precio_max: viabData?.precios?.precio_maximo, precio_medio_fmt: viabData?.precios?.precio_medio_fmt });

  // PROVEEDORES
  sseWrite(res, 'capa', { capa: 5, nombre: 'Proveedores', estado: 'running', producto: nombre, detalle: 'AliExpress + Alibaba...' });
  let provData = null;
  try {
    const r = await fetch(`${PROVEED_URL}/proveedor`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_name: nombre, keyword: keywordMeta, precio_venta_es: precioMedioEs }),
      signal: AbortSignal.timeout(300000),
    });
    provData = await r.json();
  } catch(e) { console.error(`[PROV] ${nombre}:`, e.message); }

  const margenPct   = provData?.resumen?.margen_bruto_pct  || null;
  const costeMin    = provData?.resumen?.coste_minimo       || null;
  const margenEuros = provData?.resumen?.margen_bruto_euros || null;
  sseWrite(res, 'proveedores_result', { producto: nombre, coste_min: costeMin, proveedor: provData?.resumen?.proveedor_mas_barato, margen_pct: margenPct, margen_euros: margenEuros, veredicto: provData?.resumen?.veredicto });

  if (margenPct !== null && margenPct < FILTRO_MARGEN_MIN) {
    sseWrite(res, 'descartado', { producto: nombre, capa: 'Margen', motivo: `Margen ${margenPct}% < ${FILTRO_MARGEN_MIN}%` });
    return null;
  }

  const ventasPara10k = precioMedioEs ? Math.ceil(10000 / precioMedioEs) : null;
  const semaforo      = margenPct >= 70 ? '🟢' : margenPct >= 60 ? '🟡' : '🔴';

  return {
    producto: nombre, semaforo,
    score_tiktok: score, videos, creadores: creators,
    keyword_meta: keywordMeta, anunciantes_usa: anunciantes, pasa_meta: pasaMeta,
    competidores_es: viabData?.anuncios_encontrados,
    precio_min_es: viabData?.precios?.precio_minimo, precio_medio_es: precioMedioEs, precio_max_es: viabData?.precios?.precio_maximo,
    coste_min: costeMin, proveedor: provData?.resumen?.proveedor_mas_barato,
    margen_pct: margenPct, margen_euros: margenEuros, veredicto: provData?.resumen?.veredicto,
    ventas_para_10k: ventasPara10k, ventas_dia: ventasPara10k ? Math.ceil(ventasPara10k/30) : null,
    aliexpress: provData?.proveedores?.aliexpress?.[0] || null,
    alibaba:    provData?.proveedores?.alibaba?.[0]    || null,
  };
}

// ── /cazador/stream — Pipeline completo desde TikTok ─────────────────────────
app.get('/cazador/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000);
  const stats = { tiktok: 0, meta_pasan: 0, trends_pasan: 0, final: 0 };

  try {
    sseWrite(res, 'capa', { capa: 1, nombre: 'TikTok Cazador', estado: 'running', detalle: `${QUERIES_CONFIG.length} hashtags × 10 vídeos` });
    const hashtagStats = {};
    QUERIES_CONFIG.forEach(q => { hashtagStats[q.query] = { total: q.videos, passed: 0, identified: 0, validated: 0 }; });

    const rawVideos = [];
    for (let i = 0; i < QUERIES_CONFIG.length; i++) {
      const { query, videos } = QUERIES_CONFIG[i];
      sseWrite(res, 'progreso', { capa: 1, paso: `[${i+1}/${QUERIES_CONFIG.length}] ${query}` });
      try { rawVideos.push(...await scrapeHashtag(query, videos)); } catch(e) { console.error(`[${query}]`, e.message); }
    }

    const filtrados = filtrarVideos(rawVideos, hashtagStats);
    sseWrite(res, 'progreso', { capa: 1, paso: `${filtrados.length} vídeos filtrados → Claude identificando...` });
    const productMap = await identificarProductos(filtrados, hashtagStats);
    const { confirmados, senales } = agrupar(filtrados, productMap);
    const validados = [];
    for (const s of senales.slice(0, FASE2_MAX_VALIDACIONES)) {
      sseWrite(res, 'progreso', { capa: 1, paso: `Fase 2B: "${s.product_name}"` });
      const r = await validarSenal(s, hashtagStats); if (r) validados.push(r);
    }

    const productosTikTok = [...confirmados, ...validados].sort((a, b) => b.score - a.score);
    stats.tiktok = productosTikTok.length;
    sseWrite(res, 'capa', { capa: 1, nombre: 'TikTok Cazador', estado: 'done', detalle: `${productosTikTok.length} productos detectados` });
    for (const p of productosTikTok) {
      sseWrite(res, 'producto_tiktok', { product_name: p.product_name, score: p.score, video_count: p.video_count, unique_creators: p.unique_creators, hashtag_count: p.hashtag_count, oldest_days: p.oldest_days });
    }

    const informesFinal = [];
    for (const producto of productosTikTok) {
      const informe = await runProductoPipeline(res, producto.product_name, producto.score, producto.unique_creators, producto.video_count);
      if (informe) { informesFinal.push(informe); stats.final++; sseWrite(res, 'informe_producto', informe); }
    }

    informesFinal.sort((a, b) => (b.margen_pct||0) - (a.margen_pct||0));
    sseWrite(res, 'fin', { stats, total_ganadores: stats.final, quarter: QUARTER, embudo: `TikTok ${stats.tiktok} → Ganadores ${stats.final}` });
  } catch(e) {
    console.error('[STREAM ERROR]', e.message);
    sseWrite(res, 'error', { mensaje: e.message });
  } finally { clearInterval(keepAlive); res.end(); }
});

// ── /batch/stream — Valida lista de productos sin TikTok ─────────────────────
app.get('/batch/stream', async (req, res) => {
  const productos = (req.query.productos||'').split(',').map(p=>p.trim()).filter(Boolean);
  if (!productos.length) return res.status(400).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000);

  sseWrite(res, 'inicio', { total: productos.length, productos });
  const informesFinal = [];

  try {
    for (const nombre of productos) {
      const informe = await runProductoPipeline(res, nombre, 0, 0, 0);
      if (informe) { informesFinal.push(informe); sseWrite(res, 'informe_producto', informe); }
    }
    informesFinal.sort((a, b) => (b.margen_pct||0) - (a.margen_pct||0));
    sseWrite(res, 'fin', { total_ganadores: informesFinal.length });
  } catch(e) {
    sseWrite(res, 'error', { mensaje: e.message });
  } finally { clearInterval(keepAlive); res.end(); }
});

// ── /validar/stream — Valida un producto individual (URL o nombre) ───────────
async function extraerNombreProducto(input) {
  const prompt = `You are a dropshipping researcher. Extract the English product name from this input (URL, text, or product name). Be specific (e.g. "Portable Dog Water Bottle" not "pet accessory"). Input: "${input}" Respond ONLY with JSON: {"product_name": "name"}`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 100, messages: [{ role: 'user', content: prompt }] }),
  });
  const d = await r.json();
  const text = (d.content?.[0]?.text||'').trim().replace(/```json|```/g,'').trim();
  return JSON.parse(text).product_name;
}

app.get('/validar/stream', async (req, res) => {
  const input = req.query.input?.trim();
  if (!input) return res.status(400).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000);

  try {
    sseWrite(res, 'progreso', { paso: `Analizando: "${input.substring(0,60)}..."` });
    const nombre = await extraerNombreProducto(input);
    sseWrite(res, 'producto_detectado', { producto: nombre, input_original: input });
    const informe = await runProductoPipeline(res, nombre, 0, 0, 0);
    if (informe) {
      sseWrite(res, 'informe_manual', { ...informe, input_original: input });
    }
    sseWrite(res, 'fin_manual', { producto: nombre, margen_pct: informe?.margen_pct });
  } catch(e) {
    sseWrite(res, 'error', { mensaje: e.message });
  } finally { clearInterval(keepAlive); res.end(); }
});

app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'cazador-dashboard.html')));

app.listen(PORT, () => {
  console.log(`[SERVER] Cazador v9.0 en puerto ${PORT}`);
  console.log(`[FASE1] ${QUERIES_CONFIG.length} hashtags × ${QUERIES_CONFIG[0].videos} vídeos = ${QUERIES_CONFIG.reduce((s,q)=>s+q.videos,0)} vídeos`);
  console.log(`[FILTROS] views>=${FILTROS.min_views} | likes>=${FILTROS.min_likes} | fans>=${FILTROS.min_fans} | ADs: filtro propio`);
  console.log(`[FASE2] ${FASE2_VIDEOS_POR_PRODUCTO}v/producto | min ${FASE2_MIN_VIDEOS}v ${FASE2_MIN_CREATORS}c | max ${FASE2_MAX_VALIDACIONES} validaciones | penaliza >${FASE2_PENALIZE_DAYS}d`);
  console.log(`[SCORING] 50%creadores 25%videos 15%views 10%likes +5bonus(≥3ADs) -30%(>180d)`);
  console.log(`[MATCHING] canonical + Fase2A gratis + Fase2B MOST_RELEVANT + filtro 180d + dedup`);
});
