# BeerPOS — Plan de Lanzamiento, Seguridad y Monetización

> Documento de propuesta para lectura y análisis previo. **No ejecuta ningún cambio.**
> Estado: redactado el 2026-11-17. Autor: Kilo (a partir del código actual del repo).

---

## 1. Resumen ejecutivo

BeerPOS es hoy un **POS multi-tenant funcional** (backend Node/Express + PostgreSQL, frontend Alpine/PWA) orientado a licorerías/tascas que venden cerveza por combos, con saldo prepagado de clientes, canjes por código QR anti-fraude, ventas rápidas con código de 3 dígitos, reportes exportables y datos biométricos cifrados.

El objetivo de este plan es pasar de **"corre en mi PC"** a **"se vende y opera en N establecimientos"**, en tres frentes:

1. **Seguridad y pruebas** — cerrar brechas, endurecer configuración y montar un proceso de auditoría continua.
2. **Operación multi-tenant** — poder dar de alta comercios, aislarlos y soportarlos sin intervención manual.
3. **Monetización y go-to-market** — modelo de precios, cobro (pago móvil/Zelle/Stripe) y despliegue comercial.

La ruta recomendada es **por fases**, empezando por hardening local y terminando por cobro recurrente y pilotos comerciales. Cada fase es independiente y valida el paso anterior antes de avanzar.

---

## 2. Estado actual (lo que ya está resuelto)

Fortalezas confirmadas leyendo el código:

- **Multi-tenant real**: `establishments`, `staff`, `clients`, `transactions`, `client_orders`, `fast_redemptions`, `client_fingerprints`, `audit_log`, `exchange_rates` — todo con `establishment_id` y FKs `ON DELETE CASCADE`.
- **Autenticación**:
  - PIN hasheado con **bcrypt** (`lib/pin.js`) + auto-migración de PINs en texto plano al primer login.
  - **2FA TOTP** (`lib/totp.js`, `speakeasy`) con challenge de 5 min.
  - Sesiones persistentes en `data/sessions.json` con TTL 8h y limpieza automática.
  - Middleware de autorización: `requireStaffSession`, `requireStaffSessionForEst`, `requireOwnerRole`.
- **Autorización de inquilino**: `requireStaffSessionForEst` impide que un comercio toque datos de otro (403).
- **Anti-fraude**:
  - Tokens de cliente (`access_token`) con expiración y rotación.
  - Códigos de verificación de 3-10 dígitos (`crypto.randomInt`), con expiración.
  - Ventas rápidas con código de 3 dígitos y expiración por cron.
- **Cifrado biométrico**: AES-256-GCM (`lib/fingerprint.js`) con IV + authTag; el server **aborta si falta la clave**.
- **Superficie de red**: Helmet, CORS configurable, compresión, `express-rate-limit` con limitadores dedicados (auth, clientes, canjes, ventas rápidas), Socket.io con autenticación por sala `est:{id}`.
- **Operación**: backups por cron, `audit_log` de acciones críticas, health endpoint, logs en consola.
- **Calidad**: 3 suites Jest + supertest (clients, redemptions, transactions) con casos de borde (fechas bisiestas, sesiones expiradas, transacciones atómicas).

Conclusión: la base técnica es **sólida para un piloto**, pero tiene brechas concretas que impiden producción comercial seria.

---

## 3. Diagnóstico: brechas y vulnerabilidades (priorizadas)

### 🔴 Críticas (bloquean producción / riesgo de pérdida de datos o acceso)

| # | Hallazgo | Dónde | Riesgo | Acción |
|---|----------|-------|--------|--------|
| C1 | Sesiones en **archivo plano** (`data/sessions.json`) | `lib/session.js` | No escala a múltiples instancias; se pierden si el contenedor es efímero; condición de carrera en escritura concurrente | Migrar a **Redis** o tabla `sessions` en Postgres |
| C2 | `cors({ origin: '*' })` por defecto | `index.js:38` | Cualquier web puede llamar la API con token robado | Fijar `CORS_ORIGIN` a dominios reales en prod |
| C3 | Helmet con **CSP deshabilitado** | `index.js:35` | XSS (el login guarda token en `localStorage`; Alpine usa estilos inline) | CSP estricta con `script-src`/`style-src` permitidos y `connect-src` propio |
| C4 | **Sin HTTPS/TLS** ni `trust proxy` | `index.js` | Credenciales y tokens viajan en claro; rate-limit e IP mal resueltas tras proxy | Reverse proxy (Caddy/Nginx) + TLS + `app.set('trust proxy', 1)` |
| C5 | `JWT_SECRET` con default débil `'beerpos-dev-secret-change-me'` | `lib/config.js` | Si se usa en prod, firma predecible | Exigir variable en prod (fail-fast si falta/default) |
| C6 | **Token de cliente en claro** en BD (`clients.access_token`) | `schema.sql:44` | Fuga de BD = secuestro de sesiones de clientes | Hashear token (sha256) y comparar hash |
| C7 | `FINGERPRINT_ENCRYPTION_KEY` en `.env` | `.env` | Clave maestra de datos biométricos expuesta | Secrets manager (Vault/AWS SM) + plan de rotación |
| C8 | Backups **solo locales** (`lib/backup.js`) | cron | Un desastre borra todo | Backups offsite (S3/Blob) cifrados + prueba de restauración |

