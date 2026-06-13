// TEST DE CALIDAD DEL ACTOR
// #tiktokmademebuyit × 100 vídeos × últimos 30 días
// SIN NINGÚN FILTRO ADICIONAL

const express = require('express');
const app = express();
app.use(require('cors')({ origin: '*' }));

const PORT = process.env.PORT || 3000;
const APIFY_API_KEY = process.env.APIFY_API_KEY || '';

const jobs = {};
function createJob() {
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  jobs[id] = { status: 'running', progress: 'Iniciando...', result: null };
  return id;
}
function updateJob(id, data) { if (jobs[id]) Object.assign(jobs[id], data); }

async function scrape() {
  const input = {
    searchQueries: ['tiktokmademebuyit'],
    searchSection: '/video',
    videoSearchDateFilter: 'PAST_MONTH',
    resultsPerPage: 100,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
    proxyCountryCode: 'US'
  };

  console.log('[TEST] Input Apify:', JSON.stringify(input, null, 2));

  const runRes = await fetch('https://api.apify.com/v2/acts/clockworks~tiktok-scraper/runs?memory=4096', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${APIFY_API_KEY}` },
    body: JSON.stringify(input)
  });

  console.log('[APIFY] HTTP Status:', runRes.status);
  const runData = await runRes.json();
  if (runRes.status !== 200 && runRes.status !== 201) {
    throw new Error(`Apify ${runRes.status}: ${JSON.stringify(runData)}`);
  }

  const runId = runData.data?.id;
  const datasetId = runData.data?.defaultDatasetId;
  console.log(`[APIFY] Run: ${runId} | Dataset: ${datasetId}`);

  let status = 'RUNNING', attempts = 0;
  while (status === 'RUNNING' && attempts < 120) {
    await new Promise(r => setTimeout(r, 5000));
    const s = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, {
      headers: { 'Authorization': `Bearer ${APIFY_API_KEY}` }
    });
    status = (await s.json()).data?.status;
    attempts++;
    console.log(`[APIFY] ${status} (${attempts * 5}s)`);
    if (status !== 'RUNNING') break;
  }

  if (status !== 'SUCCEEDED') throw new Error(`Run terminó: ${status}`);

  const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?limit=200`, {
    headers: { 'Authorization': `Bearer ${APIFY_API_KEY}` }
  });
  return await itemsRes.json();
}

app.get('/health', (req, res) => res.json({
  status: 'ok',
  config: { query: 'tiktokmademebuyit', videos: 100, date: 'PAST_MONTH', filtros: 'NINGUNO' }
}));

app.get('/test', async (req, res) => {
  const jobId = createJob();
  res.json({ success: true, job_id: jobId });

  (async () => {
    try {
      updateJob(jobId, { progress: 'Scrapeando #tiktokmademebuyit × 100 vídeos...' });
      const videos = await scrape();

      const total = videos.length;

      // Medir cuántos sobreviven con >=500 likes
      const dist = {
        '0_likes':       videos.filter(v => (v.diggCount||0) === 0).length,
        '1_a_99':        videos.filter(v => (v.diggCount||0) >= 1    && (v.diggCount||0) < 100).length,
        '100_a_499':     videos.filter(v => (v.diggCount||0) >= 100  && (v.diggCount||0) < 500).length,
        '500_a_999':     videos.filter(v => (v.diggCount||0) >= 500  && (v.diggCount||0) < 1000).length,
        '1k_a_9k':       videos.filter(v => (v.diggCount||0) >= 1000 && (v.diggCount||0) < 10000).length,
        '10k_a_99k':     videos.filter(v => (v.diggCount||0) >= 10000 && (v.diggCount||0) < 100000).length,
        '100k_mas':      videos.filter(v => (v.diggCount||0) >= 100000).length,
      };
      const sobreviven = videos.filter(v => (v.diggCount||0) >= 500).length;
      const pct = Math.round(sobreviven / total * 100);
      const veredicto = sobreviven >= 60 ? 'ACTOR BUENO' : sobreviven >= 20 ? 'ACTOR ACEPTABLE' : 'ACTOR MALO';

      console.log('=== RESULTADO ===');
      console.log(`Total: ${total}`);
      Object.entries(dist).forEach(([k,v]) => console.log(`  ${k}: ${v}`));
      console.log(`SOBREVIVEN >=500 likes: ${sobreviven}/${total} (${pct}%) → ${veredicto}`);

      const top10 = [...videos]
        .sort((a,b) => (b.diggCount||0) - (a.diggCount||0))
        .slice(0, 10)
        .map(v => ({
          likes: v.diggCount || 0,
          views: v.playCount || 0,
          author: v.authorMeta?.name,
          text: (v.text||'').slice(0, 80).replace(/\n/g,' ')
        }));

      updateJob(jobId, {
        status: 'done',
        result: { total, distribucion: dist, sobreviven_500: sobreviven, porcentaje: pct, veredicto, top10, videos }
      });
    } catch(e) {
      console.error('[TEST] ERROR:', e.message);
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
  console.log(`[SERVER] Test calidad actor en puerto ${PORT}`);
  console.log(`[CONFIG] tiktokmademebuyit | 100 vídeos | PAST_MONTH | SIN FILTROS`);
});
