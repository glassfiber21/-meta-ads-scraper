'use strict';

const express = require('express');
const cors    = require('cors');
const puppeteer = require('puppeteer');

const app  = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ── Configuración de criterios de calidad ─────────────────────────────────────
const RATING_MIN = 4.8;
const RATING_MAX = 4.95;

// ── Utilidades ────────────────────────────────────────────────────────────────
function lanzarBrowser() {
  return puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
}

function userAgent() {
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
}

function calcularMargen(coste, venta) {
  if (!coste || !venta || venta <= 0) return null;
  return Math.round(((venta - coste) / venta) * 10000) / 100;
}

function veredicto(margen) {
  if (margen === null) return '❓ Sin datos suficientes';
  if (margen >= 70) return '✅ Muy interesante';
  if (margen >= 50) return '🟡 Interesante';
  if (margen >= 30) return '⚠️ Margen ajustado';
  return '❌ No viable';
}

function ratingOk(rating) {
  if (rating === null) return null;
  return rating >= RATING_MIN && rating <= RATING_MAX;
}

// ── ALIEXPRESS ─────────────────────────────────────────────────────────────────
async function scrapeAliExpress(keyword) {
  const browser = await lanzarBrowser();
  const resultados = [];

  try {
    const page = await browser.newPage();
    await page.setUserAgent(userAgent());
    await page.setDefaultTimeout(25000);

    // Bloquear imágenes y media para ir más rápido
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['image', 'media', 'font'].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    const url = `https://www.aliexpress.com/wholesale?SearchText=${encodeURIComponent(keyword)}&SortType=total_tranpro_desc`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });

    // Esperar a que carguen los productos
    await page.waitForSelector('[class*="product-snippet"]', { timeout: 10000 }).catch(() => {});

    const items = await page.evaluate((rMin, rMax) => {
      const cards = document.querySelectorAll('[class*="product-snippet"], [class*="manhattan--container"]');
      const found = [];

      for (const card of Array.from(cards).slice(0, 10)) {
        try {
          // Precio
          const priceEl = card.querySelector('[class*="price--current"], [class*="manhattan--price-sale"], [class*="price_current"]');
          const priceText = priceEl?.textContent?.replace(/[^0-9.,]/g, '').replace(',', '.') || '';
          const precio = parseFloat(priceText.split('.').length > 2
            ? priceText.replace(/\.(?=.*\.)/, '')
            : priceText);

          // Título
          const titulo = card.querySelector('[class*="product-title"], [class*="manhattan--title"]')?.textContent?.trim() || '';

          // Rating
          const ratingEl = card.querySelector('[class*="rating"], [class*="star"]');
          const ratingText = ratingEl?.textContent?.match(/[\d.]+/)?.[0];
          const rating = ratingText ? parseFloat(ratingText) : null;

          // Órdenes
          const ordenesEl = card.querySelector('[class*="trade"], [class*="sold"], [class*="order"]');
          const ordenesText = ordenesEl?.textContent?.match(/[\d,]+/)?.[0]?.replace(',', '') || '0';
          const ordenes = parseInt(ordenesText) || 0;

          // Envío
          const envioEl = card.querySelector('[class*="shipping"], [class*="delivery"], [class*="free"]');
          const envioText = envioEl?.textContent?.toLowerCase() || '';
          const envioGratis = envioText.includes('free') || envioText.includes('gratis') || envioText.includes('€0');

          // URL
          const linkEl = card.querySelector('a[href*="aliexpress.com/item"], a[href*="/item/"]');
          const itemUrl = linkEl?.href || '';

          if (!isNaN(precio) && precio > 0 && titulo) {
            found.push({ titulo, precio, rating, ordenes, envioGratis, url: itemUrl });
          }
        } catch(e) {}
      }
      return found;
    }, RATING_MIN, RATING_MAX);

    // Filtrar por rating si disponible
    const validos = items.filter(i => i.rating === null || ratingOk(i.rating));
    const ordenados = validos.sort((a, b) => a.precio - b.precio);

    return ordenados.slice(0, 3).map(i => ({
      ...i,
      rating_ok: i.rating ? ratingOk(i.rating) : null,
      plataforma: 'aliexpress',
    }));

  } catch(e) {
    console.error('[PROVEEDOR] AliExpress error:', e.message);
    return [];
  } finally {
    await browser.close().catch(() => {});
  }
}