### 🟠 Altas (afectan operación multi-tenant y confiabilidad)

| # | Hallazgo | Acción |
|---|----------|--------|
| A1 | No hay **super-admin de plataforma** | El alta de comercios la hace cualquier `owner` autenticado (`auth.js:184`). Crear rol `platform_admin` + consola para onboarding/soporte |
| A2 | **Sin framework de migraciones** (`schema.sql` con `IF NOT EXISTS`) | Migraciones versionadas (`node-pg-migrate`) para desplegar cambios de esquema sin riesgo |
| A3 | `uploads/` (logos) en disco local | No escala ni sobrevive a redeploys. Usar object storage (S3) + CDN, o volumen persistente |
| A4 | Tasa de cambio externa `bcv.today` sin caché/alternativa | Caché temporal + fallback manual + alerta si la API cae |
| A5 | Sin **observabilidad** (logs estructurados, métricas, tracing) | `pino` + request IDs + métricas básicas (latencia, errores, sesiones) |
| A6 | Sin **staging** ni CI/CD | Entorno de staging + pipeline (lint, tests, build, deploy) |
| A7 | Sin **Dockerfile/compose** | Contenerizar backend + Postgres + (Redis) para despliegue reproducible |
| A8 | Rate-limit por IP mal resuelto tras proxy | `trust proxy` + `keyGenerator` por token/usuario además de IP |
| A9 | Notificaciones a clientes (email/SMS) inexistentes | Opcional pero recomendado para recuperación de tokens y avisos |

### 🟡 Medias (calidad y mantenibilidad)

- `frontend/js/app.js` monolítico (~1835 líneas) — dificulta mantenimiento y revisión de seguridad.
- Sin lockout de PIN tras N intentos (solo rate-limit por IP; útil añadir por usuario/establecimiento).
- Sin política de contraseña/PIN fuerte documentada (PIN de 4 dígitos es débil; valorar PIN de 6+ o frase).
- Ausencia de pruebas E2E (solo unitarias con supertest).
- `clients.test.js` cubre `charge-combo`; falta cobertura de `client_orders`, `auth`, `establishments`, fingerprints.

---

## 4. Arquitectura objetivo (propuesta)

```
                          ┌─────────────────────────────┐
   Clientes (QR)  ─────►  │   CDN / Reverse Proxy (Caddy)│  ← TLS, WAF básico
   Staff (PWA)    ─────►  │   + rate limit edge          │
                          └──────────────┬──────────────┘
                                         │  (origen restringido)
                          ┌──────────────▼──────────────┐
                          │   API Node/Express (Docker)  │
                          │   - helmet + CSP estricta    │
                          │   - trust proxy              │
                          │   - Socket.io / SSE          │
                          │   - rate limit por usuario   │
                          └───┬───────────┬─────────┬────┘
                              │           │         │
                   ┌──────────▼──┐  ┌─────▼─────┐ ┌─▼──────────────┐
                   │ PostgreSQL  │  │  Redis    │ │ Object Storage │
                   │ (managed)   │  │ (sesiones │ │ (logos +       │
                   │             │  │  + cache) │ │  backups S3)   │
                   └─────────────┘  └───────────┘ └────────────────┘
                              │
                   ┌──────────▼──────────┐
                   │  Super-admin console │
                   │  (onboarding,       │
                   │   licencias, soporte)│
                   └─────────────────────┘
```

Cambios clave frente a hoy: sesiones a Redis, logos/backups a object storage, proxy TLS con `trust proxy`, CSP activa, secretos en gestor, y una **consola de super-admin** para operar el SaaS.

---

## 5. Fases del plan

> Cada fase termina con un **criterio de salida** verificable. No se avanza sin cumplirlo.

### Fase 0 — Hardening y pruebas (local) · *sin tocar producción todavía*
**Objetivo:** dejar la app segura y confiable en tu entorno de desarrollo antes de exponerla.

