# Meta Ads Scraper - Servidor Puente

Servidor Express que hace scraping de Meta Ad Library para el Cazador de Productos de Oficina IA Ecommerce.

## Despliegue en Railway

1. Sube estos archivos a un repositorio de GitHub
2. En Railway: New Project → Deploy from GitHub repo
3. Selecciona el repositorio
4. Railway detecta el Dockerfile automáticamente
5. Deploy

## Uso

### POST /scrape-ads

```json
{
  "country": "US",
  "niche": "fitness",
  "min_days_active": 30,
  "limit": 10
}
```

### Respuesta

```json
{
  "success": true,
  "total_found": 8,
  "ads": [
    {
      "id": "123456",
      "page_name": "FitLife Products",
      "ad_text": "Transform your body in 30 days...",
      "start_date": "January 15, 2024",
      "days_active": 145,
      "image_url": "https://...",
      "library_url": "https://www.facebook.com/ads/library/?id=123456"
    }
  ]
}
```

## Parámetros

| Parámetro | Tipo | Default | Descripción |
|---|---|---|---|
| country | string | US | US, UK/GB, ES |
| niche | string | - | Palabra clave del nicho |
| min_days_active | number | 30 | Días mínimos activo el anuncio |
| limit | number | 10 | Número máximo de resultados |
