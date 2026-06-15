// ─────────────────────────────────────────────────────────────────────────────
// CAZADOR v8.0 — Pipeline completo Fase 1 + Fase 2
// Cambios v8.0:
//  1. excludeAds eliminado del actor Apify — filtramos nosotros con lógica propia
//  2. Nueva lógica AD: conservar si tiene keywords de venta, descartar si es AD puro
//  3. Prompt Claude mejorado: descartar hauls con >3 productos visibles
//  4. 20 hashtags × 5 vídeos (más superficie, menos profundidad)
//  5. Nuevos hashtags: eliminados #homehacks #organizationideas #cleaningtips #gadgets
//  6. Fase 2: 10 vídeos por producto (coste controlado)
//  7. Fase 2: videoSearchSorting MOST_VIEWED + PAST_3_MONTHS
//  8. Fase 2: filtrar vídeos < 50k views antes de contar creadores
//  9. Fase 2: calcular oldest_days, newest_days, ads_count como bonus
// 10. Mínimo 3 creadores y 5 vídeos para aprobar producto
// 11. Penalización si oldest_days > 180 (producto viejo)
// 12. Nuevo scoring: 50% creadores / 25% vídeos / 15% views / 10% likes
// 13. Bonus +5 score si hay ≥3 ADs del mismo producto (señal de mercado activo)
// 14. Endpoint /producto/:slug con página HTML de validación
// 15. Cache de vídeos validados por producto para página de detalle
// 16. Dashboard: tabla hashtag ROI (vídeos → identificados → validados)
// 17. Búsqueda Fase 2 solo en inglés / mercado USA
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
// 20 hashtags × 5 vídeos = 100 vídeos — más superficie, más categorías
// Seleccionados por producir productos únicos y vendibles, no hauls ni tutoriales
const QUERIES_CONFIG = [
  // Mascotas — los mejores en runs anteriores
  { query: '#petproducts',       videos: 5 },
  { query: '#petgadgets',        videos: 5 },
  { query: '#dogproducts',       videos: 5 },
  { query: '#dogmusthaves',      videos: 5 },
  { query: '#cattok',            videos: 5 },
  // Cocina — alta conversión
  { query: '#kitchengadgets',    videos: 5 },
  { query: '#kitchenfinds',      videos: 5 },
  { query: '#cookinggadgets',    videos: 5 },
  { query: '#kitchenmusthaves',  videos: 5 },
  // Hogar/organización — orientados a producto único
  { query: '#homeorganization',  videos: 5 },
  { query: '#storageideas',      videos: 5 },
  { query: '#storagehacks',      videos: 5 },
  { query: '#closetorganization',videos: 5 },
  // Tech/gadgets — nicho con ticket alto
  { query: '#techgadgets',       videos: 5 },
  { query: '#desksetup',         videos: 5 },
  // Compra directa — exploración secundaria
  { query: '#tiktokmademebuyit', videos: 5 },
  { query: '#amazonfinds',       videos: 5 },
  { query: '#productfinds',      videos: 5 },
  // Fitness/belleza — categorías emergentes
  { query: '#fitnessgadgets',    videos: 5 },
  { query: '#beautyfinds',       videos: 5 },
];

