'use strict';

const express = require('express');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const APIFY_API_KEY = process.env.APIFY_API_KEY || '';
const RATING_MIN    = 4.8;
const RATING_MAX    = 4.95;

// Actores de Apify
const ACTOR_ALIEXPRESS = 'devcake~aliexpress-products-scraper';
const ACTOR_ALIBABA    = 'piotrv1001~alibaba-listings-scraper';

// Tiempos de envío estándar a España por plataforma
const TIEMPOS_ES = {
  aliexpress:     '8–15 días',
  alibaba:        '15–30 días',
  cjdropshipping: '7–12 días',
};

// ── Utilidad: lanzar actor Apify y esperar resultado ─────────────────────────
async function runApifyActor(actorId, input, maxWaitMs = 120_000) {
  if (!APIFY_API_KEY) throw new Error('APIFY_API_KEY no configurada');

  // Lanzar
  const runRes = await fetch(
    `https://api.apify.com/v2/acts/${actorId}/runs?token=${APIFY_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }
  );
  if (!runRes.ok) {
    const err = await runRes.text();
    throw new Error(`Error lanzando ${actorId}: ${runRes.status} — ${err}`);
  }
  const runData = await runRes.json();
  const runId   = runData.data?.id;
  if (!runId) throw new Error(`No runId para ${actorId}`);

  console.log(`[PROVEEDOR] Actor ${actorId} lanzado, runId=${runId}`);

  // Polling
  const poll  = 5_000;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, poll));
    const statusRes  = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_API_KEY}`);
    const statusData = await statusRes.json();
    const status     = statusData.data?.status;
    console.log(`[PROVEEDOR] ${actorId} status: ${status}`);

    if (status === 'SUCCEEDED' || status === 'ABORTED') {
      const datasetId = statusData.data?.defaultDatasetId;
      const itemsRes  = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_API_KEY}&limit=20`);
      const items     = await itemsRes.json();
      console.log(`[PROVEEDOR] ${actorId} → ${items.length} items`);
      return Array.isArray(items) ? items : [];
    }
    if (status === 'FAILED' || status === 'TIMED-OUT') {
      throw new Error(`Actor ${actorId} falló con status: ${status}`);
    }
  }
  throw new Error(`Timeout esperando ${actorId}`);
}

// ── AliExpress ────────────────────────────────────────────────────────────────
async function buscarAliExpress(keyword) {
  try {
    const items = await runApifyActor(ACTOR_ALIEXPRESS, {
      searchQueries: [keyword],
      limit:         20,
    });

    return items
      .filter(i => i.price > 0)
      .map(i => {
        const rating = i.starRating || i.rating || null;
        const ratingOk = rating ? (rating >= RATING_MIN && rating <= RATING_MAX) : null;
        return {
          titulo:       i.title || i.name || '',
          precio:       parseFloat(i.price) || null,
          rating:       rating,
          rating_ok:    ratingOk,
          ordenes:      i.soldCount || i.orders || 0,
          envioGratis:  i.freeShipping || false,
          tiempoEnvio:  i.shippingTime || TIEMPOS_ES.aliexpress,
          url:          i.url || i.productUrl || '',
          imagen:       i.imageUrl || i.image || '',
          vendedor:     i.storeName || i.seller || '',
          moq:          1,
          plataforma:   'aliexpress',
        };
      })
      .filter(i => i.rating_ok !== false) // excluir ratings fuera de rango
      .sort((a, b) => (a.precio || 999) - (b.precio || 999))
      .slice(0, 5);

  } catch(e) {
    console.error('[PROVEEDOR] AliExpress error:', e.message);
    return [];
  }
}

// ── Alibaba ───────────────────────────────────────────────────────────────────
async function buscarAlibaba(keyword) {
  try {
    const items = await runApifyActor(ACTOR_ALIBABA, {
      keywords: keyword,
      limit:    20,
    });

    return items
      .filter(i => i.price)
      .map(i => {
        // Parsear precio: "$3.50" o "$3.80-10.20"
        const priceStr   = (i.price || '').replace(/[$,]/g, '');
        const priceParts = priceStr.split('-').map(p => parseFloat(p.trim())).filter(n => !isNaN(n));
        const precioMin  = priceParts[0] || null;
        const precioMax  = priceParts[1] || precioMin;

        // Parsear MOQ: "Min. order: 10 sets" → 10
        const moqMatch = (i.moq || '').match(/\d+/);
        const moq      = moqMatch ? parseInt(moqMatch[0]) : 1;

        const rating   = parseFloat(i.reviewScore || 0) || null;
        const ratingOk = rating ? (rating >= RATING_MIN && rating <= RATING_MAX) : null;

        // Años proveedor: "3 yrs" → 3
        const anosMatch = (i.goldSupplierYears || '').match(/\d+/);
        const anos      = anosMatch ? parseInt(anosMatch[0]) : null;

        // Limpiar título de HTML tags
        const titulo = (i.title || '').replace(/<[^>]+>/g, '').trim();

        return {
          titulo:          titulo,
          precio_min:      precioMin,
          precio_max:      precioMax,
          precio:          precioMin,
          moq:             moq,
          rating:          rating,
          rating_ok:       ratingOk,
          anos_proveedor:  anos,
          proveedor:       i.companyName || '',
          verificado:      false,
          tiempoEnvio:     TIEMPOS_ES.alibaba,
          envioGratis:     false,
          url:             i.productUrl || '',
          imagen:          i.mainImage || '',
          plataforma:      'alibaba',
        };
      })
      .sort((a, b) => (a.precio_min || 999) - (b.precio_min || 999))
      .slice(0, 5);

  } catch(e) {
    console.error('[PROVEEDOR] Alibaba error:', e.message);
    return [];
  }
}

// ── CJDropshipping (Puppeteer como fallback) ──────────────────────────────────
async function buscarCJDropshipping(keyword) {
  const puppeteer = require('puppeteer');
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
    await page.setDefaultTimeout(25000);

    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['image', 'media', 'font'].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    const url = `https://cjdropshipping.com/search.html?searchType=input&searchContent=${encodeURIComponent(keyword)}`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
    await page.waitForSelector('[class*="product"]', { timeout: 10000 }).catch(() => {});

    const items = await page.evaluate((rMin, rMax, tiempoDefault) => {
      const selectors = [
        '[class*="product-item"]',
        '[class*="search-item"]',
        '[class*="product-card"]',
        '[class*="goods-item"]',
      ];
      let cards = [];
      for (const sel of selectors) {
        cards = Array.from(document.querySelectorAll(sel));
        if (cards.length > 0) break;
      }

      return cards.slice(0, 10).map(card => {
        const titulo  = card.querySelector('[class*="title"], [class*="name"], h3, h4')?.textContent?.trim() || '';
        const priceEl = card.querySelector('[class*="price"], [class*="cost"]');
        const precio  = parseFloat(priceEl?.textContent?.replace(/[^0-9.]/g, '') || '0');
        const ratingEl = card.querySelector('[class*="rating"], [class*="score"], [class*="star"]');
        const rating   = parseFloat(ratingEl?.textContent?.match(/[\d.]+/)?.[0] || '0') || null;
        const linkEl   = card.querySelector('a[href]') || card.closest('a');
        const itemUrl  = linkEl?.href || '';
        const imgEl    = card.querySelector('img');
        const imagen   = imgEl?.src || imgEl?.dataset?.src || '';

        return {
          titulo,
          precio:      precio > 0 ? precio : null,
          rating:      rating,
          rating_ok:   rating ? (rating >= rMin && rating <= rMax) : null,
          moq:         1,
          envioGratis: true,
          tiempoEnvio: tiempoDefault,
          url:         itemUrl,
          imagen,
          plataforma:  'cjdropshipping',
        };
      }).filter(i => i.precio && i.titulo);
    }, RATING_MIN, RATING_MAX, TIEMPOS_ES.cjdropshipping);

    return items
      .filter(i => i.rating_ok !== false)
      .sort((a, b) => (a.precio || 999) - (b.precio || 999))
      .slice(0, 5);

  } catch(e) {
    console.error('[PROVEEDOR] CJDropshipping error:', e.message);
    return [];
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ── Calcular margen y veredicto ───────────────────────────────────────────────
function calcularMargen(coste, venta) {
  if (!coste || !venta || venta <= 0 || coste <= 0) return null;
  return Math.round(((venta - coste) / venta) * 10000) / 100;
}

function veredicto(margen) {
  if (margen === null) return '❓ Sin datos suficientes';
  if (margen >= 70) return '✅ Producto muy viable';
  if (margen >= 50) return '🟡 Producto viable';
  if (margen >= 30) return '⚠️ Margen ajustado';
  return '❌ No viable';
}

function mejorOpcionGlobal(ali, alibaba, cj) {
  const candidatos = [
    ...(ali.length > 0    ? [{ ...ali[0], fuente: 'AliExpress' }]     : []),
    ...(cj.length > 0     ? [{ ...cj[0], fuente: 'CJDropshipping' }]  : []),
    ...(alibaba.length > 0 ? [{ ...alibaba[0], fuente: 'Alibaba', precio: alibaba[0].precio_min }] : []),
  ];
  if (candidatos.length === 0) return null;
  return candidatos.sort((a, b) => (a.precio || 999) - (b.precio || 999))[0];
}

// ── POST /proveedor ───────────────────────────────────────────────────────────
app.post('/proveedor', async (req, res) => {
  const { product_name, keyword, precio_venta_es = null } = req.body || {};

  if (!product_name && !keyword) {
    return res.status(400).json({ error: 'Falta product_name o keyword' });
  }

  const busqueda = keyword || product_name;
  console.log(`[PROVEEDOR] Búsqueda: "${busqueda}" | Precio venta ES: ${precio_venta_es}€`);

  try {
    const [ali, alibaba, cj] = await Promise.all([
      buscarAliExpress(busqueda),
      buscarAlibaba(busqueda),
      buscarCJDropshipping(busqueda),
    ]);

    const mejor      = mejorOpcionGlobal(ali, alibaba, cj);
    const costeMin   = mejor?.precio || null;
    const margen     = calcularMargen(costeMin, precio_venta_es);
    const margenEuros = (precio_venta_es && costeMin)
      ? Math.round((precio_venta_es - costeMin) * 100) / 100
      : null;

    console.log(`[PROVEEDOR] AliExpress: ${ali.length} | Alibaba: ${alibaba.length} | CJ: ${cj.length}`);
    console.log(`[PROVEEDOR] Mejor: ${mejor?.fuente} @ ${costeMin}€ | Margen: ${margen}%`);

    res.json({
      success: true,
      producto:        product_name || keyword,
      keyword_usada:   busqueda,
      precio_venta_es: precio_venta_es,
      proveedores: {
        aliexpress:     ali.length     > 0 ? ali     : null,
        alibaba:        alibaba.length > 0 ? alibaba : null,
        cjdropshipping: cj.length      > 0 ? cj      : null,
      },
      resumen: {
        mejor_opcion:         mejor,
        coste_minimo:         costeMin,
        proveedor_mas_barato: mejor?.fuente || null,
        margen_bruto_euros:   margenEuros,
        margen_bruto_pct:     margen,
        veredicto:            veredicto(margen),
        criterios: {
          rating_min: RATING_MIN,
          rating_max: RATING_MAX,
        },
      },
    });

  } catch(e) {
    console.error('[PROVEEDOR ERROR]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'proveedor-scraper', v: '2.0' }));
app.get('/', (_req, res) => res.sendFile(__dirname + '/proveedor-tester.html'));

app.listen(PORT, () => {
  console.log(`[PROVEEDOR] v2.0 corriendo en puerto ${PORT}`);
  console.log(`[PROVEEDOR] Rating válido: ${RATING_MIN}–${RATING_MAX}`);
  console.log(`[PROVEEDOR] Actores Apify: ${ACTOR_ALIEXPRESS} | ${ACTOR_ALIBABA}`);
});
