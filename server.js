// ─────────────────────────────────────────────────────────────────────────────
// CAZADOR v7.0 — Pipeline completo Fase 1 + Fase 2
// Fase 1: scrape hashtags → filtrar → Claude identifica productos → agrupar
// Fase 2: productos únicos → buscar por nombre en TikTok → confirmar
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
// 10 hashtags × 10 vídeos = 100 vídeos
// Seleccionados por dar producto único (no hauls) y alta viralidad
const QUERIES_CONFIG = [
  { query: '#kitchengadgets',    videos: 10 },
  { query: '#kitchenfinds',      videos: 10 },
  { query: '#petproducts',       videos: 10 },
  { query: '#petgadgets',        videos: 10 },
  { query: '#dogproducts',       videos: 10 },
  { query: '#homeorganization',  videos: 10 },
  { query: '#organizationideas', videos: 10 },
  { query: '#gadgets',           videos: 10 },
  { query: '#cleaningtips',      videos: 10 },
  { query: '#homehacks',         videos: 10 },
];

const FILTROS = {
  min_views: 50000,    // vídeos con menos de 50k views → descartados
  min_likes: 1000,     // OR más de 1000 likes
  min_fans: 500,       // cuentas con menos de 500 fans → spam
  exclude_ads: true,   // excluir anuncios pagados
};

const FASE2_MIN_VIDEOS = 2;    // mínimo vídeos virales para confirmar producto
const FASE2_MIN_CREATORS = 2;  // mínimo creadores distintos

// ── Job queue ─────────────────────────────────────────────────────────────────
const jobs = {};
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
    proxyCountryCode: 'US'
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
  // Anotar el hashtag de origen
  items.forEach(v => { v._sourceHashtag = `#${slug}`; });
  console.log(`  [OK] #${slug}: ${items.length} vídeos`);
  return items;
}

// ── Filtros backend ───────────────────────────────────────────────────────────
function filtrarVideos(videos) {
  const antes = videos.length;
  const filtrados = videos.filter(v => {
    const views = v.playCount || 0;
    const likes = v.diggCount || 0;
    const fans = v.authorMeta?.fans || v.authorMeta?.followers || 0;
    const isAd = v.isSponsored || v.isAd || false;

    if (FILTROS.exclude_ads && isAd) return false;
    if (fans < FILTROS.min_fans) return false;
    if (views < FILTROS.min_views && likes < FILTROS.min_likes) return false;
    return true;
  });

  console.log(`[FILTRO] ${antes} → ${filtrados.length} vídeos (descartados: ${antes - filtrados.length})`);
  console.log(`  Ads: ${videos.filter(v=>v.isSponsored||v.isAd).length} | Fans<500: ${videos.filter(v=>(v.authorMeta?.fans||0)<500).length} | Views<50k: ${videos.filter(v=>(v.playCount||0)<50000&&(v.diggCount||0)<1000).length}`);
  return filtrados;
}

// ── Claude: identificar productos ────────────────────────────────────────────
async function identificarProductos(videos) {
  const batchSize = 25;
  const productMap = {};

  for (let i = 0; i < videos.length; i += batchSize) {
    const batch = videos.slice(i, i + batchSize);
    const adsJson = batch.map(v => ({
      id: String(v.id || i),
      text: ((v.text || '') + ' ' + (v.hashtags || []).map(h => typeof h === 'string' ? h : h.name || '').join(' ')).slice(0, 300)
    }));

    const prompt = `Analyze these TikTok videos. For each, identify the ONE specific physical product being shown.

Videos:
${JSON.stringify(adsJson, null, 2)}

RULES:
- ONE specific product per video (e.g. "Garlic Press", "Silicone Sink Mat", "Dog Water Bottle")
- If it's a HAUL (shows multiple products) → "unknown"
- If it's lifestyle/tutorial/dance with no specific product → "unknown"
- Be specific: "Rotating Spice Rack" not "Kitchen Organizer"
- specificityScore: 90=very specific single product, 60=specific but vague, 30=category, 0=haul/unknown

Reply ONLY with JSON array:
[{"id":"<id>","product":"<name or unknown>","confidence":<0.0-1.0>,"specificityScore":<0-100>}]`;

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
        parsed.forEach(item => { productMap[String(item.id)] = item; });
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

    const key = raw.product.toLowerCase().trim();
    if (!groups[key]) {
      groups[key] = {
        product_name: raw.product,
        videos: [],
        creators: new Set(),
        total_views: 0,
        total_likes: 0,
        newest_days: null,
        hashtags: new Set(),
      };
    }

    const g = groups[key];
    g.videos.push(v);
    g.creators.add(v.authorMeta?.name || '');
    g.total_views += v.playCount || 0;
    g.total_likes += v.diggCount || 0;
    g.hashtags.add(v._sourceHashtag || '');

    const ct = v.createTimeISO;
    if (ct) {
      try {
        const days = Math.floor((Date.now() - new Date(ct).getTime()) / 86400000);
        if (g.newest_days === null || days < g.newest_days) g.newest_days = days;
      } catch(e) {}
    }
  }

  // Separar: confirmados (2+ vídeos, 2+ creadores) vs señales únicas
  const confirmados = [];
  const senales = [];

  for (const g of Object.values(groups)) {
    const vv = g.videos.length;
    const c = g.creators.size;
    const obj = {
      product_name: g.product_name,
      video_count: vv,
      creator_count: c,
      total_views: g.total_views,
      total_likes: g.total_likes,
      newest_days: g.newest_days,
      hashtags: Array.from(g.hashtags),
      tiktok_url: `https://www.tiktok.com/search?q=${encodeURIComponent(g.product_name)}&t=video&sort_type=1&publish_time=90`,
    };

    console.log(`  ${vv>=2&&c>=2?'✓':'~'} ${g.product_name}: ${vv}v ${c}c ${g.total_views.toLocaleString()}V`);

    if (vv >= FASE2_MIN_VIDEOS && c >= FASE2_MIN_CREATORS) {
      confirmados.push({ ...obj, label: 'Trending' });
    } else {
      senales.push({ ...obj, label: 'Señal' });
    }
  }

  confirmados.sort((a,b) => b.total_views - a.total_views);
  senales.sort((a,b) => b.total_views - a.total_views);

  console.log(`[GRUPOS] Confirmados: ${confirmados.length} | Señales únicas: ${senales.length}`);
  return { confirmados, senales };
}


