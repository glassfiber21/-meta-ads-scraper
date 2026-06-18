// ────────────────────────────────────────────────────────────────────────
// CAPA GOOGLE TRENDS — endpoint de test aislado
// Actor: data_xplorer/google-trends-fast-scraper (ID: nWhM7vTPu16lcwuIg)
// Objetivo: validar formato real de input/output antes de integrar en server.js
// ────────────────────────────────────────────────────────────────────────

const express = require('express');
const app = express();
app.use(require('cors')({ origin: '*' }));
app.use(express.json());

const PORT = process.env.PORT || 3001;
const APIFY_API_KEY = process.env.APIFY_API_KEY || '';
const TRENDS_ACTOR_ID = 'nWhM7vTPu16lcwuIg'; // data_xplorer/google-trends-fast-scraper

if (!APIFY_API_KEY) {
  console.warn('[WARN] APIFY_API_KEY no está definida. El endpoint fallará al llamar a Apify.');
}

// ── Llamada al actor de Apify (mismo patrón que scrapeHashtag en server.js) ──
async function runTrendsActor(input) {
  console.log(`[TRENDS] Lanzando actor con input:`, JSON.stringify(input));

  const runRes = await fetch(`https://api.apify.com/v2/acts/${TRENDS_ACTOR_ID}/runs?memory=1024`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${APIFY_API_KEY}` },
    body: JSON.stringify(input)
  });

  if (runRes.status !== 200 && runRes.status !== 201) {
    const err = await runRes.text();
    throw new Error(`Apify ${runRes.status} al arrancar run: ${err}`);
  }

  const runData = await runRes.json();
  const runId = runData.data?.id;
  const datasetId = runData.data?.defaultDatasetId;

  if (!runId || !datasetId) {
    throw new Error(`Respuesta de Apify sin runId/datasetId: ${JSON.stringify(runData)}`);
  }

  console.log(`[TRENDS] Run ${runId} arrancado, esperando...`);

  // Polling igual que en server.js: cada 5s, máx 120 intentos (~10 min)
  let status = 'RUNNING', attempts = 0;
  while (status === 'RUNNING' && attempts < 120) {
    await new Promise(r => setTimeout(r, 5000));
    const s = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, {
      headers: { 'Authorization': `Bearer ${APIFY_API_KEY}` }
    });
    const sData = await s.json();
    status = sData.data?.status;
    attempts++;
    console.log(`[TRENDS]   intento ${attempts}: ${status}`);
    if (status !== 'RUNNING' && status !== 'READY') break;
  }

  if (status !== 'SUCCEEDED') {
    throw new Error(`Run terminó con estado: ${status} (tras ${attempts} intentos)`);
  }

  const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?limit=200`, {
    headers: { 'Authorization': `Bearer ${APIFY_API_KEY}` }
  });
  const items = await itemsRes.json();
  console.log(`[TRENDS] Dataset leído: ${items.length} items`);
  return items;
}

// ── Endpoint de test: dispara los DOS runs (90d y 12m) para una keyword ─────
app.get('/test-trends', async (req, res) => {
  const keyword = req.query.keyword || 'bitcoin';
  const geo = req.query.geo || 'US';

  try {
    console.log(`\n[TEST] === Probando keyword "${keyword}" (geo=${geo}) ===`);

    const baseInput = {
      enableTrendingSearches: false,
      keyword: keyword,
      geo: geo,
      fetchRegionalData: false,
      proxyConfiguration: { useApifyProxy: true }
    };

    // Dos runs secuenciales (no en paralelo, para ver logs claros en este test)
    const data90d = await runTrendsActor({ ...baseInput, predefinedTimeframe: 'today 3-m' });
    const data12m = await runTrendsActor({ ...baseInput, predefinedTimeframe: 'today 12-m' });

    res.json({
      keyword,
      geo,
      raw_90d: data90d,
      raw_12m: data12m,
      // Conteos para verificar el pricing real ($2/1000 resultados)
      count_90d: data90d.length,
      count_12m: data12m.length
    });

  } catch (err) {
    console.error('[TEST] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', actor: TRENDS_ACTOR_ID }));

app.listen(PORT, () => {
  console.log(`[TRENDS-TEST] Escuchando en puerto ${PORT}`);
  console.log(`[TRENDS-TEST] Prueba: GET /test-trends?keyword=dog+cooling+mat&geo=US`);
});
