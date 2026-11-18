# Propuesta Técnica — Cuentas por Cobrar / Sistema de Fiado (BeerPOS)

> Estado: propuesta de diseño. **No modifica el sistema todavía.**
> Objetivo: agregar "fiado" (crédito) al POS actual sin romper el modelo existente de **saldo prepagado** (`clients.current_balance`, en unidades) ni los flujos de venta, canje, reportes y tiempo real.

---

## 0. Resumen ejecutivo

Hoy BeerPOS maneja **saldo a favor** (prepago): el cliente paga por adelantado y consume en unidades (`clients.current_balance`). El "fiado" es el **inverso**: el cliente consume ahora y debe dinero (saldo deudor en USD).

La propuesta introduce un **ledger de crédito inmutable** (`credit_ledger`) como fuente de verdad, un **saldo deudor cacheado** por cliente (`clients.credit_balance_usd`) para lecturas rápidas, y un **límite de crédito** por cliente (`clients.credit_limit_usd`). Todo se ancla al multi-tenant actual (`establishment_id`), a los roles (`owner` > `bartender`/`cashier`) y al `audit_log` existente.

Principios de diseño:
1. **Doble registro simplificado**: cada movimiento genera un asiento firmado (+ aumenta deuda, − la reduce) con `balance_after` (saldo resultante). Nunca se edita ni borra un asiento.
2. **Correcciones por compensación**: errores y notas de crédito se arreglan con asientos nuevos (opuestos y referenciados), no modificando historia.
3. **Autorización escalonada**: bartender puede vender fiado dentro de límite; **owner** para cambiar límites, ajustes, anulaciones y overrides.
4. **Consistencia**: operaciones atómicas con `SELECT ... FOR UPDATE` sobre el cliente (evita exceder el límite en concurrencia).
5. **Compatibilidad**: columnas nuevas opcionales (`credit_limit_usd` default 0 ⇒ fiado desactivado); sin migración destructiva.

---

## 1. Integración con el sistema actual

| Necesidad | Pieza existente que se reutiliza |
|---|---|
| Identidad y multi-tenant | `clients`, `establishments`, `staff`; `requireStaffSession`, `requireStaffSessionForEst`, `requireOwnerRole` (`src/middleware/auth.js`) |
| Auditoría | `audit_log` + `auditLog()` (`src/lib/audit.js`) |
| Dinero y transacciones | `transactions` (`amount_usd`, `amount_ves`, `payment_method`, `transaction_type`, `staff_id`, `client_id`) |
| Reportes / caja / export | `src/routes/transactions.js` (resumen, reportes, CSV/Excel/PDF) |
| Tiempo real | Socket.io (`src/lib/socket.js`) + SSE (`src/routes/events.js`) |
| Cliente / QR | `src/routes/clients.js`, `src/lib/token.js` |
| PDF | `pdfkit` ya instalado (para estado de cuenta) |
| Consola admin | `frontend/admin.html` (métricas y soporte) |
| Esquema | `db/schema.sql` (ALTERs idempotentes) |

**Separación de saldos (importante):** el prepago actual (`clients.current_balance`, entero en *unidades*) y el crédito (`credit_balance_usd`, *USD con 2 decimales*) son **independientes**. El crédito se denomina en USD para cuadrar con `transactions.amount_usd`. El cliente puede tener ambos; la UI mostrará "Saldo a favor" y "Debe" por separado, y opcionalmente un neto informativo.

---

## 2. Arquitectura del módulo (modelo de datos)

### 2.1 Columnas nuevas en `clients`

```sql
ALTER TABLE clients ADD COLUMN IF NOT EXISTS credit_limit_usd   DECIMAL(10,2) NOT NULL DEFAULT 0;  -- 0 = sin fiado
ALTER TABLE clients ADD COLUMN IF NOT EXISTS credit_balance_usd DECIMAL(10,2) NOT NULL DEFAULT 0;  -- deuda actual (cache)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS credit_hold_reason VARCHAR(120);                     -- opcional: motivo de bloqueo manual
```

- `credit_limit_usd = 0` ⇒ el cliente **no tiene fiado habilitado**.
- `credit_balance_usd` es **caché**; la verdad es `credit_ledger` (se recalcula con `SUM(amount_usd)`).