// ── ALIBABA ───────────────────────────────────────────────────────────────────
async function scrapeAlibaba(keyword) {
  const browser = await lanzarBrowser();

  try {
    const page = await browser.newPage();
    await page.setUserAgent(userAgent());
    await page.setDefaultTimeout(25000);

    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['image', 'media', 'font'].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    const url = `https://www.alibaba.com/trade/search?SearchText=${encodeURIComponent(keyword)}&viewtype=G`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });

    await page.waitForSelector('[class*="organic-list-offer"]', { timeout: 10000 }).catch(() => {});

    const items = await page.evaluate(() => {
      const cards = document.querySelectorAll('[class*="organic-list-offer-outter"], [class*="list-no-v2-outter"]');
      const found = [];

      for (const card of Array.from(cards).slice(0, 10)) {
        try {
          // Título
          const titulo = card.querySelector('[class*="offer-title"], h2, [class*="title"]')?.textContent?.trim() || '';

          // Precio (rango en Alibaba: "US$3.50 - US$8.00")
          const priceEl = card.querySelector('[class*="price"], [class*="Price"]');
          const priceText = priceEl?.textContent || '';
          const precios = priceText.match(/[\d.]+/g)?.map(Number).filter(n => n > 0) || [];
          const precio_min = precios[0] || null;
          const precio_max = precios[1] || precios[0] || null;

          // MOQ
          const moqEl = card.querySelector('[class*="moq"], [class*="min-order"]');
          const moqText = moqEl?.textContent?.match(/\d+/)?.[0];
          const moq = moqText ? parseInt(moqText) : 1;

          // Rating proveedor
          const ratingEl = card.querySelector('[class*="supplier-rating"], [class*="star"]');
          const ratingText = ratingEl?.textContent?.match(/[\d.]+/)?.[0];
          const rating_proveedor = ratingText ? parseFloat(ratingText) : null;

          // Años en Alibaba
          const yearsEl = card.querySelector('[class*="year"]');
          const yearsText = yearsEl?.textContent?.match(/\d+/)?.[0];
          const anos_proveedor = yearsText ? parseInt(yearsText) : null;

          // URL
          const linkEl = card.querySelector('a[href*="alibaba.com/product"]');
          const itemUrl = linkEl?.href || '';

          if (titulo && precio_min) {
            found.push({ titulo, precio_min, precio_max, moq, rating_proveedor, anos_proveedor, url: itemUrl });
          }
        } catch(e) {}
      }
      return found;
    });

    const ordenados = items.sort((a, b) => a.precio_min - b.precio_min);
    return ordenados.slice(0, 3).map(i => ({
      ...i,
      rating_ok: i.rating_proveedor ? ratingOk(i.rating_proveedor) : null,
      plataforma: 'alibaba',
    }));

  } catch(e) {
    console.error('[PROVEEDOR] Alibaba error:', e.message);
    return [];
  } finally {
    await browser.close().catch(() => {});
  }
}

// ── CJDROPSHIPPING ────────────────────────────────────────────────────────────
async function scrapeCJDropshipping(keyword) {
  const browser = await lanzarBrowser();

  try {
    const page = await browser.newPage();
    await page.setUserAgent(userAgent());
    await page.setDefaultTimeout(25000);

    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['image', 'media', 'font'].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    const url = `https://cjdropshipping.com/search.html?searchType=input&searchContent=${encodeURIComponent(keyword)}`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });

    await page.waitForSelector('[class*="product-item"], [class*="search-item"]', { timeout: 10000 }).catch(() => {});

    const items = await page.evaluate(() => {
      const cards = document.querySelectorAll('[class*="product-item"], [class*="search-item"], [class*="product-card"]');
      const found = [];

      for (const card of Array.from(cards).slice(0, 10)) {
        try {
          // Título
          const titulo = card.querySelector('[class*="title"], [class*="name"], h3, h4')?.textContent?.trim() || '';

          // Precio
          const priceEl = card.querySelector('[class*="price"], [class*="cost"]');
          const priceText = priceEl?.textContent?.replace(/[^0-9.]/g, '') || '';
          const precio = parseFloat(priceText);

          // Rating
          const ratingEl = card.querySelector('[class*="rating"], [class*="star"], [class*="score"]');
          const ratingText = ratingEl?.textContent?.match(/[\d.]+/)?.[0];
          const rating = ratingText ? parseFloat(ratingText) : null;

          // Envío
          const envioEl = card.querySelector('[class*="ship"], [class*="delivery"], [class*="free"]');
          const envioText = envioEl?.textContent?.toLowerCase() || '';
          const envioGratis = envioText.includes('free') || envioText.includes('gratis');

          // Tiempo de envío
          const tiempoEl = card.querySelector('[class*="day"], [class*="time"]');
          const tiempoText = tiempoEl?.textContent?.trim() || '';

          // URL
          const linkEl = card.querySelector('a[href*="cjdropshipping.com"]') || card.closest('a');
          const itemUrl = linkEl?.href || '';

          if (!isNaN(precio) && precio > 0 && titulo) {
            found.push({ titulo, precio, rating, envioGratis, tiempoEnvio: tiempoText, url: itemUrl });
          }
        } catch(e) {}
      }
      return found;
    });

    const ordenados = items.sort((a, b) => a.precio - b.precio);
    return ordenados.slice(0, 3).map(i => ({
      ...i,
      rating_ok: i.rating ? ratingOk(i.rating) : null,
      plataforma: 'cjdropshipping',
    }));

  } catch(e) {
    console.error('[PROVEEDOR] CJDropshipping error:', e.message);
    return [];
  } finally {
    await browser.close().catch(() => {});
  }
}