// Buscar por nombre de producto (Fase 2) — usa searchQueries, no hashtags
async function scrapeByName(productName, n) {
  console.log(`[FASE2] Buscando: "${productName}" × ${n} vídeos`);

  const input = {
    searchQueries: [productName],
    searchSection: '/video',
    videoSearchSorting: 'MOST_LIKED',
    videoSearchDateFilter: 'PAST_MONTH',
    resultsPerPage: n,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
    proxyCountryCode: 'US'
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

// ── Fase 2: validar señales únicas ───────────────────────────────────────────
async function validarSenal(senal, productMap) {
  console.log(`[FASE2] Buscando: "${senal.product_name}" (${senal.total_views.toLocaleString()} views)`);

  try {
    // Buscar 20 vídeos del producto por nombre
    const videos = await scrapeByName(senal.product_name, 20);
    if (!videos.length) { console.log(`  Sin resultados`); return null; }

    // Identificar productos en estos 20 vídeos
    const newMap = await identificarProductos(videos);

    // Contar confirmaciones del mismo producto
    const now = Date.now();
    const confirming = videos.filter(v => {
      const p = newMap[String(v.id)];
      if (!p || p.product === 'unknown') return false;
      const norm = p.product.toLowerCase();
      const target = senal.product_name.toLowerCase();
      return norm.includes(target.split(' ')[0]) || target.includes(norm.split(' ')[0]);
    });

    const viral = confirming.filter(v => {
      const days = v.createTimeISO ? Math.floor((now - new Date(v.createTimeISO).getTime()) / 86400000) : 999;
      return ((v.diggCount||0) >= 1000 || (v.playCount||0) >= 50000) && days <= 90;
    });

    const creators = new Set(confirming.map(v => v.authorMeta?.name || '')).size;

    console.log(`  ${viral.length}vv | ${creators}c → ${viral.length>=2&&creators>=2?'✓ PROMOVIDO':'✗ DESCARTADO'}`);

    if (viral.length >= FASE2_MIN_VIDEOS && creators >= FASE2_MIN_CREATORS) {
      return {
        ...senal,
        label: 'Validado',
        fase2_viral_count: viral.length,
        fase2_creator_count: creators,
        video_count: senal.video_count + viral.length,
        creator_count: senal.creator_count + creators,
      };
    }
  } catch(e) {
    console.error(`  Error: ${e.message}`);
  }
  return null;
}

// ── Endpoint principal ────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status: 'ok', version: 'v7.0',
  fase1: QUERIES_CONFIG,
  filtros: FILTROS,
  fase2: { min_videos: FASE2_MIN_VIDEOS, min_creators: FASE2_MIN_CREATORS }
}));

app.get('/buscar', async (req, res) => {
  const jobId = createJob();
  res.json({ success: true, job_id: jobId });

  (async () => {
    try {
      // ── FASE 1: Scraping ────────────────────────────────────────────────────
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

      // Filtrar
      const filtrados = filtrarVideos(rawVideos);
      updateJob(jobId, { progress: `${filtrados.length} vídeos filtrados. Claude identificando productos...` });

      // ── Claude: identificar productos ───────────────────────────────────────
      const productMap = await identificarProductos(filtrados);

      // ── Agrupar ─────────────────────────────────────────────────────────────
      updateJob(jobId, { progress: 'Agrupando productos...' });
      console.log('\n=== AGRUPACIÓN ===');
      const { confirmados, senales } = agrupar(filtrados, productMap);

      // ── FASE 2: Validar señales únicas (máx 10) ─────────────────────────────
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
          const resultado = await validarSenal(senal, productMap);
          if (resultado) validados.push(resultado);
        }
      }

      // ── Resultado final ──────────────────────────────────────────────────────
      const todos = [
        ...confirmados,
        ...validados,
      ].sort((a,b) => b.total_views - a.total_views);

      console.log(`\n[DONE] ${todos.length} productos (${confirmados.length} directos + ${validados.length} validados)`);

      updateJob(jobId, {
        status: 'done',
        result: {
          success: true,
          total: todos.length,
          confirmados_directos: confirmados.length,
          validados_fase2: validados.length,
          senales_pendientes: pendientes.length,
          productos: todos,
          pending_signals: pendientes,
          stats: {
            videos_scrapeados: rawVideos.length,
            videos_filtrados: filtrados.length,
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

app.get('/cazador', (req, res) => res.sendFile(path.join(__dirname, 'cazador.html')));
app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`[SERVER] Cazador v7.0 en puerto ${PORT}`);
  console.log(`[FASE1] ${QUERIES_CONFIG.map(q=>`${q.query}×${q.videos}`).join(' | ')}`);
  console.log(`[FILTROS] views>=${FILTROS.min_views} | likes>=${FILTROS.min_likes} | fans>=${FILTROS.min_fans} | ads=${FILTROS.exclude_ads?'excluidos':'incluidos'}`);
});