### 2.2 Ledger de crédito (fuente de verdad)

```sql
CREATE TABLE IF NOT EXISTS credit_ledger (
    id                SERIAL PRIMARY KEY,
    establishment_id  INT NOT NULL REFERENCES establishments(id) ON DELETE CASCADE,
    client_id         INT NOT NULL REFERENCES clients(id)        ON DELETE CASCADE,

    entry_type        VARCHAR(20) NOT NULL,
        -- CHARGE | PAYMENT | CREDIT_NOTE | ADJUSTMENT | VOID
    amount_usd        DECIMAL(12,2) NOT NULL,     -- firmado: + aumenta deuda, - la reduce
    balance_after_usd DECIMAL(12,2) NOT NULL,     -- saldo resultante tras el asiento

    amount_ves        DECIMAL(14,2),              -- equivalente en Bs (opcional)
    exchange_rate     DECIMAL(10,2),              -- tasa usada

    payment_method    VARCHAR(30),                -- PAYMENT: efectivo|pago_movil|zelle|transferencia
    reference_type    VARCHAR(30),                -- transaction | client_order | manual
    reference_id      INT,                        -- id en transactions / client_orders
    related_ledger_id INT REFERENCES credit_ledger(id), -- asiento original (VOID/CREDIT_NOTE)
    note              TEXT,                       -- obligatorio en ADJUSTMENT/VOID/CREDIT_NOTE
    staff_id          INT REFERENCES staff(id) ON DELETE SET NULL, -- quién autorizó
    created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_credit_ledger_client ON credit_ledger(client_id, created_at);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_est    ON credit_ledger(establishment_id, created_at);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_type   ON credit_ledger(entry_type, created_at);
```

**Inmutabilidad (anti-fraude):** un trigger bloquea `UPDATE`/`DELETE` sobre `credit_ledger` a nivel de base de datos:

```sql
CREATE OR REPLACE FUNCTION prevent_credit_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'credit_ledger es inmutable: use asientos compensatorios';
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_credit_ledger_immutable ON credit_ledger;
CREATE TRIGGER trg_credit_ledger_immutable
  BEFORE UPDATE OR DELETE ON credit_ledger
  FOR EACH ROW EXECUTE FUNCTION prevent_credit_ledger_mutation();
```

### 2.3 (Opcional) Asignación FIFO para antigüedad exacta

Para aging preciso se puede materializar la asignación de pagos a cargos:

```sql
CREATE TABLE IF NOT EXISTS credit_allocations (
    id           SERIAL PRIMARY KEY,
    charge_id    INT NOT NULL REFERENCES credit_ledger(id) ON DELETE CASCADE,
    payment_id   INT NOT NULL REFERENCES credit_ledger(id) ON DELETE CASCADE,
    amount_usd   DECIMAL(12,2) NOT NULL,  -- monto del pago aplicado a ese cargo
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

> **Decisión:** para el MVP, el aging se calcula **al vuelo** con FIFO desde el ledger (sin esta tabla). Se deja como mejora si el volumen lo exige.

### 2.4 Por qué ledger + saldo cacheado

- **Auditoría/ampliación**: inmutable, exportable, verificable.
- **Velocidad**: `credit_balance_usd` evita `SUM` en cada venta; se actualiza en la misma transacción.
- **Reconciliación**: `credit_balance_usd` debe ser siempre `SUM(credit_ledger.amount_usd)` para ese cliente; una tarea/chequeo puede auditarlo (test de invariante).

---

## 3. Flujo de operaciones

### 3.1 Venta a crédito (fiado)

```
Bartender: método "Fiado" → elige cliente → importe (o cantidad × precio)
  1. BEGIN
  2. SELECT ... FROM clients WHERE id=$1 FOR UPDATE        -- lock del cliente
  3. Validar: credit_limit_usd > 0
     y (credit_balance_usd + importe) <= credit_limit_usd
     (si excede → 409 "Límite de crédito excedido" y STOP,
      salvo override de owner con motivo)
  4. INSERT transactions (type='CREDIT_SALE', payment_method='credit',
       client_id, staff_id, quantity, amount_usd, amount_ves, exchange_rate)
  5. balance = credit_balance_usd + importe
     INSERT credit_ledger (CHARGE, +importe, balance_after=balance, reference=transaction.id)
     UPDATE clients SET credit_balance_usd = balance
  6. COMMIT
  7. auditLog('credit_sale', {...}) + emit realtime (socket/SSE)
