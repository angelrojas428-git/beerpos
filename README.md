# BeerPOS — Micro-App Web (PWA) para despachos de cerveza

Sistema multi-tenant para tascas/licorerías/restaurantes: venta y despacho de cervezas en tiempo real, sin hardware adicional (tablet/PC/teléfono). Incluye flujo de cliente con saldo (QR/enlace), venta rápida con código de 3 dígitos, multi-divisa USD/VES y API REST sobre PostgreSQL.

## Stack
- **Frontend:** HTML5 + Tailwind CSS, Alpine.js, esbuild bundles, PWA (manifest + service worker), mobile-first (cliente) / tablet-first (barra).
- **Backend:** Node.js + Express (ESM), API REST y Socket.IO.
- **Base de datos:** PostgreSQL (multi-tenant con `establishment_id`).

## Estructura
```
app-licorerias/
├─ backend/
│  ├─ .env.example
│  ├─ package.json
│  └─ src/
│     ├─ index.js            # Express + sirve frontend estático
│     ├─ lib.js              # helpers (token, tasa)
│     ├─ db/
│     │  ├─ pool.js          # conexión pg
│     │  └─ init.js          # ejecuta db/schema.sql
│     └─ routes/
│        ├─ establishments.js
│        ├─ clients.js
│        ├─ transactions.js
│        └─ redemptions.js
├─ db/
│  └─ schema.sql             # esquema exacto solicitado + seed demo
├─ frontend/
│  ├─ index.html             # vista bartender y cliente (SPA ligera)
│  ├─ css/app.css
│  ├─ js/app.js
│  ├─ manifest.webmanifest
│  └─ sw.js
└─ README.md
```

## Requisitos
- Node.js 18+
- PostgreSQL 13+ (puerto 5432 por defecto)

## Configuración y ejecución

1. **Crear base de datos y configurar entorno**
   ```bash
   # en PostgreSQL
   createdb beerpos
   ```
   ```powershell
   cd D:\app-licorerias\backend
   copy .env.example .env
   # editar .env: DATABASE_URL=postgresql://usuario:clave@localhost:5432/beerpos
   npm install
   npm run db:init
   npm start
   ```
   API y frontend se sirven en `http://localhost:3001` (el backend sirve `frontend/` como estático).
   `npm start` construye los recursos del frontend con esbuild y Tailwind CSS antes de iniciar Express. Ejecuta `npm run build` para reconstruirlos manualmente.

2. **Accesos**
   - **Bartender/Barra:** `http://localhost:3001/?est=1`
   - **Cliente (por token):** `http://localhost:3001/c/<access_token>` (se genera al registrar/cargar cliente; el enlace se muestra en la UI de barra).

## Flujos implementados

### Flujo A — Cliente frecuente / combo (saldo + enlace único)
- **Registro express:** barra registra `Nombre`, `Cédula`, `Teléfono` (`POST /api/clients`). Se genera `access_token` único y enlace `/c/:token`.
- **Carga de saldo:** `POST /api/clients/:id/charge-combo` descuenta en caja (registra `COMBO_PURCHASE` con montos USD/VES) y suma `current_balance` en transacción DB.
- **Despacho sin fricción (cliente confirma):** el cliente abre su enlace (puede acceder desde QR impreso que apunte a su URL personal o escaneando/abriendo su link guardado), elige cantidad y pulsa **Retirar** (`POST /api/clients/token/:token/redeem`). Se descuenta saldo con `FOR UPDATE`, se registra `REDEMPTION` y se muestra **confirmación animada** con sello, hora/fecha en vivo y color del día (anti-captura básica). Bartender verifica visualmente.
- **Alerta de saldo bajo:** si `current_balance <= 2` se muestra aviso de recarga.

### Flujo B — Venta rápida (sin teléfono), código 3 dígitos
- Botón **⚡ Venta Rápida**: `POST /api/redemptions/fast` genera código `000-999` aleatorio único entre pendientes para el establecimiento, crea `fast_redemptions` (`PENDING`, expira a los 15 minutos por defecto) y registra `FAST_SALE` con montos.
- Lista de pendientes y botón **✓ Despachar**: `POST /api/redemptions/fast/:id/dispatch` marca `COMPLETED`. No se usa impresora ni lector láser.
- La pantalla de barra recibe ventas, despachos y expiraciones al instante por Socket.IO. **Pantalla secundaria** abre una vista de display autenticada; se pueden activar alertas de sonido y vibración desde el navegador.

