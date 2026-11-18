# Despliegue en Render — Checklist paso a paso

> BeerPOS · Node/Express + PostgreSQL + Socket.io/SSE · Dockerfile incluido.
> Este documento es la guía operativa para el primer despliegue y las pruebas remotas.

---

## 0. Requisitos previos

- Cuenta en [Render](https://render.com) (plan **Starter** o superior: el plan free suspende el servicio por inactividad y rompe Socket.io/SSE).
- Repositorio en GitHub/GitLab con este código.
- Un dominio (opcional) apuntando a Render, o usar la URL `*.onrender.com`.

> ⚠️ **Nunca** subas tu `.env` real ni las carpetas `backend/data`, `backend/backups`, `backend/uploads` (ya están en `.gitignore`).

---

## 1. Subir el código

```bash
git add .
git commit -m "chore: deploy hardening"
git push origin main
```

Verifica que **no** se suban datos sensibles:

```bash
git ls-files | grep -E "backend/(data|backups|uploads)"   # debe salir vacío
```

---

## 2. Crear el Blueprint en Render

1. Render → **New → Blueprint**.
2. Selecciona el repo. Render leerá `render.yaml` y creará:
   - Servicio web **Docker** (`beerpos`).
   - Base de datos **PostgreSQL** gestionada (`beerpos-db`).
3. Espera al primer build/deploy.

---

## 3. Configurar variables de entorno (Dashboard → Environment)

Obligatorias / recomendadas:

| Variable | Valor | Notas |
|---|---|---|
| `NODE_ENV` | `production` | ya está en render.yaml |
| `CORS_ORIGIN` | `https://TU-APP.onrender.com` | **obligatoria**, nunca `*` |
| `FINGERPRINT_ENCRYPTION_KEY` | generada por Render | 64 hex |
| `DATABASE_URL` | provista por Render | desde `beerpos-db` |
| `REDIS_URL` | `redis://...` o Key Value | **recomendado** para sesiones persistentes |
| `TRUST_PROXY` | `1` | ya está |
| `SESSION_TTL_MS` | `28800000` | 8 h |
| `S3_BACKUP_*` | opcional | backups offsite |

> Si no configuras `REDIS_URL`, las sesiones se guardan en `/app/data` (disco efímero): se pierden en cada reinicio y el staff vuelve a iniciar sesión.

---

## 4. Inicializar la base de datos (una sola vez)

En Render → servicio → **Shell**:

```bash
npm run db:init
```

Esto crea tablas e índices. **No** crea datos demo ni credenciales por defecto.

---

## 5. Crear el super-administrador (una sola vez)

```bash
node backend/scripts/seedPlatformAdmin.js <nombre> <pin-fuerte-6-a-12-digitos>
```

Ejemplo:

```bash
node backend/scripts/seedPlatformAdmin.js admin 483920
```

> No uses `1234`. El PIN se guarda hasheado (bcrypt).

---

## 6. Verificar el despliegue

- **Health:** `https://TU-APP.onrender.com/api/health/live` → `{"ok":true,"db":"up"}`.
- **Consola super-admin:** `https://TU-APP.onrender.com/admin.html` → inicia sesión con `<nombre>` y el PIN creado.
- **Onboarding:** desde la consola, crea el primer comercio (nombre, dueño, PIN, precio, tasa).
- **Barra/PWA:** `https://TU-APP.onrender.com/?est=<id>` → inicia sesión con el dueño del comercio.

---

## 7. Dominio propio (opcional)

1. Render → Settings → **Custom Domains** → añade tu dominio.
2. Crea el registro DNS (CNAME o A) que Render indique.
3. Render emite el certificado TLS automáticamente.
4. Actualiza `CORS_ORIGIN` para incluir el dominio final.

---

## 8. Backups

- Local diarios a las 02:00 en `/app/backend/backups` (disco efímero).
- **Offsite (recomendado):** configura `S3_BACKUP_*` (AWS S3, Cloudflare R2, Backblaze B2, MinIO…).
- Probar restauración:
  ```bash
  npm run backup:list                 # lista backups en la nube
  npm run backup:restore <timestamp>  # descarga un grupo a backend/backups/
  ```

---

## 9. Verificación post-despliegue (checklist)

- [ ] `/api/health/live` responde 200 con `db: up`.
- [ ] Login en `/admin.html` OK.
- [ ] Alta de un comercio desde la consola OK.
- [ ] Login de staff en la barra OK.
- [ ] Venta rápida genera código y se despacha.
- [ ] Registro de cliente + QR + flujo del cliente OK.
- [ ] Carga/abono de fiado OK (con límite asignado).
- [ ] Reporte con fechas y export CSV/Excel/PDF OK.
- [ ] Socket.io/SSE: los cambios se reflejan en vivo.
- [ ] HTTPS activo y `CORS_ORIGIN` correcto (sin errores de consola).
- [ ] Backup offsite configurado y restauración probada.

---

## 10. Rollback

- Render → **Deploys** → selecciona un deploy anterior → **Rollback**.
- Si el problema es de configuración, corrige env vars y **Manual Deploy → Clear build cache & deploy**.
- Si hay migración de esquema problemática, restaura el backup previo (`backup:restore`) y despliega el commit anterior.

---

## 11. Notas de seguridad ya aplicadas

- Sin credenciales por defecto (los seeds demo se movieron a `scripts/seedDemo.js`, sólo dev).
- Alta de comercios restringida a `platform_admin`.
- Tokens de cliente hasheados en BD y sólo por header.
- CORS restringido en producción + fail-fast si falta configuración.
- Rate limiting en login y endpoints públicos.
- Cabeceras de seguridad (Helmet + CSP) en producción.
- `credit_ledger` inmutable por trigger (anti-fraude).