const FILTROS = {
  min_views: 50000,
  min_likes: 1000,
  min_fans: 500,
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
const FASE2_MIN_VIDEOS = 5;            // mínimo vídeos virales para aprobar
const FASE2_MIN_CREATORS = 3;          // mínimo creadores distintos para aprobar
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

    // Prompt mejorado (cambio 3): descartar hauls + canonical para matching exacto en Fase 2
    const prompt = `You are analyzing TikTok videos to find single winning dropshipping products.

Videos:
${JSON.stringify(adsJson, null, 2)}

RULES — read carefully:
1. Identify the ONE specific physical product being promoted or demonstrated.
2. Be VERY specific: "Silicone Sink Mat" not "Kitchen Tool", "Dog Seat Belt" not "Pet Safety".
3. Set product = "unknown" if ANY of these apply:
   - HAUL: video shows MORE THAN 3 different products (e.g. "Top 10 Amazon Finds", "Kitchen Gadgets Haul", "Travel Essentials")
   - TUTORIAL: how-to, recipe, cleaning tips, life hack with no specific product to buy
   - LIFESTYLE: dancing, vlog, motivation, no product
   - TOO VAGUE: "home gadget", "cool product", "must have item" without specifying what it is
4. canonical: lowercase snake_case identifier for the product. Examples:
   - "Cold Press Juicer" → "cold_press_juicer"
   - "Dog Seat Belt" → "dog_seat_belt"
   - "Portable Dog Water Bottle" → "portable_dog_water_bottle"
   - unknown → "unknown"
   The canonical must capture the FULL product identity, not just one word.
5. specificityScore: 90=exact named product, 70=clear product type, 50=vague category, 0=haul/unknown
6. confidence: how sure you are this is ONE buyable product

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

  for (const v of videos) {
    const raw = productMap[String(v.id)];
    if (!raw || raw.product === 'unknown' || raw.confidence < 0.6 || (raw.specificityScore || 0) < 60) continue;

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
    // Condición: ≥2 hashtags distintos AND ≥2 creadores distintos AND ≥3 vídeos
    // La condición de vídeos evita confirmar con señales muy débiles (1 vídeo por hashtag)
    const fase2A_ok = ht >= 2 && c >= 2 && vv >= 3;

    const label2A = ht >= 4 ? '✓✓✓✓ CONFIRMADO (4+ hashtags)'
                  : ht === 3 ? '✓✓✓ CONFIRMADO (3 hashtags)'
                  : ht === 2 ? '✓✓ CONFIRMADO (2 hashtags)'
                  : '~ SEÑAL (1 hashtag → Fase 2B)';

    console.log(`  ${label2A} | ${g.product_name}: ${vv}v ${c}c ${ht}ht ${g.total_views.toLocaleString()}V score=${obj.score}`);

    if (fase2A_ok) {
      confirmados2A.push({ ...obj, label: 'Confirmado', fase2a: true });
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
    videoSearchSorting: 'MOST_VIEWED',        // cambio 7: más fiable que MOST_LIKED
    videoSearchDateFilter: 'PAST_3_MONTHS',   // cambio 7: captura más virales recientes
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
  status: 'ok', version: 'v8.0',
  fase1: QUERIES_CONFIG,
  filtros: FILTROS,
  fase2: { videos_por_producto: FASE2_VIDEOS_POR_PRODUCTO, min_videos: FASE2_MIN_VIDEOS, min_creators: FASE2_MIN_CREATORS },
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
        const toValidate = senales.slice(0, 10);
        const remaining = senales.slice(10);
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

app.listen(PORT, () => {
  console.log(`[SERVER] Cazador v8.2 en puerto ${PORT}`);
  console.log(`[FASE1] ${QUERIES_CONFIG.length} hashtags × 5 vídeos = ${QUERIES_CONFIG.length * 5} vídeos`);
  console.log(`[FILTROS] views>=${FILTROS.min_views} | likes>=${FILTROS.min_likes} | fans>=${FILTROS.min_fans} | ADs: filtro propio`);
  console.log(`[FASE2] ${FASE2_VIDEOS_POR_PRODUCTO}v/producto | min ${FASE2_MIN_VIDEOS}v ${FASE2_MIN_CREATORS}c | penaliza >${FASE2_PENALIZE_DAYS}d`);
  console.log(`[SCORING] 50%creadores 25%videos 15%views 10%likes +5bonus(≥3ADs) -30%(>180d)`);
  console.log(`[MATCHING] canonical exacto + Fase2A gratis (cruce hashtags) + Fase2B filtro duro`);
});
