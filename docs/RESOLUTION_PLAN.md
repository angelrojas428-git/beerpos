# Plan de Resolución Técnica — BeerPOS (Barra / Pruebas)

## 1. Objetivo
Eliminar de forma permanente los errores recurrentes: bucles de carga, mojibake de emojis/acentos, fallos de bootstrap (BOM), y problemas de codificación en producción (Render).

## 2. Etapas

### Etapa 1 — Diagnóstico de causa raíz
- Revisar logs de Render (build + runtime).
- Verificar encoding de archivos (UTF-8 sin BOM) y cabeceras HTTP (Content-Type charset).
- Auditar Service Worker (caché obsoleta) y registro.
- Revisar conexión PG (client_encoding) y datos existentes.

### Etapa 2 — Correcciones de código
- Forzar UTF-8 en HTML responses (Helmet/CSP + static headers).
- Forzar client_encoding=UTF8 en pool PG.
- Eliminar BOM de schema.sql y otros archivos.
- Corregir mojibake en index.html (emojis/acentos).
- Bump de caché SW y versionado de registro.

### Etapa 3 — Pruebas
- Ejecutar suite backend (npm test) — 150 tests.
- Verificar arranque local (npm start) sin errores.
- Probar renderizado de emojis/acentos en Chrome/Firefox/Safari.
- Probar flujo login y carga inicial sin bucles.

### Etapa 4 — Despliegue
- Commit y push a main.
- Monitorear deploy en Render.
- Hard refresh en clientes para invalidar caché.
- Verificar /api/health y logs post-deploy.

### Etapa 5 — Prevención
- Añadir lint/check de encoding en CI.
- Documentar en MANUAL.md procedimientos de deploy.
- Mantener versionado de SW y cache-busting.

## 3. Criterios de éxito
- Sin errores de bootstrap.
- Emojis/acentos correctos en todos los navegadores.
- Sin bucles de carga.
- Tests en verde.
