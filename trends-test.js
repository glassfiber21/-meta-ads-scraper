// ────────────────────────────────────────────────────────────────────────
// CAPA GOOGLE TRENDS — endpoint de test aislado
// Actor: data_xplorer/google-trends-fast-scraper (ID: nWhM7vTPu16lcwuIg)
// Objetivo: validar formato real de input/output antes de integrar en server.js
// ────────────────────────────────────────────────────────────────────────

const express = require('express');
const path = require('path');
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

// ── Helpers de clasificación ──────────────────────────────────────────────

// Extrae [{date, value, isPartial}] ordenado por fecha desde el formato real del actor
function parseTimelineItem(rawItem) {
  if (!rawItem || !rawItem.timeline_data) return { points: [], granularity: null };
  const keywordKey = Object.keys(rawItem.timeline_data).find(k => k !== 'isPartial');
  const values = rawItem.timeline_data[keywordKey] || {};
  const partials = rawItem.timeline_data.isPartial || {};
  const points = Object.keys(values)
    .sort() // las claves son fechas ISO "YYYY-MM-DD", el orden alfabético = orden cronológico
    .map(date => ({ date, value: values[date], isPartial: !!partials[date] }));
  return { points, granularity: rawItem.data_granularity || null };
}

// Compara la media de la 1ª mitad vs la 2ª mitad de la serie (excluyendo isPartial)
// Umbral de 15% para evitar que ruido pequeño se lea como "tendencia"
function classifyTrend(points) {
  const clean = points.filter(p => !p.isPartial);
  if (clean.length < 4) return { trend: 'Plano', reason: 'datos insuficientes' };

  const mid = Math.floor(clean.length / 2);
  const firstHalf = clean.slice(0, mid);
  const secondHalf = clean.slice(mid);

  const avg = arr => arr.reduce((s, p) => s + p.value, 0) / arr.length;
  const avg1 = avg(firstHalf);
  const avg2 = avg(secondHalf);

  // Evita división por cero cuando el interés histórico es 0
  if (avg1 === 0 && avg2 === 0) return { trend: 'Plano', avg1, avg2 };
  if (avg1 === 0) return { trend: 'Subiendo', avg1, avg2 }; // de 0 a algo siempre es subida

  const change = (avg2 - avg1) / avg1;
  if (change > 0.15) return { trend: 'Subiendo', avg1, avg2, change };
  if (change < -0.15) return { trend: 'Bajando', avg1, avg2, change };
  return { trend: 'Plano', avg1, avg2, change };
}

// Heurística de estacionalidad: agrupa por mes, busca una franja continua de
// meses con valores muy por encima de la media del resto del año.
// NOTA: con solo 12 meses de datos esto es una aproximación, no una detección
// multi-año real. Sirve como señal orientativa, no como verdad definitiva.
function detectSeasonality(points12m) {
  const clean = points12m.filter(p => !p.isPartial);
  if (clean.length < 8) return { seasonal: false, strongMonths: [] };

  const monthNames = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const byMonth = {}; // 0-11 → [values]
  clean.forEach(p => {
    const m = new Date(p.date).getUTCMonth();
    if (!byMonth[m]) byMonth[m] = [];
    byMonth[m].push(p.value);
  });

  const monthAvgs = Object.entries(byMonth).map(([m, vals]) => ({
    month: parseInt(m, 10),
    avg: vals.reduce((s, v) => s + v, 0) / vals.length
  }));

  const overallAvg = monthAvgs.reduce((s, m) => s + m.avg, 0) / monthAvgs.length;
  if (overallAvg === 0) return { seasonal: false, strongMonths: [] };

  // Meses "fuertes" = al menos 40% por encima de la media anual
  const strong = monthAvgs.filter(m => m.avg > overallAvg * 1.4).sort((a, b) => a.month - b.month);

  // Solo lo llamamos estacional si hay una concentración real (1-5 meses fuertes,
  // no todo el año disperso) — si casi todos los meses son "fuertes" no hay señal útil
  const seasonal = strong.length > 0 && strong.length <= 5;

  return {
    seasonal,
    strongMonths: seasonal ? strong.map(m => monthNames[m.month]) : []
  };
}

// Encuentra el punto de valor máximo dentro de la ventana de 12 meses
// (excluyendo isPartial, ya que esa semana puede no estar completa todavía)
function findAnnualPeak(points12m) {
  const clean = points12m.filter(p => !p.isPartial);
  if (clean.length === 0) return null;

  const peak = clean.reduce((max, p) => (p.value > max.value ? p : max), clean[0]);
  return { date: peak.date, value: peak.value };
}

function buildSummary(trend90, trend12, seasonality) {
  const down12 = trend12.trend === 'Bajando';

  let semaforo = 'amarillo';
  if (trend12.trend !== 'Bajando' && trend90.trend !== 'Bajando') semaforo = 'verde';
  if (down12 && trend90.trend === 'Bajando') semaforo = 'rojo';

  let interpretacion;
  if (semaforo === 'verde' && seasonality.seasonal) {
    interpretacion = `Interés en crecimiento con fuerte componente estacional (meses fuertes: ${seasonality.strongMonths.join(', ')}).`;
  } else if (semaforo === 'verde') {
    interpretacion = 'Interés en crecimiento o estable, sin estacionalidad marcada.';
  } else if (semaforo === 'rojo') {
    interpretacion = 'Interés cayendo en ambas ventanas. No descarta el producto, pero requiere atención.';
  } else {
    interpretacion = 'Señales mixtas entre el corto y el largo plazo. Revisar con cautela.';
  }

  return { semaforo, interpretacion };
}

// ── Endpoint principal: dispara los DOS runs (90d y 12m) y devuelve datos
//    ya clasificados, listos para que el frontend los pinte sin tocar JSON ──
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

    const data90d = await runTrendsActor({ ...baseInput, predefinedTimeframe: 'today 3-m' });
    const data12m = await runTrendsActor({ ...baseInput, predefinedTimeframe: 'today 12-m' });

    const parsed90 = parseTimelineItem(data90d[0]);
    const parsed12 = parseTimelineItem(data12m[0]);

    const trend90 = classifyTrend(parsed90.points);
    const trend12 = classifyTrend(parsed12.points);
    const seasonality = detectSeasonality(parsed12.points);
    const annualPeak = findAnnualPeak(parsed12.points);
    const summary = buildSummary(trend90, trend12, seasonality);

    res.json({
      keyword,
      geo,
      timeline_90d: parsed90.points,
      timeline_12m: parsed12.points,
      trend_90d: trend90.trend,
      trend_12m: trend12.trend,
      seasonality: seasonality.seasonal,
      strong_months: seasonality.strongMonths,
      annual_peak: annualPeak,
      semaforo: summary.semaforo,
      interpretacion: summary.interpretacion,
      count_90d: data90d.length,
      count_12m: data12m.length
    });

  } catch (err) {
    console.error('[TEST] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', actor: TRENDS_ACTOR_ID }));
app.get('/trends', (req, res) => res.sendFile(path.join(__dirname, 'trends-validator.html')));

app.listen(PORT, () => {
  console.log(`[TRENDS-TEST] Escuchando en puerto ${PORT}`);
  console.log(`[TRENDS-TEST] Prueba: GET /test-trends?keyword=dog+cooling+mat&geo=US`);
});