### Multi-divisa USD/VES y calculadora
- Tasa vigente en `exchange_rates` por establecimiento (`GET/POST /api/establishments/:id/rate`), editable desde Ajustes.
- Precio cerveza USD en `establishments.beer_price_usd` (`PATCH /api/establishments/:id/price`).
- **Calculadora (vista cliente):** ingresa cantidad y muestra total en **$** y **Bs.** al instante usando precio y tasa actuales.

## API (resumen)
- `GET /api/health`
- `GET /api/establishments/:id` — datos + tasa vigente
- `PATCH /api/establishments/:id` — actualiza datos y branding (logo, color principal y secundario)
- `GET|POST /api/establishments/:id/rate` · `PATCH /api/establishments/:id/price`
- `GET /api/clients?establishment_id=<id>` · `GET /api/clients/token/:token` · `POST /api/clients/token/:token/redeem` · `POST /api/clients/:id/charge-combo`
- `POST /api/clients/:id/rotate-token` — invalida el QR anterior; requiere sesión de staff
- `POST /api/clients/:id/token-expire` — define expiración (1–365 días); requiere sesión de staff
- `POST|GET /api/redemptions/fast` · `POST /api/redemptions/fast/:id/dispatch` · `POST /api/redemptions/fast/expire`
- `GET /api/transactions` · `GET /api/transactions/summary/:establishmentId` · `GET /api/transactions/report/:establishmentId?date=YYYY-MM-DD`

## Base de datos
`db/schema.sql` implementa las tablas `establishments`, `exchange_rates`, `clients`, `transactions`, `fast_redemptions` e índices de búsqueda, sincronización y reportes. Las ventas y los despachos conservan las referencias de staff cuando hay sesión. Incluye seed de establecimiento demo (id=1) y tasa inicial para arranque rápido. Todas las tablas principales llevan `establishment_id` (multi-tenant).

## Sprint 3 — Personalización, PWA offline y rendimiento
- Cada establecimiento puede configurar logo, color principal y secundario desde **Ajustes**. El branding aparece en la vista del cliente y en las tarjetas/QR; `npm run db:init` agrega el campo secundario y los identificadores de sincronización a bases ya existentes.
- La app shell, estilos y JavaScript (incluidos Alpine.js y QRCode) se almacenan en caché para abrir la aplicación sin red. Las **ventas rápidas** creadas sin conexión se guardan en IndexedDB y se envían con Background Sync o al recuperar conectividad. El identificador de solicitud evita duplicarlas al reintentar; cargos y despachos no se encolan.
- Express comprime respuestas con gzip cuando el cliente lo admite. El comando de build genera JavaScript minificado y CSS Tailwind local, incluidos en la caché offline.

## Sprint 4 — Analítica y pruebas automatizadas
- La pestaña **Reportes** resume ventas, cervezas vendidas/despachadas e ingresos USD/VES para una fecha seleccionada. El día se delimita usando la zona horaria configurada en PostgreSQL.
- Las ventas y los despachos de códigos rápidos guardan el bartender cuando la operación llega con una sesión válida. Los retiros QR ejecutados directamente por el cliente no identifican a un operador y se muestran como **Sin atribuir**.
- Ejecuta `cd backend` y `npm test` para las pruebas Jest/Supertest de cobro de combos, despacho rápido y reportes. Los tests levantan las rutas Express y simulan el pool PostgreSQL; no requieren una base de datos de pruebas.

## Notas de seguridad/operación
- Acceso de cliente por `access_token` opaco en URL; redenciones y cargos usan transacciones con bloqueo de fila (`FOR UPDATE`) para consistencia de saldo.
- Las ventas rápidas expiran cada minuto mediante el cron del backend. Configura `FAST_SALE_EXPIRY_MINUTES` entre `15` y `30` (por defecto `15`). El login limita intentos a 5 cada 15 minutos; ventas, despachos y rotaciones de QR tienen limitadores específicos.
- Los sockets requieren un token de sesión de staff y se agregan automáticamente a la sala de su establecimiento. Tras iniciar sesión, abre **Pantalla secundaria** o accede a `/?display=1&est=<id>` en la misma sesión de navegador.
- La rotación reemplaza el token en la base de datos; enlaces y QR anteriores dejan de ser válidos. El acceso cliente también rechaza tokens vencidos.
- Para producción: restringir `CORS_ORIGIN`, servir detrás de HTTPS y proteger con autorización de staff las rutas administrativas restantes.

## Próximos pasos sugeridos
- Aplicar autorización de staff por rol a las rutas administrativas restantes.
- Reportes por rango de fechas y exportación.
