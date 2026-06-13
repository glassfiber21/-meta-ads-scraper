// FASE 1 — 5 queries semánticas × 20 vídeos = 100 vídeos orientados a producto
// Sin filtros en Apify — filtramos nosotros en backend

const express = require('express');
const app = express();
app.use(require('cors')({ origin: '*' }));

const PORT = process.env.PORT || 3000;
const APIFY_API_KEY = process.env.APIFY_API_KEY || '';

// 5 queries semánticas orientadas a compra × 20 vídeos c/u = 100 vídeos
const QUERIES = [
  'amazon finds',
  'home essentials',
  'kitchen gadgets',
  'pet products',
  'travel essentials'
];
const VIDEOS_PER_QUERY = 20;

const jobs = {};
function createJob() {
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  jobs[id] = { status: 'running', progress: 'Iniciando...', result: null };
  return id;
}
function updateJob(id, data) { if (jobs[id]) Object.assign(jobs[id], data); }

async function scrapeQuery(query, n) {
  console.log(`[SCRAPE] "${query}" × ${n} vídeos`);

  const input = {
    searchQueries: [query],
    searchSection: '/video',
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
  console.log(`  [APIFY] Run: ${runId}`);

  let status = 'RUNNING', attempts = 0;
  while (status === 'RUNNING' && attempts < 120) {
    await new Promise(r => setTimeout(r, 5000));
    const s = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, {
      headers: { 'Authorization': `Bearer ${APIFY_API_KEY}` }
    });
    status = (await s.json()).data?.status;
    attempts++;
    console.log(`  [APIFY] "${query}": ${status} (${attempts * 5}s)`);
    if (status !== 'RUNNING') break;
  }

  if (status !== 'SUCCEEDED') throw new Error(`"${query}" terminó: ${status}`);

  const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?limit=50`, {
    headers: { 'Authorization': `Bearer ${APIFY_API_KEY}` }
  });
  const items = await itemsRes.json();
  console.log(`  [OK] "${query}": ${items.length} vídeos`);
  return items;
}

app.get('/health', (req, res) => res.json({
  status: 'ok',
  version: 'FASE1-SEMANTICA v1.0',
  config: {
    queries: QUERIES,
    videos_por_query: VIDEOS_PER_QUERY,
    total_objetivo: QUERIES.length * VIDEOS_PER_QUERY,
    filtro_apify: 'NINGUNO',
    filtro_backend: 'likes>=500 OR views>=10000'
  }
}));

app.get('/fase1', async (req, res) => {
  const jobId = createJob();
  res.json({ success: true, job_id: jobId, message: `Lanzando ${QUERIES.length} queries × ${VIDEOS_PER_QUERY} vídeos` });

  (async () => {
    try {
      const allVideos = [];

      // Lanzar queries SECUENCIALMENTE para no saturar Apify
      for (let i = 0; i < QUERIES.length; i++) {
        const query = QUERIES[i];
        updateJob(jobId, { progress: `[${i+1}/${QUERIES.length}] Scrapeando "${query}"...` });
        try {
          const videos = await scrapeQuery(query, VIDEOS_PER_QUERY);
          allVideos.push(...videos);
        } catch(e) {
          console.error(`[ERROR] "${query}":`, e.message);
          // Continuar con las demás queries aunque una falle
        }
      }

      const total = allVideos.length;
      console.log(`\n[TOTAL] ${total} vídeos recibidos de ${QUERIES.length} queries`);

      // Estadísticas por query
      const porQuery = {};
      allVideos.forEach(v => {
        const q = v.searchQuery || 'unknown';
        porQuery[q] = (porQuery[q] || 0) + 1;
      });

      // Filtro backend: virales
      const virales = allVideos.filter(v => (v.diggCount||0) >= 500 || (v.playCount||0) >= 10000);

      // Distribución de likes
      const dist = {
        '0':       allVideos.filter(v => (v.diggCount||0) === 0).length,
        '1-99':    allVideos.filter(v => (v.diggCount||0) >= 1 && (v.diggCount||0) < 100).length,
        '100-499': allVideos.filter(v => (v.diggCount||0) >= 100 && (v.diggCount||0) < 500).length,
        '500-999': allVideos.filter(v => (v.diggCount||0) >= 500 && (v.diggCount||0) < 1000).length,
        '1k-9k':   allVideos.filter(v => (v.diggCount||0) >= 1000 && (v.diggCount||0) < 10000).length,
        '10k-99k': allVideos.filter(v => (v.diggCount||0) >= 10000 && (v.diggCount||0) < 100000).length,
        '100k+':   allVideos.filter(v => (v.diggCount||0) >= 100000).length,
      };

      const pct = Math.round(virales.length / total * 100);
      const veredicto = pct >= 60 ? 'EXCELENTE' : pct >= 40 ? 'BUENO' : pct >= 20 ? 'ACEPTABLE' : 'MEJORABLE';

      console.log('=== RESULTADO ===');
      console.log(`Por query: ${JSON.stringify(porQuery)}`);
      console.log(`Virales (>=500L o >=10kV): ${virales.length}/${total} (${pct}%) → ${veredicto}`);
      console.log(`Distribución likes: ${JSON.stringify(dist)}`);

      // Top 15 virales
      const top15 = [...allVideos]
        .sort((a,b) => (b.playCount||0) - (a.playCount||0))
        .slice(0, 15)
        .map(v => ({
          query: v.searchQuery,
          likes: v.diggCount || 0,
          views: v.playCount || 0,
          author: v.authorMeta?.name,
          text: (v.text||'').slice(0, 80).replace(/\n/g,' ')
        }));

      updateJob(jobId, {
        status: 'done',
        result: {
          total,
          por_query: porQuery,
          distribucion_likes: dist,
          virales_count: virales.length,
          virales_pct: pct,
          veredicto,
          top15_por_views: top15,
          // Dataset completo para alimentar al cazador
          videos: allVideos
        }
      });

    } catch(e) {
      console.error('[FASE1] ERROR GENERAL:', e.message);
      updateJob(jobId, { status: 'error', result: { error: e.message } });
    }
  })();
});

app.get('/job-status/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job no encontrado' });
  res.json(job);
});

app.listen(PORT, () => {
  console.log(`[SERVER] FASE1-SEMANTICA v1.0 en puerto ${PORT}`);
  console.log(`[CONFIG] ${QUERIES.length} queries × ${VIDEOS_PER_QUERY} vídeos = ${QUERIES.length * VIDEOS_PER_QUERY} objetivo`);
  console.log(`[QUERIES] ${QUERIES.join(' | ')}`);
});
