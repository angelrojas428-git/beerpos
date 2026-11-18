import { Router } from 'express';
import { query } from '../db/pool.js';
import { getLatestRate } from '../lib.js';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireStaffSession, requireStaffSessionForEst } from '../middleware/auth.js';
import { getStaffSession } from '../lib/session.js';

const router = Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsDir = path.resolve(__dirname, '../../uploads');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-z0-9]/gi, '_').toLowerCase();
    cb(null, `est-${req.params.id}-${base}-${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    // NOTE: SVG intentionally excluded — uploaded SVGs served from /uploads can execute
    // script when navigated directly (stored XSS). Raster formats only.
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo de archivo no permitido. Solo imágenes.'));
    }
  }
});

// Get establishment info.
// Public (unauthenticated) callers get only non-sensitive branding fields.
// Authenticated staff of this establishment get the full record (used by the settings UI).
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await query('SELECT * FROM establishments WHERE id = $1', [id]);
    if (!rows[0]) return res.status(404).json({ error: 'Establishment not found' });
    const est = rows[0];
    const rate = await getLatestRate(id);

    // Default: minimal public payload (no owner_name / phone / active flags).
    let payload = {
      id: est.id,
      name: est.name,
      beer_price_usd: est.beer_price_usd,
      logo_url: est.logo_url,
      theme_color: est.theme_color,
      secondary_color: est.secondary_color,
      exchange_rate: rate,
    };

    const token = req.headers['x-session-token'];
    if (token) {
      const session = await getStaffSession(token);
      if (session && Number(session.establishment_id) === Number(id)) {
        payload = { ...est, exchange_rate: rate };
      }
    }

    res.json(payload);
  } catch (e) { next(e); }
});

// Update establishment details (price, logo, theme)
router.patch('/:id', requireStaffSession, requireStaffSessionForEst, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, owner_name, phone, beer_price_usd, logo_url, theme_color, secondary_color } = req.body;
    const { rows } = await query(
      `UPDATE establishments SET
         name = COALESCE($1, name),
         owner_name = COALESCE($2, owner_name),
         phone = COALESCE($3, phone),
         beer_price_usd = COALESCE($4, beer_price_usd),
         logo_url = COALESCE($5, logo_url),
         theme_color = COALESCE($6, theme_color),
         secondary_color = COALESCE($7, secondary_color)
       WHERE id = $8 RETURNING *`,
      [name, owner_name, phone, beer_price_usd, logo_url, theme_color, secondary_color, id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Establishment not found' });
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// Update beer price
router.patch('/:id/price', requireStaffSession, requireStaffSessionForEst, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { beer_price_usd } = req.body;
    const { rows } = await query(
      'UPDATE establishments SET beer_price_usd = $1 WHERE id = $2 RETURNING *',
      [beer_price_usd, id]
    );
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// Get latest exchange rate
router.get('/:id/rate', async (req, res, next) => {
  try {
    const rate = await getLatestRate(req.params.id);
    res.json(rate || { usd_to_ves: null });
  } catch (e) { next(e); }
});

// Set new exchange rate
router.post('/:id/rate', requireStaffSession, requireStaffSessionForEst, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { usd_to_ves } = req.body;
    if (!usd_to_ves || Number(usd_to_ves) <= 0) return res.status(400).json({ error: 'usd_to_ves required and must be positive' });
    const { rows } = await query(
      'INSERT INTO exchange_rates (establishment_id, usd_to_ves) VALUES ($1, $2) RETURNING *',
      [id, usd_to_ves]
    );
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// Fetch exchange rate from BCV automatically.
// The external API result is cached in-memory for 30 minutes to avoid hammering the
// upstream API and to keep bartender loads fast. The value is persisted on a cache miss.
const BCV_TTL_MS = 30 * 60 * 1000;
let bcvCache = { value: null, fetchedAt: 0 };

router.post('/:id/rate/fetch', requireStaffSession, requireStaffSessionForEst, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (bcvCache.value && Date.now() - bcvCache.fetchedAt < BCV_TTL_MS) {
      return res.json({ usd_to_ves: bcvCache.value, source: 'BCV', cached: true });
    }

    const resp = await fetch('https://bcv.today/api/v1/rate.json');
    if (!resp.ok) throw new Error(`BCV API error: ${resp.status}`);
    const data = await resp.json();
    const usdToVes = Number(data.USD);
    if (!usdToVes || usdToVes <= 0) throw new Error('BCV response missing USD rate');

    bcvCache = { value: usdToVes, fetchedAt: Date.now() };

    const { rows } = await query(
      'INSERT INTO exchange_rates (establishment_id, usd_to_ves) VALUES ($1, $2) RETURNING *',
      [id, usdToVes]
    );
    res.json({ ...rows[0], source: 'BCV', cached: false });
  } catch (e) { next(e); }
});

// Upload establishment logo
router.post('/:id/logo', requireStaffSession, requireStaffSessionForEst, upload.single('logo'), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ error: 'logo file required' });
    const logoUrl = `/uploads/${req.file.filename}`;
    const { rows } = await query(
      'UPDATE establishments SET logo_url = $1 WHERE id = $2 RETURNING *',
      [logoUrl, id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Establishment not found' });
    res.json({ logo_url: logoUrl, establishment: rows[0] });
  } catch (e) { next(e); }
});

export default router;