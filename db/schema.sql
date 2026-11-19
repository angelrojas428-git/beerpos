-- BeerPOS multi-tenant schema (PostgreSQL)
-- As specified in project requirements

CREATE TABLE IF NOT EXISTS establishments (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    owner_name VARCHAR(150) NOT NULL,
    phone VARCHAR(50),
    beer_price_usd DECIMAL(10, 2) DEFAULT 1.50,
    active BOOLEAN DEFAULT TRUE,
    logo_url VARCHAR(500),
    theme_color VARCHAR(20) DEFAULT '#0f172a',
    secondary_color VARCHAR(20) DEFAULT '#f59e0b',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS staff (
    id SERIAL PRIMARY KEY,
    establishment_id INT REFERENCES establishments(id) ON DELETE CASCADE,
    name VARCHAR(150) NOT NULL,
    pin VARCHAR(100) NOT NULL,
    role VARCHAR(20) DEFAULT 'bartender',
    active BOOLEAN DEFAULT TRUE,
    totp_secret VARCHAR(32),
    totp_enabled BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(establishment_id, name)
);

CREATE TABLE IF NOT EXISTS exchange_rates (
    id SERIAL PRIMARY KEY,
    establishment_id INT REFERENCES establishments(id) ON DELETE CASCADE,
    usd_to_ves DECIMAL(10, 2) NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS clients (
    id SERIAL PRIMARY KEY,
    establishment_id INT REFERENCES establishments(id) ON DELETE CASCADE,
    full_name VARCHAR(150) NOT NULL,
    document_id VARCHAR(50) NOT NULL,
    phone VARCHAR(50) NOT NULL,
    current_balance INT DEFAULT 0,
    access_token VARCHAR(100) UNIQUE NOT NULL, -- sha256 hash of the client's plaintext token (see lib/token.js)
    token_expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(establishment_id, document_id)
);

CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    establishment_id INT REFERENCES establishments(id) ON DELETE CASCADE,
    client_id INT REFERENCES clients(id) ON DELETE SET NULL,
    staff_id INT REFERENCES staff(id) ON DELETE SET NULL,
    request_id UUID,
    transaction_type VARCHAR(30) NOT NULL,
    quantity INT NOT NULL,
    amount_usd DECIMAL(10, 2) DEFAULT 0,
    amount_ves DECIMAL(12, 2) DEFAULT 0,
    payment_method VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS fast_redemptions (
    id SERIAL PRIMARY KEY,
    establishment_id INT REFERENCES establishments(id) ON DELETE CASCADE,
    request_id UUID,
    code VARCHAR(3) NOT NULL,
    quantity INT NOT NULL,
    status VARCHAR(20) DEFAULT 'PENDING',
    dispatched_at TIMESTAMP,
    dispatched_by_staff_id INT REFERENCES staff(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP
);

-- Add columns if they do not exist (for existing databases)
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS logo_url VARCHAR(500);
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS theme_color VARCHAR(20);
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS secondary_color VARCHAR(20);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS staff_id INT REFERENCES staff(id) ON DELETE SET NULL;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS request_id UUID;
ALTER TABLE fast_redemptions ADD COLUMN IF NOT EXISTS request_id UUID;
ALTER TABLE fast_redemptions ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMP;
ALTER TABLE fast_redemptions ADD COLUMN IF NOT EXISTS dispatched_by_staff_id INT REFERENCES staff(id) ON DELETE SET NULL;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMP;

ALTER TABLE clients ADD COLUMN IF NOT EXISTS verification_code VARCHAR(10);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS verification_code_expires_at TIMESTAMP;

ALTER TABLE staff ADD COLUMN IF NOT EXISTS totp_secret VARCHAR(32);
ALTER TABLE staff ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE staff ALTER COLUMN pin TYPE VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_clients_doc ON clients(document_id);
CREATE INDEX IF NOT EXISTS idx_fast_code ON fast_redemptions(establishment_id, code, status);
CREATE INDEX IF NOT EXISTS idx_transactions_request_id ON transactions(request_id);
CREATE INDEX IF NOT EXISTS idx_fast_redemptions_request_id ON fast_redemptions(request_id);

-- Performance indexes for reports, summaries and client lookups (multi-tenant).
CREATE INDEX IF NOT EXISTS idx_clients_est ON clients(establishment_id);
CREATE INDEX IF NOT EXISTS idx_transactions_est_created ON transactions(establishment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_client ON transactions(client_id);

-- NOTE: No demo/seed data is created here on purpose.
-- Production must never ship default credentials (e.g. PIN 1234).
-- Create the first platform admin explicitly with a strong PIN:
--   node backend/scripts/seedPlatformAdmin.js <name> <pin>
-- For local development only, you can seed demo data with:
--   node backend/scripts/seedDemo.js

-- Client withdrawal orders (SOLICITADO -> EN_PREPARACION -> ENTREGADO / CANCELADO / EXPIRADO)
CREATE TABLE IF NOT EXISTS client_orders (
    id SERIAL PRIMARY KEY,
    establishment_id INT REFERENCES establishments(id) ON DELETE CASCADE,
    client_id INT REFERENCES clients(id) ON DELETE CASCADE,
    staff_id INT REFERENCES staff(id) ON DELETE SET NULL,
    quantity INT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'SOLICITADO',
    requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    prepared_at TIMESTAMP,
    delivered_at TIMESTAMP,
    expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Add columns if they do not exist (for existing databases)
ALTER TABLE client_orders ADD COLUMN IF NOT EXISTS staff_id INT REFERENCES staff(id) ON DELETE SET NULL;
ALTER TABLE client_orders ADD COLUMN IF NOT EXISTS prepared_at TIMESTAMP;
ALTER TABLE client_orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP;
ALTER TABLE client_orders ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_client_orders_status ON client_orders(establishment_id, status, requested_at);
CREATE INDEX IF NOT EXISTS idx_client_orders_client ON client_orders(client_id, status);

-- Client fingerprint templates (biometric authentication)
CREATE TABLE IF NOT EXISTS client_fingerprints (
    id SERIAL PRIMARY KEY,
    client_id INT REFERENCES clients(id) ON DELETE CASCADE,
    establishment_id INT REFERENCES establishments(id) ON DELETE CASCADE,
    template_encrypted TEXT NOT NULL, -- encrypted fingerprint template (base64)
    finger_position VARCHAR(20) DEFAULT 'right_thumb',
    registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(client_id, finger_position)
);

CREATE INDEX IF NOT EXISTS idx_client_fingerprints_client ON client_fingerprints(client_id);
CREATE INDEX IF NOT EXISTS idx_client_fingerprints_est ON client_fingerprints(establishment_id);

-- Audit log: registra acciones críticas para trazabilidad y seguridad
CREATE TABLE IF NOT EXISTS audit_log (
    id SERIAL PRIMARY KEY,
    establishment_id INT REFERENCES establishments(id) ON DELETE CASCADE,
    staff_id INT REFERENCES staff(id) ON DELETE SET NULL,
    client_id INT REFERENCES clients(id) ON DELETE SET NULL,
    action VARCHAR(50) NOT NULL,
    entity_type VARCHAR(50),
    entity_id INT,
    details JSONB DEFAULT '{}',
    ip_address INET,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_log_est ON audit_log(establishment_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_staff ON audit_log(staff_id, created_at);

-- Subscriptions / billing (SaaS monetization).
-- One subscription per establishment. `status` drives automatic suspension for non-payment.
--   active     -> current_period_end in the future, service enabled
--   past_due   -> grace period, still enabled but flagged
--   suspended  -> establishments.active = FALSE, sessions revoked (staff must log in again)
--   canceled   -> soft cancel
CREATE TABLE IF NOT EXISTS subscriptions (
    id SERIAL PRIMARY KEY,
    establishment_id INT NOT NULL REFERENCES establishments(id) ON DELETE CASCADE,
    plan VARCHAR(20) NOT NULL DEFAULT 'free',
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    current_period_end TIMESTAMP,
    payment_method VARCHAR(30),
    amount_usd DECIMAL(10, 2) DEFAULT 0,
    currency VARCHAR(10) DEFAULT 'USD',
    last_paid_at TIMESTAMP,
    grace_until TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(establishment_id)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status, current_period_end);

-- Pilot / free-trial support (Fase 4): a pilot subscription has is_pilot = TRUE and a
-- trial_ends_at. When the trial lapses with no payment, the billing cron suspends it.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMP;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS is_pilot BOOLEAN DEFAULT FALSE;

-- Pilot feedback: rating + comment captured by the platform admin during pilots.
CREATE TABLE IF NOT EXISTS feedback (
    id SERIAL PRIMARY KEY,
    establishment_id INT REFERENCES establishments(id) ON DELETE CASCADE,
    rating INT CHECK (rating BETWEEN 1 AND 5),
    category VARCHAR(30) DEFAULT 'general',
    comment TEXT,
    author VARCHAR(150),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_feedback_est ON feedback(establishment_id, created_at);

-- Cuentas por Cobrar / Fiado (credit).
-- `credit_limit_usd` = cupo máximo de fiado (0 = sin crédito).
-- `credit_balance_usd` = deuda actual cacheada; la fuente de verdad es `credit_ledger`.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS credit_limit_usd   DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS credit_balance_usd DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS credit_hold_reason VARCHAR(120);

-- Ledger de crédito inmutable: cada movimiento es un asiento firmado.
--   CHARGE (venta fiado, +), PAYMENT (abono, -), CREDIT_NOTE (-), ADJUSTMENT (±), VOID (±)
CREATE TABLE IF NOT EXISTS credit_ledger (
    id                SERIAL PRIMARY KEY,
    establishment_id  INT NOT NULL REFERENCES establishments(id) ON DELETE CASCADE,
    client_id         INT NOT NULL REFERENCES clients(id)        ON DELETE CASCADE,
    entry_type        VARCHAR(20) NOT NULL,
    amount_usd        DECIMAL(12,2) NOT NULL,
    balance_after_usd DECIMAL(12,2) NOT NULL,
    amount_ves        DECIMAL(14,2),
    exchange_rate     DECIMAL(10,2),
    payment_method    VARCHAR(30),
    reference_type    VARCHAR(30),
    reference_id      INT,
    related_ledger_id INT REFERENCES credit_ledger(id),
    note              TEXT,
    staff_id          INT REFERENCES staff(id) ON DELETE SET NULL,
    created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_credit_ledger_client ON credit_ledger(client_id, created_at);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_est    ON credit_ledger(establishment_id, created_at);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_type   ON credit_ledger(entry_type, created_at);

-- Inmutabilidad a nivel de base de datos (anti-fraude): no permitir UPDATE/DELETE.
CREATE OR REPLACE FUNCTION prevent_credit_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'credit_ledger es inmutable: use asientos compensatorios';
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_credit_ledger_immutable ON credit_ledger;
CREATE TRIGGER trg_credit_ledger_immutable
  BEFORE UPDATE OR DELETE ON credit_ledger
  FOR EACH ROW EXECUTE FUNCTION prevent_credit_ledger_mutation();

-- Inventario / stock de cerveza.
-- `beer_stock` = unidades actuales (NULL = stock no controlado).
-- `beer_stock_min` = umbral para alertar stock bajo.
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS beer_stock INT;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS beer_stock_min INT NOT NULL DEFAULT 10;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS stock_updated_at TIMESTAMP;

-- Descuenta stock automáticamente al insertar una venta.
-- Aplica a FAST_SALE (venta rápida), REDEMPTION (retiro de cliente), COMBO_PURCHASE
-- (combo) y CREDIT_SALE (venta a crédito). No afecta pagos ni ajustes.
-- Si `beer_stock` es NULL (stock no controlado) no hace nada.
CREATE OR REPLACE FUNCTION decrement_beer_stock() RETURNS trigger AS $$
BEGIN
  UPDATE establishments
     SET beer_stock = GREATEST(0, beer_stock - NEW.quantity),
         stock_updated_at = NOW()
   WHERE id = NEW.establishment_id
     AND beer_stock IS NOT NULL
     AND NEW.transaction_type IN ('FAST_SALE', 'REDEMPTION', 'COMBO_PURCHASE', 'CREDIT_SALE');
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_decrement_beer_stock ON transactions;
CREATE TRIGGER trg_decrement_beer_stock
  AFTER INSERT ON transactions
  FOR EACH ROW EXECUTE FUNCTION decrement_beer_stock();

-- Cierre de caja / turnos.
-- Un turno (OPEN -> CLOSED) por establecimiento a la vez. El efectivo esperado se
-- calcula desde `transactions` del rango [opened_at, cierre]:
--   expected_usd = opening_float_usd + SUM(amount_usd) de pagos en efectivo.
--   difference_usd = counted_usd - expected_usd.
CREATE TABLE IF NOT EXISTS cash_shifts (
    id SERIAL PRIMARY KEY,
    establishment_id INT NOT NULL REFERENCES establishments(id) ON DELETE CASCADE,
    opened_by INT REFERENCES staff(id) ON DELETE SET NULL,
    opened_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    closed_at TIMESTAMP,
    closed_by INT REFERENCES staff(id) ON DELETE SET NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'OPEN',
    opening_float_usd DECIMAL(12, 2) NOT NULL DEFAULT 0,
    cash_sales_usd DECIMAL(12, 2) NOT NULL DEFAULT 0,
    other_sales_usd DECIMAL(12, 2) NOT NULL DEFAULT 0,
    total_sales_usd DECIMAL(12, 2) NOT NULL DEFAULT 0,
    expected_usd DECIMAL(12, 2) NOT NULL DEFAULT 0,
    counted_usd DECIMAL(12, 2),
    difference_usd DECIMAL(12, 2),
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cash_shifts_est ON cash_shifts(establishment_id, status, opened_at DESC);

-- Solo un turno OPEN por establecimiento.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_shifts_open ON cash_shifts(establishment_id) WHERE status = 'OPEN';

-- NOTE: clients.access_token stores a sha256 hash (see backend/src/lib/token.js).
-- Existing plaintext tokens from legacy databases must be hashed once with:
--   node backend/scripts/migrateTokenHash.js
-- Existing client QR codes keep working after migration (lookups hash the presented token).
ALTER TABLE clients ADD COLUMN IF NOT EXISTS loyalty_points INT NOT NULL DEFAULT 0;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS loyalty_tier VARCHAR(20) NOT NULL DEFAULT 'bronce';