```

- `transaction_type = 'CREDIT_SALE'` permite que el reporte de ventas muestre la venta (aunque no haya entrada de caja).
- La venta a crédito **no** incrementa caja; se distingue en reportes por `payment_method='credit'`.

### 3.2 Gestión del límite de crédito

- **Por cliente**: `POST /api/credit/clients/:id/limit { credit_limit_usd }` (solo `owner`), auditado `credit_limit_changed`.
- **Default del comercio** (opcional): `establishments.default_credit_limit_usd`, aplicado al crear clientes.
- **Bloqueo**: si `balance + nuevo > límite` ⇒ rechazo duro (409). Opcional: **aviso suave al 80%** y **bloqueo al 100%**.
- **Override de owner**: permite vender por encima del límite con `reason` obligatorio y audit `credit_override` (requiere rol owner; opcional step-up 2FA).

### 3.3 Abono / liquidación de la deuda

```
POST /api/credit/clients/:id/payment { amount_usd, payment_method, reference? }
  1. BEGIN; SELECT client FOR UPDATE
  2. amount = min(amount_usd, credit_balance_usd)   -- no se permite overpayment salvo conversión a saldo a favor
  3. balance = credit_balance_usd - amount
     INSERT credit_ledger (PAYMENT, -amount, balance_after=balance, payment_method, ...)
     UPDATE clients SET credit_balance_usd = balance
     INSERT transactions (type='CREDIT_PAYMENT', payment_method, amount_usd=amount, client_id, staff_id) -- para caja
  4. COMMIT; auditLog('credit_payment'); realtime