- Endurecer config: exigir `JWT_SECRET`/`FINGERPRINT_ENCRYPTION_KEY` en prod, quitar CORS `*`, activar CSP de Helmet (con ajustes para Alpine/Twemoji), `trust proxy` cuando corresponda.
- Hashear `clients.access_token` (sha256) y migrar tokens existentes.
- Añadir **lockout por usuario/establecimiento** y PIN mínimo de 6 dígitos.
- **Auditoría de seguridad local**:
  - Revisión manual de cada ruta (autorización, inyección SQL, IDOR, validación de entrada).
  - Escaneo de dependencias (`npm audit`, `osv-scanner`) — hay 1 severidad alta hoy.
  - Pruebas con `zaproxy`/`Burp` (baseline) contra la instancia local.
- Ampliar suite de tests a: `auth`, `client_orders`, `establishments`, `client-fingerprints`; añadir pruebas E2E con Playwright (login, pedido QR, canje, reporte).
- Documentar modelo de amenazas y matriz de riesgos.

**Criterio de salida:** `npm test` en verde, `npm audit` sin críticas/altas, checklist de autorización revisado, E2E cubriendo flujos principales.

### Fase 1 — Contenerización y despliegue en la nube
**Objetivo:** que la app corra reproducible en un servidor, con TLS y datos persistentes.

