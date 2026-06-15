// ─────────────────────────────────────────────────────────────────────────────
// META ADS VALIDATOR v1.0 — Servidor independiente
// Recibe productos ya detectados por TikTok y los valida contra Meta Ads Library
// Actor Apify: jj5sAMeSoXotatkss
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const app     = express();

app.use(require('cors')({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

const PORT          = process.env.PORT || 3001;
const APIFY_API_KEY = process.env.APIFY_API_KEY || '';
const META_ACTOR    = 'jj5sAMeSoXotatkss';
const MAX_ADS       = 50;
const RESULTS_FILE  = path.join('/tmp', 'meta_results.json');

// ── Productos TikTok hardcodeados (run definitivo v9.0) ───────────────────────
// TEST v1.0 — 1 solo producto para trazar el camino
// Una vez confirmado el flujo, añadir el resto
const PRODUCTOS_TIKTOK = [
  { product: 'Kitchen Degreaser Spray', tiktok_score: 57.5, creators: 5, videos: 6 },
];

// ── Job queue ─────────────────────────────────────────────────────────────────
const jobs = {};
function createJob() {
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  jobs[id] = { status: 'running', progress: 'Iniciando...', result: null };
  return id;
}
function updateJob(id, data) { if (jobs[id]) Object.assign(jobs[id], data); }

// ── Persistencia ──────────────────────────────────────────────────────────────
function saveResults(data) {
  try {
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(data, null, 2), 'utf8');
    console.log(`[PERSIST] Guardado en ${RESULTS_FILE}`);
  } catch(e) { console.error('[PERSIST ERROR]', e.message); }
}
function loadResults() {
  try {
    if (fs.existsSync(RESULTS_FILE)) {
      return JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
    }
  } catch(e) { console.error('[PERSIST LOAD]', e.message); }
  return null;
}

// ── Llamada a Apify Meta Ads actor ────────────────────────────────────────────
async function scrapeMetaAds(keyword) {
  console.log(`[META] Buscando: "${keyword}"`);

  const input = {
    keyword,
    country:    'US',
    maxResults: MAX_ADS,
  };

  const runRes = await fetch(`https://api.apify.com/v2/acts/${META_ACTOR}/runs`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${APIFY_API_KEY}` },
    body:    JSON.stringify(input),
  });

  if (runRes.status !== 200 && runRes.status !== 201) {
    const err = await runRes.json().catch(() => ({}));
    throw new Error(`Apify ${runRes.status}: ${JSON.stringify(err)}`);
  }

  const runData  = await runRes.json();
  const runId    = runData.data?.id;
  const datasetId = runData.data?.defaultDatasetId;

  if (!runId) throw new Error('No se obtuvo runId de Apify');

  // Polling hasta SUCCEEDED
  let status = 'RUNNING', attempts = 0;
  while (status === 'RUNNING' && attempts < 120) {
    await new Promise(r => setTimeout(r, 5000));
    const s = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, {
      headers: { 'Authorization': `Bearer ${APIFY_API_KEY}` },
    });
    const sData = await s.json();
    status = sData.data?.status;
    attempts++;
    console.log(`  [META] "${keyword}" — status: ${status} (intento ${attempts})`);
    if (status !== 'RUNNING') break;
  }

  if (status !== 'SUCCEEDED') throw new Error(`Run terminó con status: ${status}`);

  const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?limit=${MAX_ADS}`, {
    headers: { 'Authorization': `Bearer ${APIFY_API_KEY}` },
  });
  const items = await itemsRes.json();
  console.log(`  [META] "${keyword}" — ${items.length} anuncios encontrados`);
  return Array.isArray(items) ? items : [];
}

// ── Calcular métricas Meta a partir de los anuncios crudos ────────────────────
function calcularMetricas(ads, keyword) {
  if (!ads || ads.length === 0) {
    return {
      advertiser_count:    0,
      total_ads:           0,
      oldest_ad_days:      null,
      avg_ad_days:         null,
      landing_pages_count: 0,
      landing_pages:       [],
      advertisers:         [],
      meta_score:          0,
      ads_raw:             [],
    };
  }

  const now = Date.now();

  // Extraer datos normalizados de cada anuncio
  const parsed = ads.map(ad => {
    // Intentar extraer campos — el actor puede variar su estructura
    const advertiser  = ad.pageName || ad.advertiserName || ad.page_name || ad.advertiser || '';
    const adText      = ad.adText   || ad.body           || ad.text      || ad.description || '';
    const landingRaw  = ad.landingPage || ad.websiteUrl  || ad.url       || ad.link        || '';
    const startDate   = ad.startDate   || ad.createdAt   || ad.start_date || ad.dateRange?.startDate || '';

    // Dominio limpio
    let domain = '';
    try {
      if (landingRaw) domain = new URL(landingRaw.startsWith('http') ? landingRaw : `https://${landingRaw}`).hostname.replace('www.', '');
    } catch(_) { domain = landingRaw; }

    // Días desde inicio del anuncio
    let days = null;
    if (startDate) {
      const d = new Date(startDate);
      if (!isNaN(d)) days = Math.floor((now - d.getTime()) / 86400000);
    }

    return { advertiser, adText, domain, landingRaw, startDate, days };
  });

  // Métricas
  const advertisers     = [...new Set(parsed.map(p => p.advertiser).filter(Boolean))];
  const domains         = [...new Set(parsed.map(p => p.domain).filter(Boolean))];
  const daysArr         = parsed.map(p => p.days).filter(d => d !== null && d >= 0);
  const oldest_ad_days  = daysArr.length ? Math.max(...daysArr)  : null;
  const avg_ad_days     = daysArr.length ? Math.round(daysArr.reduce((a,b) => a+b, 0) / daysArr.length) : null;

  const advertiser_count    = advertisers.length;
  const total_ads           = ads.length;
  const landing_pages_count = domains.length;

  // Meta Score (raw)
  const raw_score = (advertiser_count * 5) + (total_ads * 1) + ((avg_ad_days || 0) * 0.5);

  return {
    advertiser_count,
    total_ads,
    oldest_ad_days,
    avg_ad_days,
    landing_pages_count,
    landing_pages: domains,
    advertisers,
    meta_score_raw: raw_score,
    meta_score: 0,   // se normaliza después con el resto de productos
    ads_raw: parsed.map(p => ({
      advertiser: p.advertiser,
      ad_text:    p.adText.slice(0, 200),
      domain:     p.domain,
      landing:    p.landingRaw,
      days:       p.days,
    })),
  };
}

// ── Normalizar meta_score a 0-100 ─────────────────────────────────────────────
function normalizarScores(productos) {
  const raws = productos.map(p => p.meta?.meta_score_raw || 0);
  const max  = Math.max(...raws, 1);
  return productos.map(p => ({
    ...p,
    meta: p.meta ? { ...p.meta, meta_score: Math.round((p.meta.meta_score_raw / max) * 100) } : p.meta,
  }));
}

// ── Score final combinado ─────────────────────────────────────────────────────
function calcularScoreFinal(productos) {
  return productos.map(p => ({
    ...p,
    score_final: p.meta
      ? Math.round(((p.tiktok_score / 100) * 60 + (p.meta.meta_score / 100) * 40) * 100) / 100
      : p.tiktok_score * 0.6,
  })).sort((a, b) => b.score_final - a.score_final);
}

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// Lista de productos base (TikTok)
app.get('/productos', (req, res) => {
  res.json({ productos: PRODUCTOS_TIKTOK });
});

// Último resultado guardado
app.get('/last-results', (req, res) => {
  const data = loadResults();
  if (!data) return res.status(404).json({ error: 'No hay resultados guardados aún' });
  res.json({ success: true, from_cache: true, ...data });
});

// Estado de un job
app.get('/job-status/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job no encontrado' });
  res.json(job);
});