```

- **Pago total**: `amount = credit_balance_usd` ⇒ deuda 0.
- **Pago parcial**: `amount < balance` ⇒ deuda restante; se permiten múltiples abonos.
- **Overpayment**: por defecto se rechaza; opción "convertir excedente a saldo a favor" (`clients.current_balance`) si el negocio lo permite.

### 3.4 Notas de crédito / ajustes / anulaciones (errores)

- **CREDIT_NOTE**: reduce deuda por causa documentada (devolución, error). `amount_usd` negativo, `note` obligatorio, `related_ledger_id` al cargo corregido. Rol **owner**.
- **ADJUSTMENT**: corrección genérica (+ o −). `note` obligatorio. Rol **owner**.
- **VOID**: anula un asiento concreto por id; crea asiento opuesto con `related_ledger_id = asiento_original`. Rol **owner** + (opcional) step-up 2FA.

Regla: **nunca** se borra el original; se compensa.

---

## 4. Escenarios y casos de uso

### 4.1 Pagos parciales
- Soportado (3.3). El estado de cuenta muestra cada abono y el saldo resultante.
- La antigüedad se recalcula aplicando FIFO (los abonos reducen primero los cargos más viejos).

### 4.2 Límites de crédito (bloqueo por exceso)
- Validación atómica (lock) al vender. Mensajes claros: "Límite $50, disponible $18, consumo $25 → faltan $7".
- Niveles: **aviso 80%**, **bloqueo 100%**, **override owner** con motivo (auditado).
- Opcional: bloqueo manual por `credit_hold_reason` (ej. cliente moroso) independiente del límite.

### 4.3 Notas de crédito / ajustes por errores
- Flujo `CREDIT_NOTE`/`ADJUSTMENT`/`VOID` con motivo obligatorio y autorización owner.
- Visible en el estado de cuenta como línea especial (no altera el original).

### 4.4 Antigüedad de deuda (aging) y estado de cuenta

**Estado de cuenta** (`GET /api/credit/clients/:id/statement`): lista de asientos del ledger (fecha, tipo, cargo, abono, saldo) + PDF (pdfkit).

**Aging (FIFO)** — buckets por antigüedad del cargo no cancelado:
1. Partir de los cargos `CHARGE` ordenados por fecha.
2. Aplicar cada `PAYMENT` (y notas) al **cargo más viejo primero**.
3. El remanente de cada cargo cae en: **Corriente (≤30d)**, **31–60**, **61–90**, **>90** (respecto a la fecha del cargo).
4. `GET /api/credit/aging` devuelve por cliente: `{ corriente, d31_60, d61_90, d90_plus, total }`.

> Complejidad O(n·m) por cliente; con `credit_allocations` (2.3) sería O(1). Para MVP, FIFO al vuelo está bien.

---

## 5. Seguridad y auditoría

| Control | Mecanismo |
|---|---|
| Autenticación | `requireStaffSession` + `requireStaffSessionForEst` (multi-tenant) en todas las rutas `/api/credit` |
| Autorización escalonada | Venta fiado: `bartender`+; **owner**: límite, ajuste, nota, void, override |
| Inmutabilidad | Trigger DB bloquea `UPDATE`/`DELETE` en `credit_ledger` |
| Trazabilidad | `audit_log`: `credit_sale`, `credit_payment`, `credit_limit_changed`, `credit_adjusted`, `credit_note`, `credit_voided`, `credit_override` con `staff_id`, `client_id`, montos e IP |
| Motivo obligatorio | Ajustes/anulaciones/override exigen `reason` y lo persisten en `note`/`details` |
| Step-up 2FA | Reutilizar challenge TOTP (`routes/auth.js`) para void/ajuste/override |
| Concurrencia | `SELECT ... FOR UPDATE` sobre `clients` al vender/abonar |
| Reconciliación | Reporte "efectivo esperado vs. cobros de crédito" en el cierre de caja |
| Alertas | Tiempo real: deuda > X% del límite, o N ventas fiado en ventana corta (abuso) |
| Límite por staff | Opcional: tope de fiado por turno/vendedor |

**Anti-patrón prohibido:** editar/borrar asientos; registrar abonos sin asiento; vender fiado sin transacción; cambiar límite sin rol owner.

---

## 6. Interfaz de usuario (UX)

**En la venta (lo más importante):**
- Método de pago **"Fiado"** junto a efectivo/pago móvil/QR.
- Al elegir cliente, **badge** con: `Debe $X · Límite $Y · Disponible $Z` y **color**:
  - 🟢 verde (disponible amplio), 🟡 ámbar (>80% usado), 🔴 rojo (sin crédito / bloqueado / límite alcanzado).
- Si excede el límite: modal "Límite excedido" con opción **override (solo owner)** + campo de motivo.

**Panel "Cuentas por Cobrar" (nueva pestaña en la barra):**
- Tabla de clientes con deuda: nombre, deuda, límite, disponible, antigüedad (máx. días), última actividad.
- Acciones rápidas: **Abonar** (total/parcial), **Ver estado de cuenta** (PDF), **Ajustar** (owner).
- Orden por deuda o antigüedad; buscador.

**Tiempo real:** al registrar venta fiado o abono, se actualiza la tabla y el badge vía Socket.io/SSE (reusa `emitToRoom`/`broadcastSse`).

**Cliente (QR):** su display puede mostrar "Saldo a favor" y "Deuda" (opcional).

**Admin (`admin.html`):** métrica agregada "Deuda total por cobrar" y "Clientes morosos (>90d)".

---

## 7. API propuesta (prefijo `/api/credit`, salvo indicación)

| Método | Ruta | Rol | Descripción |
|---|---|---|---|
| GET | `/api/credit/clients` | staff | Clientes con deuda/límite/disponible + aging resumido |
| GET | `/api/credit/clients/:id/statement` | staff | Ledger del cliente (y `?format=pdf`) |
| GET | `/api/credit/aging` | staff/owner | Aging por cliente (buckets) |
| POST | `/api/credit/sale` | bartender+ | Venta a crédito (valida límite, atómico) |
| POST | `/api/credit/clients/:id/payment` | bartender+ | Abono total/parcial |
| POST | `/api/credit/clients/:id/limit` | **owner** | Fijar límite de crédito |
| POST | `/api/credit/clients/:id/adjust` | **owner** | Ajuste (motivo obligatorio) |
| POST | `/api/credit/clients/:id/credit-note` | **owner** | Nota de crédito (referencia a cargo) |
| POST | `/api/credit/entries/:id/void` | **owner** | Anular asiento ( Step-up 2FA opcional) |
| POST | `/api/credit/sale/override` | **owner** | Venta por encima de límite (motivo) |

Todas devuelven el `balance_after` y disparan evento realtime `credit_updated`.

---

## 8. DDL completo (para `db/schema.sql`)

```sql
ALTER TABLE clients ADD COLUMN IF NOT EXISTS credit_limit_usd   DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS credit_balance_usd DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS credit_hold_reason VARCHAR(120);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id SERIAL PRIMARY KEY,
  establishment_id INT NOT NULL REFERENCES establishments(id) ON DELETE CASCADE,
  client_id INT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  entry_type VARCHAR(20) NOT NULL,
  amount_usd DECIMAL(12,2) NOT NULL,
  balance_after_usd DECIMAL(12,2) NOT NULL,
  amount_ves DECIMAL(14,2),
  exchange_rate DECIMAL(10,2),
  payment_method VARCHAR(30),
  reference_type VARCHAR(30),
  reference_id INT,
  related_ledger_id INT REFERENCES credit_ledger(id),
  note TEXT,
  staff_id INT REFERENCES staff(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_client ON credit_ledger(client_id, created_at);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_est    ON credit_ledger(establishment_id, created_at);

CREATE OR REPLACE FUNCTION prevent_credit_ledger_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'credit_ledger es inmutable'; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_credit_ledger_immutable ON credit_ledger;
CREATE TRIGGER trg_credit_ledger_immutable BEFORE UPDATE OR DELETE ON credit_ledger
  FOR EACH ROW EXECUTE FUNCTION prevent_credit_ledger_mutation();
```

---

## 9. Plan de implementación por fases

1. **Fase A — Esquema + servicio de crédito** (`src/lib/credit.js`): `creditSale`, `creditPayment`, `setLimit`, `adjust`, `creditNote`, `voidEntry`, `getStatement`, `getAging` (FIFO). Transacciones con `FOR UPDATE`, audit, realtime.
2. **Fase B — Endpoints** (`src/routes/credit.js`) + registro en `index.js` + tests Jest/supertest (límite, parcial, total, overpayment, ajuste owner-only, void, aging, aislamiento tenant).
3. **Fase C — Integración en venta** (`frontend/js/app.js`): método "Fiado", badge de cliente, modal de exceso/override.
4. **Fase D — Panel "Cuentas por Cobrar"** (barra + `admin.html`): tabla con aging, abonos, estado de cuenta PDF.
5. **Fase E — Cierre de caja**: incluir `CREDIT_PAYMENT` en reportes/export; conciliación efectivo vs. cobros.
6. **Fase F — Hardening**: step-up 2FA para void/ajuste, límites por staff, alertas de morosidad, invariante `credit_balance_usd == SUM(ledger)`.

**Criterio de aceptación:** venta fiado dentro de límite actualiza deuda y ledger; exceso bloquea (o override owner auditado); abono parcial/total descuenta correctamente; error se corrige con asiento compensatorio; aging y estado de cuenta correctos; todo auditado y aislado por comercio.

---

## 10. Riesgos y decisiones abiertas

| Tema | Decisión propuesta | Alternativa |
|---|---|---|
| Denominación | USD (2 dec.) para crédito; unidades para prepago | Unificar todo a USD (rompe prepago actual) |
| Aging | FIFO al vuelo (MVP) | Tabla `credit_allocations` (escala) |
| Overpayment | Rechazar | Convertir a saldo a favor |
| Step-up 2FA | Solo void/ajuste/override | Ninguno |
| Notas de crédito | Asiento compensatorio | Borrar ( ❌ no, rompe auditoría) |
| Reporte de caja | `CREDIT_PAYMENT` entra como cobro | Mantener separado (reporte aparte) |

**Riesgo principal:** doble registro de dinero (venta + cobro) puede inflar reportes si no se distingue `transaction_type`. Mitigación: `payment_method='credit'` y vistas que separan "ventas" de "cobros".