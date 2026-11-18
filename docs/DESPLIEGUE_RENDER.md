# Despliegue GRATIS en Render (sin tarjeta) — BeerPOS

> BeerPOS · Node/Express + PostgreSQL + Socket.io/SSE · Docker.
> Esta guía deja la app corriendo en Internet **gratis**, sin tarjeta, para probar en remoto.
> El archivo `render.yaml` ya está configurado para el plan **free**.

---

## 0. Qué necesitas

- Cuenta en [GitHub](https://github.com) (ya la tienes).
- Cuenta en [Render](https://render.com) creada con **"Sign up with GitHub"**. El plan gratis **no pide tarjeta**.
- Nada más. No necesitas CLI ni dominio propio (usas la URL `*.onrender.com`).

> ⚠️ **Nunca** subas tu `.env` real ni las carpetas `backend/data`, `backend/backups`, `backend/uploads` (ya están en `.gitignore`).

---

## 1. Subir el código a GitHub

Desde la carpeta del proyecto (`D:\app-licorerias`):

```bash
git add .
git commit -m "chore: deploy"
git branch -M main
```

Asegúrate de que **no** se suban datos sensibles:

```bash
git ls-files | grep -E "backend/(data|backups|uploads)"
# debe salir vacío
```

Crea un repositorio **vacío** en GitHub (sin README, sin .gitignore) y sube:

```bash
git remote add origin https://github.com/TU-USUARIO/beerpos.git
git push -u origin main
```

- Si Git pide autenticación, inicia sesión en el navegador (Git Credential Manager) o usa un **Personal Access Token** como contraseña.
- Verifica en GitHub que el código aparece y que **no** están `backend/data`, `backend/backups`, `backend/uploads`.

---

## 2. Crear el Blueprint en Render

1. Entra a <https://dashboard.render.com> → **New** → **Blueprint**.
2. Conecta tu cuenta de GitHub y selecciona el repo `beerpos`.
3. Render lee `render.yaml` y crea:
   - **Web Service** Docker → plan **Free**.
   - **Postgres** → plan **Free**.
4. Confirma y espera el primer build/deploy.

> Si Render te pide elegir plan, elige **Free** en ambos (web y base de datos).

---

## 3. Configurar variables de entorno

En el servicio → **Environment** (Render las pide al crear el Blueprint si están como `sync: false`):

| Variable | Valor | Notas |
|---|---|---|
| `CORS_ORIGIN` | `https://beerpos.onrender.com` | **obligatoria**, nunca `*`. Usa la URL real que Render te asigne. |
| `JWT_SECRET` | cadena larga aleatoria | p. ej. `openssl rand -hex 32` |
| `BOOTSTRAP_ADMIN_NAME` | `admin` | usuario del super-administrador |
| `BOOTSTRAP_ADMIN_PIN` | PIN de 6–12 dígitos | ej. `483920`. **No** uses `1234`. |
| `REDIS_URL` | opcional | para sesiones persistentes (Render Key Value) |
| `S3_BACKUP_*` | opcional | backups offsite |

`DB_AUTOINIT=1`, `NODE_ENV`, `TRUST_PROXY` y `FINGERPRINT_ENCRYPTION_KEY` ya vienen en `render.yaml` (la clave de fingerprint la genera Render).

---

## 4. Inicialización automática (sin shell)

El plan Free **no tiene shell** ni *pre-deploy command*, así que **no** hay que ejecutar `db:init` ni `seedPlatformAdmin` a mano. En el **primer arranque**, la app:

1. Aplica `db/schema.sql` (idempotente) porque `DB_AUTOINIT=1`.
2. Crea el super-admin con `BOOTSTRAP_ADMIN_NAME` / `BOOTSTRAP_ADMIN_PIN` si no existe.

En los **reinicios** no duplica el admin ni cambia el PIN. Para rotar el PIN: pon `BOOTSTRAP_ADMIN_ROTATE=1`, redeploy, y vuelve a `0`.

---

## 5. Verificar

- **Health:** `https://beerpos.onrender.com/api/health/live` → `{"ok":true,"db":"up"}`.
- **Consola super-admin:** `https://beerpos.onrender.com/admin.html` → entra con `BOOTSTRAP_ADMIN_NAME` / `BOOTSTRAP_ADMIN_PIN`.
- **Onboarding:** crea el primer comercio desde la consola.
- **Smoke test automático** (desde `backend/`):

```bash
# PowerShell
$env:SMOKE_BASE_URL='https://beerpos.onrender.com'
$env:SMOKE_ADMIN_NAME='admin'; $env:SMOKE_ADMIN_PIN='483920'
npm run smoke
```

> La primera petición tras 15 min de inactividad tarda ~1 min (Render despierta el servicio).

---

## 6. Límites del plan Free (importante)

- **Se duerme** tras 15 min sin tráfico; despierta en ~1 min. Los mensajes WebSocket cuentan como actividad, así que Socket.io se mantiene mientras haya usuarios.
- **La base de datos expira a los 30 días** (Render la borra tras 14 días de gracia). Sirve para probar; para un piloto real hay que subir el DB a plan de pago (~$6/mes).
- **Sin disco persistente:** los logos subidos se pierden al reiniciar.
- **750 horas/mes** por workspace; se agotan si el servicio no duerme lo suficiente.
- **Sin backups** de la BD gratis.

### Cuándo conviene pagar
- Piloto comercial real, datos que deban persistir >30 días, o 24/7 sin sleeps → web service `starter` (~$7/mes) y/o Postgres de pago.

---

## 7. Problemas comunes

- **"Build failed"**: revisa los logs del build en Render; suele ser una dependencia que no instala.
- **Login dice credenciales inválidas**: revisa `BOOTSTRAP_ADMIN_NAME`/`PIN` y que el bootstrap corrió (logs: `[bootstrap] platform admin ... created`).
- **CORS/consola con errores**: `CORS_ORIGIN` debe ser exactamente la URL `https://...onrender.com` (sin barra final).
- **La web "carga" mucho la primera vez**: es el *spin-up* del plan free; espera ~1 min.