- `Dockerfile` multi-stage para backend; `docker-compose` con Postgres (+Redis).
- Reverse proxy **Caddy** (TLS automático Let's Encrypt) delante de la API.
- PostgreSQL **managed** (o volumen persistente con backups) + migraciones `node-pg-migrate`.
- Sesiones a **Redis**; `trust proxy` activo; rate-limit por usuario.
- Object storage (S3/R2/Blob) para logos y backups; cron de backup offsite cifrado + **prueba de restauración**.
- Variables de entorno en gestor de secretos; `.env` de producción fuera del repo.
- Health checks y logs estructurados (`pino`).

**Criterio de salida:** `https://tu-dominio` sirve la app con TLS válido, login OK, datos persisten tras reinicio, backup restaurado con éxito en prueba.

### Fase 2 — Operación multi-tenant (SaaS real)
**Objetivo:** dar de alta comercios sin tocar la base de datos a mano.

- Rol `platform_admin` + **consola de super-admin**: crear/editar comercios, suspender, ver métricas agregadas.
- Flujo de **onboarding** de nuevo comercio (crear establishment + owner + rate + branding) desde la consola.
- Aislamiento verificado por pruebas de inquilino (un comercio no ve datos de otro).
- Panel de soporte: ver logs de auditoría por comercio, forzar logout, rotar tokens.

**Criterio de salida:** alta de un comercio de prueba en <2 min desde la consola, sin SQL manual; prueba de aislamiento entre 2 comercios en verde.

### Fase 3 — Monetización y cobro
**Objetivo:** cobrar de forma recurrente y sostenible.

- Modelo de **suscripción por establecimiento** con planes (ver §6).
- Integración de pago **local (Venezuela)**: Pago Móvil / transferencia + **verificación manual o pasarela**; e internacional: **Stripe** o **Mercado Pago**.
- Tabla `subscriptions` (plan, estado, fecha de corte, método) + middleware que **suspende** comercios impagos (ya existe `establishments.active`).
- Panel de facturación en la consola de super-admin.
- (Opcional) modo **freemium** con límites por plan (nº clientes, reportes, QR).

**Criterio de salida:** un comercio de prueba pasa de activo → suspendido por impago → reactivado por pago, automáticamente; cobro real de prueba procesado.

### Fase 4 — Go-to-market y soporte
**Objetivo:** conseguir y retener comercios reales.

- **Pilotos gratuitos/bonificados** con 3-5 licorerías locales; métricas de uso y feedback.
- Documentación de usuario (manual de alta, operación diaria, cierre de caja) + videos cortos.
- Onboarding asistido y soporte por WhatsApp.
- Precio de lanzamiento con descuento; testimonios y caso de éxito del piloto.
- Roadmap público de features ( loyalty, inventario, multi-sucursal, delivery).

**Criterio de salida:** ≥3 comercios en piloto activo con uso semanal real y feedback recogido.

---

## 6. Modelo de monetización (propuesta a validar)

**SaaS por suscripción mensual/anual por establecimiento**, con planes sugeridos:

| Plan | Precio (ej. USD/mes) | Incluye |
|------|----------------------|---------|
| **Gratis** | $0 | 1 establecimiento, hasta 20 clientes, reportes básicos |
| **Pro** | $9–15 | 1 establecimiento, clientes ilimitados, todos los reportes, export PDF/Excel, QR anti-fraude |
| **Business** | $25–40 | Hasta 3 sucursales, 2FA, biométricos, soporte prioritario |
| **Enterprise** | a cotizar | Multi-sucursal, SLA, integraciones, marca blanca |

**Cobro en Venezuela (clave para el mercado local):**
- Pago Móvil / transferencia + confirmación manual desde la consola (MVP sin pasarela).
- Opción Binance/USDT para clientes tech.
- Stripe/Mercado Pago para clientes con tarjeta internacional (fase 3b).

**Canales de venta:** venta directa a licorerías/tascas de tu ciudad, referidos, y presencia en redes/WhatsApp Business.

> ⚠️ Los precios son un punto de partida; se ajustan tras los pilotos (Fase 4) con datos reales de disposición a pagar.

---

## 7. Estrategia de pruebas y seguridad

- **Automatizadas**: Jest + supertest (unidad/integración) en cada PR; ampliar cobertura a módulos sin tests.
- **E2E**: Playwright para flujos críticos (login staff, pedido QR del cliente, canje, reporte, export).
- **Seguridad continua**:
  - `npm audit` + `osv-scanner` en CI; bloqueo de altas/críticas.
  - Escaneo dinámico (ZAP baseline) contra staging en cada release.
  - Revisión de cabeceras (securityheaders.com) y TLS (SSL Labs) tras Fase 1.
  - Pruebas de **aislamiento multi-tenant** (un comercio intenta leer/escribir el id de otro).
- **Operación**: health checks, alertas de caída, y prueba trimestral de restauración de backups.
- **Datos biométricos**: por ser dato sensible, revisar requisitos legales/consentimiento; nunca loguear templates.

---

## 8. Riesgos y mitigaciones

| Riesgo | Mitigación |
|--------|-----------|
| Fuga de datos de clientes | Cifrado en tránsito (TLS) y en reposo (BD + backups), tokens hasheados, mínimo privilegio |
| Suspensión errónea por impago | Período de gracia + notificación antes de suspender; `active` reversible al instante |
| Dependencia de BCV externo | Caché + fallback manual + alerta |
| Crecimiento (muchos comercios) | Arquitectura stateless + Redis + object storage + réplicas de lectura |
| Abuso/fraude | Ya hay rate-limit, códigos y audit log; reforzar con alertas y revisión |
| Legal (datos personales/biométricos) | Política de privacidad, consentimiento, retención definida |

---

## 9. Cronograma estimado (orientativo)

| Fase | Duración estimada | Entregable |
|------|-------------------|------------|
| 0 — Hardening & pruebas | 1–2 semanas | App endurecida + suite de tests ampliada + auditoría |
| 1 — Docker & nube | 1–2 semanas | Despliegue HTTPS reproducible + backups verificados |
| 2 — Multi-tenant SaaS | 1–2 semanas | Consola super-admin + onboarding + aislamiento probado |
| 3 — Monetización | 1–2 semanas | Suscripciones + cobro + suspensión automática |
| 4 — Go-to-market | Continuo | ≥3 pilotos activos + documentación + soporte |

Total hasta "vendible en producción": **~5–8 semanas** de trabajo enfocado, asumiendo una persona con el código ya funcional.

---

## 10. Decisiones que necesito de ti antes de ejecutar

Para empezar, necesito que confirmes:

1. **Alcance inicial**: ¿quieres que arranque por la **Fase 0 (hardening + auditoría + tests)** — lo más urgente — o prefieres primero un **piloto local con 1-2 comercios** para validar el producto?
2. **Infraestructura objetivo**: ¿dónde se desplegará? (VPS propio, Render/Railway/Fly.io, AWS/GCP/Azure). Esto define Docker, proxy y backups.
3. **Base de datos**: ¿Postgres managed (ej. Neon, Supabase, RDS) o autogestionado con Docker?
4. **Método de cobro preferido** para el mercado venezolano: Pago Móvil/transferencia manual, Stripe, Mercado Pago, o mixto.
5. **Modelo de precios**: ¿te sirve la tabla de planes de §6 o tienes cifras/estrategia propias?
6. **Datos biométricos**: ¿mantener la huella dactilar como feature (implica más responsabilidad legal) o dejarla opcional/oculta por defecto?
7. **Ritmo**: ¿dedicación a tiempo completo o por etapas en tu tiempo libre? (ajusta el cronograma).

Cuando me confirmes estos puntos, prepararé la **Fase 0** como primer paso concreto (checklist de hardening + ampliación de tests + escaneo de dependencias), sin tocar nada de producción.