// ── Validar UN solo producto (para testing barato) ────────────────────────────
app.post('/validate-one', async (req, res) => {
  const { product, tiktok_score } = req.body || {};
  if (!product) return res.status(400).json({ error: 'Falta el campo "product"' });

  const jobId = createJob();
  res.json({ success: true, job_id: jobId });

  (async () => {
    try {
      updateJob(jobId, { progress: `Validando "${product}" en Meta Ads...` });
      const ads     = await scrapeMetaAds(product);
      const metricas = calcularMetricas(ads, product);

      const resultado = {
        product,
        tiktok_score: tiktok_score || 0,
        meta: metricas,
        score_final: Math.round(((tiktok_score / 100) * 60 + (metricas.meta_score_raw / 100) * 40) * 100) / 100,
        validated_at: new Date().toISOString(),
      };

      updateJob(jobId, { status: 'done', result: { success: true, producto: resultado } });
      console.log(`[VALIDATE-ONE] "${product}" — ${metricas.advertiser_count} anunciantes, ${metricas.total_ads} anuncios`);
    } catch(e) {
      console.error('[VALIDATE-ONE ERROR]', e.message);
      updateJob(jobId, { status: 'error', result: { error: e.message } });
    }
  })();
});

// ── Validar TODOS los productos (run completo) ────────────────────────────────
app.post('/validate-all', async (req, res) => {
  // Permite sobreescribir la lista si se pasa en el body
  const productos = req.body?.productos || PRODUCTOS_TIKTOK;

  const jobId = createJob();
  res.json({ success: true, job_id: jobId, total: productos.length });

  (async () => {
    try {
      const resultados = [];

      for (let i = 0; i < productos.length; i++) {
        const { product, tiktok_score, creators, videos } = productos[i];
        updateJob(jobId, {
          progress: `[${i+1}/${productos.length}] Validando "${product}"...`,
          parcial:  resultados.slice(),
        });

        try {
          const ads      = await scrapeMetaAds(product);
          const metricas = calcularMetricas(ads, product);
          resultados.push({ product, tiktok_score, creators, videos, meta: metricas });
          console.log(`[${i+1}/${productos.length}] "${product}" — OK`);
        } catch(e) {
          console.error(`[${i+1}/${productos.length}] "${product}" — ERROR:`, e.message);
          resultados.push({ product, tiktok_score, creators, videos, meta: null, error: e.message });
        }

        // Guardar parcialmente cada 3 productos por si algo falla
        if ((i + 1) % 3 === 0) {
          saveResults({ parcial: true, productos: resultados, saved_at: new Date().toISOString() });
        }
      }

      // Normalizar + score final
      const conMeta    = resultados.filter(p => p.meta && p.meta.meta_score_raw > 0);
      const sinMeta    = resultados.filter(p => !p.meta || p.meta.meta_score_raw === 0);
      const normalizados = normalizarScores(conMeta);
      const final      = calcularScoreFinal([...normalizados, ...sinMeta]);

      const output = {
        success:    true,
        total:      final.length,
        productos:  final,
        saved_at:   new Date().toISOString(),
      };

      saveResults(output);
      updateJob(jobId, { status: 'done', result: output });
      console.log(`[VALIDATE-ALL] Completo: ${final.length} productos`);

    } catch(e) {
      console.error('[VALIDATE-ALL ERROR]', e.message);
      updateJob(jobId, { status: 'error', result: { error: e.message } });
    }
  })();
});

