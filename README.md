# Trends Test (capa Google Trends — endpoint aislado)

Servicio mínimo para validar el actor `data_xplorer/google-trends-fast-scraper`
(ID `nWhM7vTPu16lcwuIg`) antes de integrarlo como Fase 3 en el pipeline principal
de Cazador de Productos.

## Variables de entorno requeridas

- `APIFY_API_KEY` — token de Apify (añadir vía GraphQL API en Railway, no desde la UI)

## Endpoints

- `GET /health` — comprobación básica
- `GET /test-trends?keyword=dog+cooling+mat&geo=US` — lanza el actor dos veces
  (90 días y 12 meses) para la keyword indicada y devuelve el JSON crudo de
  ambos datasets, sin clasificar. Objetivo: confirmar la forma real de los
  datos antes de escribir la lógica de clasificación (Subiendo/Plano/Bajando
  + estacionalidad).

## Siguiente paso tras validar

Una vez confirmado el formato del dataset:
1. Añadir clasificación de tendencia (90d y 12m) + detección de estacionalidad.
2. Añadir prompt de Claude para generar la keyword de Trends a partir del
   nombre del producto validado en Meta (keyword distinta a la de Meta Ads).
3. Integrar como Fase 3 en `server.js` del repo principal
   (`glassfiber21/-meta-ads-scraper`).
