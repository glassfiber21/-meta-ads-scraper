// ─────────────────────────────────────────────────────────────────────────────
// SERVER FASE 1 — Solo scraping TikTok
// Objetivo: obtener 100 vídeos virales (2 queries × 50, todos >=500 likes)
// Sin Claude, sin agrupación, sin Fase 2
// Cuando este resultado sea perfecto → alimentar al cazador con el JSON
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const APIFY_API_KEY = process.env.APIFY_API_KEY || '';

// Queries de descubrimiento — 2 hashtags × 50 vídeos = 100 vídeos
const FASE1_QUERIES = ['tiktokmademebuyit', 'kitchengadgets'];
const VIDEOS_PER_QUERY = 30; // 30 × 2 queries = 60 vídeos totales
const MIN_LIKES = 500; // filtro de popularidad mínima en Apify

// ── Job queue simple ──────────────────────────────────────────────────────────
const jobs = {};
function createJob() {
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  jobs[id] = { status: 'running', progress: 'Iniciando...', result: null, createdAt: Date.now() };
  return id;
}
function updateJob(id, data) {
  if (jobs[id]) Object.assign(jobs[id], data);
}

// ── Scraping Apify ────────────────────────────────────────────────────────────
async function scrapeTikTok(queries, videosPerQuery) {
  console.log(`[FASE1] Lanzando Apify: ${queries.join(', ')} × ${videosPerQuery} vídeos | min_likes: ${MIN_LIKES}`);

  const input = {
    searchQueries: queries,
    searchSection: '/video',
    videoSearchDateFilter: 'PAST_MONTH',
    videoSearchSorting: 'MOST_LIKED',
    videoSearchPopularityFilterMin: MIN_LIKES, // >=500 likes — todos los vídeos serán virales
    resultsPerPage: videosPerQuery,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
    proxyCountryCode: 'US',
    maxRequestRetries: 3
  };

  const runRes = await fetch('https://api.apify.com/v2/acts/clockworks~tiktok-scraper/runs?memory=4096', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${APIFY_API_KEY}` },
    body: JSON.stringify(input)
  });

  console.log('[APIFY] HTTP Status:', runRes.status);
  const runData = await runRes.json();

  if (runRes.status !== 200 && runRes.status !== 201) {
    throw new Error(`Apify error ${runRes.status}: ${JSON.stringify(runData)}`);
  }

  const runId = runData.data?.id;
  const datasetId = runData.data?.defaultDatasetId;
  console.log(`[APIFY] Run iniciado: ${runId} | Dataset: ${datasetId}`);

  // Polling hasta SUCCEEDED (máx 10 min)
  let status = 'RUNNING';
  let attempts = 0;
  while (status === 'RUNNING' && attempts < 120) {
    await new Promise(r => setTimeout(r, 5000));
    const statusRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, {
      headers: { 'Authorization': `Bearer ${APIFY_API_KEY}` }
    });
    const statusData = await statusRes.json();
    status = statusData.data?.status;
    attempts++;
    console.log(`[APIFY] ${status} (${attempts * 5}s)`);
    if (status !== 'RUNNING') break;
  }

  if (status !== 'SUCCEEDED') throw new Error(`Run terminó con estado: ${status}`);

  // Obtener resultados
  const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?limit=200`, {
    headers: { 'Authorization': `Bearer ${APIFY_API_KEY}` }
  });
  const items = await itemsRes.json();

  // Log distribución
  const byQuery = {};
  items.forEach(v => {
    const q = v.searchQuery || 'unknown';
    byQuery[q] = (byQuery[q] || 0) + 1;
  });
  console.log('=== DISTRIBUCIÓN ===');
  Object.entries(byQuery).forEach(([q, n]) => console.log(`  ${q}: ${n} vídeos`));
  console.log(`  TOTAL: ${items.length} vídeos`);

  // Stats de calidad
  const conLikes = items.filter(v => (v.diggCount || 0) >= MIN_LIKES);
  const sinLikes = items.filter(v => (v.diggCount || 0) < MIN_LIKES);
  console.log(`=== CALIDAD ===`);
  console.log(`  Con >= ${MIN_LIKES} likes: ${conLikes.length}`);
  console.log(`  Con < ${MIN_LIKES} likes (no deberían existir): ${sinLikes.length}`);
  if (sinLikes.length > 0) {
    sinLikes.forEach(v => console.log(`    ⚠️ ${v.diggCount}L ${v.playCount}V @${v.authorMeta?.name}`));
  }

  // Log top 10 más virales
  console.log('=== TOP 10 MÁS VIRALES ===');
  [...items].sort((a,b) => (b.playCount||0) - (a.playCount||0)).slice(0, 10).forEach(v => {
    const days = v.createTimeISO ? Math.floor((Date.now() - new Date(v.createTimeISO).getTime()) / 86400000) : '?';
    console.log(`  [${(v.diggCount||0).toLocaleString()}L | ${(v.playCount||0).toLocaleString()}V | ${days}d] @${v.authorMeta?.name} | ${(v.text||'').slice(0,60).replace(/\n/g,' ')}`);
  });

  return items;
}