// ── Frontend embebido ─────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Meta Ads Validator</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg:      #0d0d0d;
    --surface: #161616;
    --border:  #2a2a2a;
    --text:    #e8e8e8;
    --muted:   #666;
    --accent:  #1877f2;
    --green:   #22c55e;
    --orange:  #f59e0b;
    --red:     #ef4444;
  }
  body { background: var(--bg); color: var(--text); font-family: 'Inter', system-ui, sans-serif; min-height: 100vh; }
  header { padding: 28px 32px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 14px; }
  .logo { width: 36px; height: 36px; background: var(--accent); border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 18px; }
  header h1 { font-size: 18px; font-weight: 600; }
  header p  { font-size: 12px; color: var(--muted); }
  .container { max-width: 1100px; margin: 0 auto; padding: 32px; }
  .panel { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 24px; margin-bottom: 24px; }
  .panel h2 { font-size: 14px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; margin-bottom: 16px; }
  .products-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
  .product-chip {
    background: #1a1a1a; border: 1px solid var(--border); border-radius: 8px;
    padding: 10px 14px; cursor: pointer; transition: border-color .15s;
    display: flex; flex-direction: column; gap: 4px;
  }
  .product-chip:hover { border-color: var(--accent); }
  .product-chip.selected { border-color: var(--accent); background: #0d1b3e; }
  .product-chip .name  { font-size: 13px; font-weight: 500; }
  .product-chip .score { font-size: 11px; color: var(--muted); }
  .actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 20px; }
  .btn {
    padding: 10px 22px; border-radius: 8px; border: none; cursor: pointer;
    font-size: 13px; font-weight: 600; transition: opacity .15s;
  }
  .btn:hover { opacity: .85; }
  .btn-primary { background: var(--accent); color: #fff; }
  .btn-single  { background: #2a2a2a; color: var(--text); }
  .btn-load    { background: #1a1a1a; color: var(--muted); border: 1px solid var(--border); }
  .btn:disabled { opacity: .4; cursor: not-allowed; }
  .progress-bar { background: #1a1a1a; border-radius: 8px; height: 6px; overflow: hidden; margin: 12px 0; }
  .progress-fill { height: 100%; background: var(--accent); transition: width .4s; border-radius: 8px; }
  .status-msg { font-size: 13px; color: var(--muted); margin-top: 8px; min-height: 18px; }
  .results-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .results-table th { text-align: left; padding: 10px 12px; color: var(--muted); font-weight: 500; border-bottom: 1px solid var(--border); font-size: 11px; text-transform: uppercase; }
  .results-table td { padding: 12px; border-bottom: 1px solid #1a1a1a; vertical-align: top; }
  .results-table tr:last-child td { border-bottom: none; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .badge-green  { background: #14532d; color: var(--green); }
  .badge-orange { background: #451a03; color: var(--orange); }
  .badge-red    { background: #450a0a; color: var(--red); }
  .badge-blue   { background: #0d1b3e; color: var(--accent); }
  .domains-list { font-size: 11px; color: var(--muted); margin-top: 4px; line-height: 1.6; }
  .score-final { font-size: 18px; font-weight: 700; }
  .score-up    { color: var(--green); }
  .score-down  { color: var(--red); }
  .score-same  { color: var(--orange); }
  .empty { text-align: center; padding: 60px 20px; color: var(--muted); }
  .tag-tiktok { color: #fe2c55; font-weight: 600; }
  .tag-meta   { color: var(--accent); font-weight: 600; }
  .error-box  { background: #1a0a0a; border: 1px solid #4a1a1a; border-radius: 8px; padding: 12px 16px; color: var(--red); font-size: 13px; margin-top: 12px; }
</style>
</head>
<body>
<header>
  <div class="logo">📘</div>
  <div>
    <h1>Meta Ads Validator</h1>
    <p>Valida productos TikTok contra Meta Ads Library · Actor ${META_ACTOR}</p>
  </div>
</header>

<div class="container">

  <!-- Panel: productos base -->
  <div class="panel">
    <h2>Productos detectados en TikTok (${PRODUCTOS_TIKTOK.length})</h2>
    <p style="font-size:12px;color:var(--muted);margin-bottom:14px">
      Selecciona uno para test individual o lanza validación completa
    </p>
    <div class="products-grid" id="chips"></div>

    <div class="actions">
      <button class="btn btn-primary" id="btnAll" onclick="validarTodos()">
        🚀 Validar todos en Meta Ads
      </button>
      <button class="btn btn-single" id="btnOne" onclick="validarSeleccionado()" disabled>
        🔍 Validar seleccionado
      </button>
      <button class="btn btn-load" onclick="cargarUltimos()">
        💾 Cargar último resultado guardado
      </button>
    </div>

    <div class="progress-bar" id="progressBar" style="display:none">
      <div class="progress-fill" id="progressFill" style="width:0%"></div>
    </div>
    <div class="status-msg" id="statusMsg"></div>
    <div class="error-box" id="errorBox" style="display:none"></div>
  </div>

  <!-- Panel: resultados -->
  <div class="panel" id="resultsPanel" style="display:none">
    <h2>Ranking final <span style="color:var(--muted);font-weight:400;font-size:11px">(TikTok 60% + Meta 40%)</span></h2>
    <table class="results-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Producto</th>
          <th class="tag-tiktok">TikTok</th>
          <th class="tag-meta">Meta anunciantes</th>
          <th class="tag-meta">Meta anuncios</th>
          <th class="tag-meta">Meta score</th>
          <th>Score final</th>
          <th>Landing pages</th>
        </tr>
      </thead>
      <tbody id="resultsBody"></tbody>
    </table>
  </div>

</div>

<script>
const PRODUCTOS = ${JSON.stringify(PRODUCTOS_TIKTOK)};
let selectedIdx = null;
let polling     = null;

// Renderizar chips
function renderChips() {
  const grid = document.getElementById('chips');
  grid.innerHTML = PRODUCTOS.map((p, i) => \`
    <div class="product-chip" id="chip-\${i}" onclick="selectChip(\${i})">
      <span class="name">\${p.product}</span>
      <span class="score">TikTok \${p.tiktok_score} · \${p.creators}c \${p.videos}v</span>
    </div>
  \`).join('');
}

function selectChip(i) {
  document.querySelectorAll('.product-chip').forEach(c => c.classList.remove('selected'));
  document.getElementById('chip-' + i).classList.add('selected');
  selectedIdx = i;
  document.getElementById('btnOne').disabled = false;
}

// Polling job
function pollJob(jobId, totalItems, callback) {
  let n = 0;
  polling = setInterval(async () => {
    try {
      const r = await fetch('/job-status/' + jobId);
      const d = await r.json();
      n++;
      document.getElementById('statusMsg').textContent = d.progress || '';

      if (totalItems) {
        const pct = Math.min(95, (n / (totalItems * 12)) * 100);
        document.getElementById('progressFill').style.width = pct + '%';
      }

      if (d.status === 'done') {
        clearInterval(polling);
        document.getElementById('progressFill').style.width = '100%';
        setTimeout(() => { document.getElementById('progressBar').style.display = 'none'; }, 800);
        callback(null, d.result);
      } else if (d.status === 'error') {
        clearInterval(polling);
        callback(d.result?.error || 'Error desconocido');
      }
    } catch(e) { /* sigue intentando */ }
  }, 4000);
}

function setLoading(on) {
  document.getElementById('btnAll').disabled = on;
  document.getElementById('btnOne').disabled = on || selectedIdx === null;
  document.getElementById('progressBar').style.display = on ? 'block' : 'none';
  document.getElementById('errorBox').style.display = 'none';
  if (on) document.getElementById('progressFill').style.width = '0%';
}

function showError(msg) {
  const box = document.getElementById('errorBox');
  box.textContent = '⚠ ' + msg;
  box.style.display = 'block';
  setLoading(false);
}

async function validarTodos() {
  setLoading(true);
  document.getElementById('statusMsg').textContent = 'Lanzando validación...';
  try {
    const r = await fetch('/validate-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const d = await r.json();
    if (!d.job_id) throw new Error(d.error || 'Sin job_id');
    pollJob(d.job_id, PRODUCTOS.length, (err, result) => {
      setLoading(false);
      if (err) return showError(err);
      renderResults(result.productos);
    });
  } catch(e) { showError(e.message); }
}

async function validarSeleccionado() {
  if (selectedIdx === null) return;
  const p = PRODUCTOS[selectedIdx];
  setLoading(true);
  document.getElementById('statusMsg').textContent = 'Lanzando validación de "' + p.product + '"...';
  try {
    const r = await fetch('/validate-one', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product: p.product, tiktok_score: p.tiktok_score }),
    });
    const d = await r.json();
    if (!d.job_id) throw new Error(d.error || 'Sin job_id');
    pollJob(d.job_id, 1, (err, result) => {
      setLoading(false);
      if (err) return showError(err);
      renderResults([result.producto]);
    });
  } catch(e) { showError(e.message); }
}

async function cargarUltimos() {
  document.getElementById('statusMsg').textContent = 'Cargando resultados guardados...';
  try {
    const r = await fetch('/last-results');
    if (!r.ok) { document.getElementById('statusMsg').textContent = 'No hay resultados guardados aún.'; return; }
    const d = await r.json();
    document.getElementById('statusMsg').textContent = 'Cargado desde ' + (d.saved_at ? new Date(d.saved_at).toLocaleString('es') : 'caché');
    renderResults(d.productos);
  } catch(e) { showError(e.message); }
}

function scoreBadge(score) {
  if (score >= 70) return \`<span class="badge badge-green">\${score}</span>\`;
  if (score >= 40) return \`<span class="badge badge-orange">\${score}</span>\`;
  return \`<span class="badge badge-red">\${score}</span>\`;
}

function renderResults(productos) {
  if (!productos || !productos.length) return;
  const tbody = document.getElementById('resultsBody');
  tbody.innerHTML = productos.map((p, i) => {
    const m = p.meta;
    const sfClass = p.score_final >= p.tiktok_score ? 'score-up' : p.score_final < p.tiktok_score * 0.8 ? 'score-down' : 'score-same';
    const domains = m?.landing_pages?.slice(0,5).join('<br>') || '—';
    return \`
      <tr>
        <td style="color:var(--muted)">\${i+1}</td>
        <td><strong>\${p.product}</strong>
          <div style="font-size:11px;color:var(--muted);margin-top:3px">\${p.creators}c · \${p.videos}v</div>
        </td>
        <td>\${scoreBadge(p.tiktok_score)}</td>
        <td>\${m ? \`<span class="badge badge-blue">\${m.advertiser_count}</span>\` : '—'}</td>
        <td>\${m ? m.total_ads : '—'}</td>
        <td>\${m ? scoreBadge(m.meta_score) : '—'}</td>
        <td><span class="score-final \${sfClass}">\${p.score_final ?? '—'}</span></td>
        <td><div class="domains-list">\${domains}</div></td>
      </tr>
    \`;
  }).join('');
  document.getElementById('resultsPanel').style.display = 'block';
  document.getElementById('resultsPanel').scrollIntoView({ behavior: 'smooth' });
}

renderChips();
</script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`[META VALIDATOR] v1.0 corriendo en puerto ${PORT}`);
  console.log(`[META VALIDATOR] Actor: ${META_ACTOR} | Max ads: ${MAX_ADS}`);
  console.log(`[META VALIDATOR] Productos cargados: ${PRODUCTOS_TIKTOK.length}`);
});