// ── Encontrar mejor opción entre todos los proveedores ───────────────────────
function mejorOpcion(aliexpress, alibaba, cj) {
  const candidatos = [];

  if (aliexpress.length > 0) candidatos.push({ ...aliexpress[0], fuente: 'AliExpress' });
  if (cj.length > 0) candidatos.push({ ...cj[0], fuente: 'CJDropshipping' });
  if (alibaba.length > 0) {
    const a = alibaba[0];
    candidatos.push({ precio: a.precio_min, titulo: a.titulo, fuente: 'Alibaba', url: a.url });
  }

  if (candidatos.length === 0) return null;
  return candidatos.sort((a, b) => (a.precio || 999) - (b.precio || 999))[0];
}

// ── POST /proveedor ───────────────────────────────────────────────────────────
app.post('/proveedor', async (req, res) => {
  const {
    product_name,
    keyword,
    precio_venta_es = null,
  } = req.body || {};

  if (!product_name && !keyword) {
    return res.status(400).json({ error: 'Falta product_name o keyword' });
  }

  const busqueda = keyword || product_name;
  console.log(`[PROVEEDOR] Buscando: "${busqueda}" | Precio venta: ${precio_venta_es ? precio_venta_es + '€' : 'no indicado'}`);

  try {
    // Lanzar los 3 scrapers en paralelo
    const [aliexpress, alibaba, cj] = await Promise.all([
      scrapeAliExpress(busqueda),
      scrapeAlibaba(busqueda),
      scrapeCJDropshipping(busqueda),
    ]);

    const mejor = mejorOpcion(aliexpress, alibaba, cj);
    const costeMinimo = mejor?.precio || null;
    const margen = calcularMargen(costeMinimo, precio_venta_es);

    console.log(`[PROVEEDOR] AliExpress: ${aliexpress.length} | Alibaba: ${alibaba.length} | CJ: ${cj.length}`);
    console.log(`[PROVEEDOR] Mejor opción: ${mejor?.fuente} @ ${costeMinimo}€ | Margen: ${margen}%`);

    res.json({
      success: true,
      producto: product_name || keyword,
      keyword_usada: busqueda,
      precio_venta_es,
      proveedores: {
        aliexpress: aliexpress.length > 0 ? aliexpress : null,
        alibaba:    alibaba.length > 0 ? alibaba : null,
        cjdropshipping: cj.length > 0 ? cj : null,
      },
      resumen: {
        mejor_opcion: mejor,
        coste_minimo: costeMinimo,
        proveedor_mas_barato: mejor?.fuente || null,
        margen_bruto_pct: margen,
        veredicto: veredicto(margen),
        criterios_calidad: {
          rating_producto_min: RATING_MIN,
          rating_producto_max: RATING_MAX,
          nota: `Solo se muestran productos con rating entre ${RATING_MIN} y ${RATING_MAX}`
        }
      }
    });

  } catch(e) {
    console.error('[PROVEEDOR ERROR]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'proveedor-scraper', version: '1.0' });
});

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/proveedor-tester.html');
});

app.listen(PORT, () => {
  console.log(`[PROVEEDOR] v1.0 corriendo en puerto ${PORT}`);
  console.log(`[PROVEEDOR] Proveedores: AliExpress, Alibaba, CJDropshipping`);
  console.log(`[PROVEEDOR] Criterio rating: ${RATING_MIN} - ${RATING_MAX}`);
});