// ── Endpoints ─────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: 'FASE1-ONLY v1.0',
    config: {
      queries: FASE1_QUERIES,
      videos_per_query: VIDEOS_PER_QUERY,
      total_target: FASE1_QUERIES.length * VIDEOS_PER_QUERY,
      min_likes: MIN_LIKES,
      date_filter: 'PAST_MONTH',
      sort: 'MOST_LIKED'
    }
  });
});

// Lanzar scraping Fase 1
app.get('/fase1', async (req, res) => {
  const jobId = createJob();
  res.json({ success: true, job_id: jobId, message: `Lanzando Apify: ${FASE1_QUERIES.join(' + ')} × ${VIDEOS_PER_QUERY} vídeos c/u | min_likes: ${MIN_LIKES}` });

  (async () => {
    try {
      updateJob(jobId, { progress: `Conectando con TikTok (${FASE1_QUERIES.join(', ')})...` });
      const videos = await scrapeTikTok(FASE1_QUERIES, VIDEOS_PER_QUERY);

      if (!videos.length) {
        updateJob(jobId, { status: 'error', result: { success: false, error: 'Apify no devolvió vídeos' } });
        return;
      }

      // Estadísticas finales
      const stats = {
        total: videos.length,
        por_query: {},
        con_min_likes: videos.filter(v => (v.diggCount||0) >= MIN_LIKES).length,
        sin_min_likes: videos.filter(v => (v.diggCount||0) < MIN_LIKES).length,
        promedio_likes: Math.round(videos.reduce((s,v) => s + (v.diggCount||0), 0) / videos.length),
        promedio_views: Math.round(videos.reduce((s,v) => s + (v.playCount||0), 0) / videos.length),
        max_likes: Math.max(...videos.map(v => v.diggCount||0)),
        max_views: Math.max(...videos.map(v => v.playCount||0)),
        min_likes_real: Math.min(...videos.map(v => v.diggCount||0)),
        antiguedad_max_dias: Math.max(...videos.map(v => {
          if (!v.createTimeISO) return 0;
          return Math.floor((Date.now() - new Date(v.createTimeISO).getTime()) / 86400000);
        })),
      };
      videos.forEach(v => {
        const q = v.searchQuery || 'unknown';
        stats.por_query[q] = (stats.por_query[q] || 0) + 1;
      });

      console.log('=== RESULTADO FINAL ===');
      console.log(JSON.stringify(stats, null, 2));

      updateJob(jobId, {
        status: 'done',
        result: {
          success: true,
          stats,
          // Top 20 vídeos para preview en el cazador
          preview: [...videos]
            .sort((a,b) => (b.playCount||0) - (a.playCount||0))
            .slice(0, 20)
            .map(v => ({
              id: v.id,
              text: (v.text||'').slice(0, 100),
              author: v.authorMeta?.name,
              likes: v.diggCount || 0,
              views: v.playCount || 0,
              days_old: v.createTimeISO ? Math.floor((Date.now() - new Date(v.createTimeISO).getTime()) / 86400000) : null,
              query: v.searchQuery,
              url: v.webVideoUrl
            })),
          // Dataset completo para descargar y alimentar al cazador
          videos
        }
      });
    } catch(e) {
      console.error('[FASE1] ERROR:', e.message);
      updateJob(jobId, { status: 'error', result: { success: false, error: e.message } });
    }
  })();
});

// Estado del job
app.get('/job-status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job no encontrado' });
  res.json(job);
});

// Servir cazador.html
app.get('/cazador', (req, res) => res.sendFile(path.join(__dirname, 'cazador.html')));
app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`[SERVER] FASE1-ONLY v1.0 corriendo en puerto ${PORT}`);
  console.log(`[CONFIG] Queries: ${FASE1_QUERIES.join(', ')} | Videos/query: ${VIDEOS_PER_QUERY} | Min likes: ${MIN_LIKES}`);
  console.log(`[CONFIG] Target: ${FASE1_QUERIES.length * VIDEOS_PER_QUERY} vídeos | Filtro: PAST_MONTH + MOST_LIKED + >=500 likes`);
});
