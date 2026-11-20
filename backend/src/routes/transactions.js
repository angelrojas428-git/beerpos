import { Router } from 'express';
import { query } from '../db/pool.js';
import XLSX from 'xlsx';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import { requireStaffSession, requireStaffSessionForEst } from '../middleware/auth.js';

const router = Router();

/**
 * Validate a strict calendar date in YYYY-MM-DD format.
 * Rejects impossible dates (e.g. 2026-02-31, 2026-02-29 on non-leap years) and
 * non-ISO formats. Exported for tests.
 */
export function isCalendarDate(value) {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

// List transactions for establishment (with optional filters)
router.get('/', requireStaffSession, async (req, res, next) => {
  try {
    const { establishment_id, client_id, type, limit = 100 } = req.query;
    if (!establishment_id) return res.status(400).json({ error: 'establishment_id required' });
    const params = [establishment_id];
    let sql = `SELECT t.*, c.full_name as client_name, c.document_id, c.phone
               FROM transactions t LEFT JOIN clients c ON c.id = t.client_id
               WHERE t.establishment_id = $1`;
    if (client_id) { params.push(client_id); sql += ` AND t.client_id = $${params.length}`; }
    if (type) { params.push(type); sql += ` AND t.transaction_type = $${params.length}`; }
    params.push(parseInt(limit, 10));
    sql += ` ORDER BY t.created_at DESC LIMIT $${params.length}`;
    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (e) { next(e); }
});

// Summary / dashboard stats
router.get('/summary/:establishmentId', requireStaffSession, async (req, res, next) => {
  try {
    const { establishmentId } = req.params;
    const today = `SELECT
      COALESCE(SUM(CASE WHEN transaction_type IN ('COMBO_PURCHASE','CREDIT_SALE') THEN quantity ELSE 0 END),0) as beers_sold,
      COALESCE(SUM(CASE WHEN transaction_type='REDEMPTION' THEN quantity ELSE 0 END),0) as beers_redeemed,
      COALESCE(SUM(CASE WHEN transaction_type='FAST_SALE' THEN quantity ELSE 0 END),0) as fast_sold,
      COALESCE(SUM(CASE WHEN transaction_type <> 'CREDIT_PAYMENT' THEN amount_usd ELSE 0 END),0) as total_usd,
      COALESCE(SUM(CASE WHEN transaction_type <> 'CREDIT_PAYMENT' THEN amount_ves ELSE 0 END),0) as total_ves,
      COUNT(*) as tx_count
      FROM transactions
      WHERE establishment_id = $1 AND created_at::date = CURRENT_DATE`;
    const { rows } = await query(today, [establishmentId]);
    const pending = await query(
      `SELECT COUNT(*)::int as pending_fast FROM fast_redemptions WHERE establishment_id = $1 AND status = 'PENDING'`,
      [establishmentId]
    );
    res.json({ today: rows[0], pending_fast: pending.rows[0].pending_fast });
  } catch (e) { next(e); }
});

// Report for a date range with advanced filters
router.get('/report/:establishmentId', requireStaffSession, async (req, res, next) => {
  try {
    const { establishmentId } = req.params;
    const { date, date_from, date_to, client_id, staff_id, type } = req.query;
    const params = [establishmentId];

    let dateCond = `created_at::date = $2`;
    let dateCondT = `t.created_at::date = $2`;
    let paramIndex = 2;

    if (date_from && date_to) {
      dateCond = `created_at::date BETWEEN $2 AND $3`;
      dateCondT = `t.created_at::date BETWEEN $2 AND $3`;
      params.push(date_from, date_to);
      paramIndex = 4;
    } else if (date) {
      params.push(date);
      paramIndex = 3;
    } else {
      return res.status(400).json({ error: 'date or date_from/date_to required' });
    }

    // Reject impossible or malformed calendar dates (e.g. 2026-02-31) before querying.
    if (date_from && date_to) {
      if (!isCalendarDate(date_from) || !isCalendarDate(date_to)) {
        return res.status(400).json({ error: 'date_from and date_to must be valid calendar dates (YYYY-MM-DD)' });
      }
    } else if (date && !isCalendarDate(date)) {
      return res.status(400).json({ error: 'date must be a valid calendar date (YYYY-MM-DD)' });
    }

    // Additional filters
    let extraCond = '';
    if (client_id) { params.push(client_id); extraCond += ` AND t.client_id = $${paramIndex++}`; }
    if (staff_id) { params.push(staff_id); extraCond += ` AND t.staff_id = $${paramIndex++}`; }
    if (type) { params.push(type); extraCond += ` AND t.transaction_type = $${paramIndex++}`; }

    const report = `
      SELECT
        COALESCE(SUM(CASE WHEN transaction_type IN ('COMBO_PURCHASE','CREDIT_SALE') THEN quantity ELSE 0 END),0) as beers_sold,
        COALESCE(SUM(CASE WHEN transaction_type='REDEMPTION' THEN quantity ELSE 0 END),0) as beers_dispatched,
        COALESCE(SUM(CASE WHEN transaction_type='FAST_SALE' THEN quantity ELSE 0 END),0) as fast_sold,
        COALESCE(SUM(CASE WHEN transaction_type <> 'CREDIT_PAYMENT' THEN amount_usd ELSE 0 END),0) as revenue_usd,
        COALESCE(SUM(CASE WHEN transaction_type <> 'CREDIT_PAYMENT' THEN amount_ves ELSE 0 END),0) as revenue_ves,
        COUNT(*) FILTER (WHERE transaction_type IN ('COMBO_PURCHASE','CREDIT_SALE')) as combo_count,
        COUNT(*) FILTER (WHERE transaction_type='REDEMPTION') as redemption_count,
        COUNT(*) FILTER (WHERE transaction_type='FAST_SALE') as fast_sale_count
      FROM transactions t
      WHERE establishment_id = $1 AND ${dateCond}${extraCond}`;
    const dispatches = `
      SELECT s.name as bartender_name,
             COALESCE(SUM(CASE WHEN t.transaction_type='REDEMPTION' THEN t.quantity ELSE 0 END),0) as beers_dispatched,
             COUNT(*) FILTER (WHERE t.transaction_type='REDEMPTION') as redemption_count
      FROM transactions t
      LEFT JOIN staff s ON s.id = t.staff_id
      WHERE t.establishment_id = $1 AND ${dateCondT}${extraCond.replace(/t\./g, '')}
      GROUP BY s.id, s.name
      ORDER BY beers_dispatched DESC`;
    const daily = `
      SELECT date_trunc('hour', created_at) as hour_bucket,
             COALESCE(SUM(CASE WHEN transaction_type IN ('COMBO_PURCHASE','CREDIT_SALE') THEN quantity ELSE 0 END),0) as beers_sold,
             COALESCE(SUM(CASE WHEN transaction_type='REDEMPTION' THEN quantity ELSE 0 END),0) as beers_dispatched,
             COALESCE(SUM(CASE WHEN transaction_type <> 'CREDIT_PAYMENT' THEN amount_usd ELSE 0 END),0) as revenue_usd,
             COALESCE(SUM(CASE WHEN transaction_type <> 'CREDIT_PAYMENT' THEN amount_ves ELSE 0 END),0) as revenue_ves
      FROM transactions t
      WHERE establishment_id = $1 AND ${dateCond}${extraCond}
      GROUP BY date_trunc('hour', created_at)
      ORDER BY hour_bucket`;

    const [r, d, day] = await Promise.all([
      query(report, params),
      query(dispatches, params),
      query(daily, params)
    ]);

    res.json({
      report_date: date,
      date_from,
      date_to,
      client_id,
      staff_id,
      type,
      beers_sold: Number(r.rows[0].beers_sold),
      beers_dispatched: Number(r.rows[0].beers_dispatched),
      revenue_usd: Number(r.rows[0].revenue_usd).toFixed(2),
      revenue_ves: Number(r.rows[0].revenue_ves).toFixed(2),
      combo_count: Number(r.rows[0].combo_count),
      redemption_count: Number(r.rows[0].redemption_count),
      fast_sale_count: Number(r.rows[0].fast_sale_count),
      dispatches_by_bartender: d.rows,
      daily_breakdown: day.rows
    });
  } catch (e) { next(e); }
});

// Ventas por hora del día (0-23) para gráfico de control.
router.get('/hourly/:establishmentId', requireStaffSession, async (req, res, next) => {
  try {
    const { establishmentId } = req.params;
    const { date, date_from, date_to } = req.query;

    let dateCond = `created_at::date = $2`;
    const params = [establishmentId];
    if (date_from && date_to) {
      dateCond = `created_at::date BETWEEN $2 AND $3`;
      params.push(date_from, date_to);
    } else if (date) {
      params.push(date);
    } else {
      return res.status(400).json({ error: 'date or date_from/date_to required' });
    }

    const sql = `
      SELECT EXTRACT(HOUR FROM created_at)::int as hour,
             COALESCE(SUM(CASE WHEN transaction_type <> 'CREDIT_PAYMENT' THEN quantity ELSE 0 END),0) as beers_sold,
             COALESCE(SUM(CASE WHEN transaction_type <> 'CREDIT_PAYMENT' THEN amount_usd ELSE 0 END),0) as revenue_usd,
             COALESCE(SUM(CASE WHEN transaction_type <> 'CREDIT_PAYMENT' THEN amount_ves ELSE 0 END),0) as revenue_ves,
             COUNT(*) FILTER (WHERE transaction_type <> 'CREDIT_PAYMENT') as sales_count
      FROM transactions
      WHERE establishment_id = $1 AND ${dateCond}
      GROUP BY EXTRACT(HOUR FROM created_at)
      ORDER BY hour`;
    const { rows } = await query(sql, params);
    const buckets = Array.from({ length: 24 }, (_, h) => {
      const row = rows.find(r => Number(r.hour) === h);
      return {
        hour: h,
        label: String(h).padStart(2, '0') + ':00',
        beers_sold: row ? Number(row.beers_sold) : 0,
        revenue_usd: row ? Number(row.revenue_usd) : 0,
        revenue_ves: row ? Number(row.revenue_ves) : 0,
        sales_count: row ? Number(row.sales_count) : 0
      };
    });
    res.json({ buckets });
  } catch (e) { next(e); }
});

// Client activity report with filters
router.get('/clients/:establishmentId', requireStaffSession, async (req, res, next) => {
  try {
    const { establishmentId } = req.params;
    const { date_from, date_to, client_id, limit = 100 } = req.query;
    const params = [establishmentId];
    let paramIndex = 2;

    let dateFilter = ``;
    if (date_from && date_to) {
      dateFilter = ` AND t.created_at::date BETWEEN $2 AND $3`;
      params.push(date_from, date_to);
      paramIndex = 4;
    }

    let extraCond = '';
    if (client_id) { params.push(client_id); extraCond += ` AND c.id = $${paramIndex++}`; }

    const clients = `
      SELECT c.id, c.full_name, c.document_id, c.phone,
             COALESCE(SUM(CASE WHEN t.transaction_type IN ('COMBO_PURCHASE','CREDIT_SALE') THEN t.quantity ELSE 0 END),0) as beers_bought,
             COALESCE(SUM(CASE WHEN transaction_type='REDEMPTION' THEN t.quantity ELSE 0 END),0) as beers_dispatched,
             COALESCE(SUM(CASE WHEN t.transaction_type IN ('COMBO_PURCHASE','CREDIT_SALE') THEN t.amount_usd ELSE 0 END),0) as spent_usd,
             COALESCE(SUM(CASE WHEN t.transaction_type IN ('COMBO_PURCHASE','CREDIT_SALE') THEN t.amount_ves ELSE 0 END),0) as spent_ves,
             COALESCE(c.current_balance, 0) as current_balance,
             MAX(t.created_at) as last_activity
      FROM clients c
      LEFT JOIN transactions t ON t.client_id = c.id AND t.establishment_id = c.establishment_id${dateFilter}
      WHERE c.establishment_id = $1${extraCond}
      GROUP BY c.id, c.full_name, c.document_id, c.phone, c.current_balance
      ORDER BY last_activity DESC NULLS LAST, c.full_name
      LIMIT $${params.length + 1}`;
    params.push(parseInt(limit, 10));

    const { rows } = await query(clients, params);
    res.json({ clients: rows.map(r => ({
      id: r.id,
      full_name: r.full_name,
      document_id: r.document_id,
      phone: r.phone,
      beers_bought: Number(r.beers_bought),
      beers_dispatched: Number(r.beers_dispatched),
      spent_usd: Number(r.spent_usd).toFixed(2),
      spent_ves: Number(r.spent_ves).toFixed(2),
      current_balance: Number(r.current_balance),
      last_activity: r.last_activity
    })) });
  } catch (e) { next(e); }
});

// Helper: build date condition for exports
function buildDateCondition(params, { date, date_from, date_to }) {
  let cond = '';
  let index = 2;
  if (date_from && date_to) {
    cond = ` AND t.created_at::date BETWEEN $${index} AND $${index + 1}`;
    params.push(date_from, date_to);
    index += 2;
  } else if (date) {
    cond = ` AND t.created_at::date = $${index}`;
    params.push(date);
    index += 1;
  }
  return { cond, index };
}

// Export transactions to CSV
router.get('/export/csv/:establishmentId', requireStaffSession, async (req, res, next) => {
  try {
    const { establishmentId } = req.params;
    const { date, date_from, date_to, client_id, staff_id, type } = req.query;
    const params = [establishmentId];
    const { cond, index: startIndex } = buildDateCondition(params, { date, date_from, date_to });
    let index = startIndex;

    let extraCond = '';
    if (client_id) { params.push(client_id); extraCond += ` AND t.client_id = $${index++}`; }
    if (staff_id) { params.push(staff_id); extraCond += ` AND t.staff_id = $${index++}`; }
    if (type) { params.push(type); extraCond += ` AND t.transaction_type = $${index++}`; }

    const { rows } = await query(
      `SELECT t.created_at, c.full_name as client_name, c.document_id,
              t.transaction_type, t.quantity, t.amount_usd, t.amount_ves,
              t.payment_method, s.name as staff_name
       FROM transactions t
       LEFT JOIN clients c ON c.id = t.client_id
       LEFT JOIN staff s ON s.id = t.staff_id
       WHERE t.establishment_id = $1${cond}${extraCond}
       ORDER BY t.created_at DESC`,
      params
    );

    const headers = 'Fecha,Cliente,Cédula,Tipo,Cantidad,USD,VES,Método,Bartender\n';
    const csvRows = rows.map(r => [
      r.created_at,
      r.client_name || 'N/A',
      r.document_id || 'N/A',
      r.transaction_type,
      r.quantity,
      r.amount_usd,
      r.amount_ves,
      r.payment_method || 'N/A',
      r.staff_name || 'N/A'
    ].map(v => `"${v}"`).join(','));

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="reporte_${establishmentId}_${date_from || date || 'all'}_${date_to || date || 'all'}.csv"`);
    res.send(headers + csvRows.join('\n'));
  } catch (e) { next(e); }
});

// Export transactions to Excel (.xlsx)
router.get('/export/excel/:establishmentId', requireStaffSession, async (req, res, next) => {
  try {
    const { establishmentId } = req.params;
    const { date, date_from, date_to, client_id, staff_id, type } = req.query;
    const params = [establishmentId];
    const { cond, index: startIndex } = buildDateCondition(params, { date, date_from, date_to });
    let index = startIndex;

    let extraCond = '';
    if (client_id) { params.push(client_id); extraCond += ` AND t.client_id = $${index++}`; }
    if (staff_id) { params.push(staff_id); extraCond += ` AND t.staff_id = $${index++}`; }
    if (type) { params.push(type); extraCond += ` AND t.transaction_type = $${index++}`; }

    const { rows } = await query(
      `SELECT t.created_at as Fecha, c.full_name as Cliente, c.document_id as Cédula,
              t.transaction_type as Tipo, t.quantity as Cantidad, t.amount_usd as USD,
              t.amount_ves as VES, t.payment_method as Método, s.name as Bartender
       FROM transactions t
       LEFT JOIN clients c ON c.id = t.client_id
       LEFT JOIN staff s ON s.id = t.staff_id
       WHERE t.establishment_id = $1${cond}${extraCond}
       ORDER BY t.created_at DESC`,
      params
    );

    const worksheet = XLSX.utils.json_to_sheet(rows.map(r => ({
      Fecha: r.Fecha,
      Cliente: r.Cliente || 'N/A',
      'Cédula': r.Cédula || 'N/A',
      Tipo: r.Tipo,
      Cantidad: r.Cantidad,
      USD: Number(r.USD || 0),
      VES: Number(r.VES || 0),
      Método: r.Método || 'N/A',
      Bartender: r.Bartender || 'N/A'
    })));

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Reporte');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="reporte_${establishmentId}_${date_from || date || 'all'}_${date_to || date || 'all'}.xlsx"`);
    res.send(buffer);
  } catch (e) { next(e); }
});

// Export transactions to PDF
router.get('/export/pdf/:establishmentId', requireStaffSession, async (req, res, next) => {
  try {
    const { establishmentId } = req.params;
    const { date, date_from, date_to, client_id, staff_id, type } = req.query;
    const params = [establishmentId];
    const { cond, index: startIndex } = buildDateCondition(params, { date, date_from, date_to });
    let index = startIndex;

    let extraCond = '';
    if (client_id) { params.push(client_id); extraCond += ` AND t.client_id = $${index++}`; }
    if (staff_id) { params.push(staff_id); extraCond += ` AND t.staff_id = $${index++}`; }
    if (type) { params.push(type); extraCond += ` AND t.transaction_type = $${index++}`; }

    const { rows } = await query(
      `SELECT t.created_at, c.full_name as client_name, c.document_id,
              t.transaction_type, t.quantity, t.amount_usd, t.amount_ves,
              t.payment_method, s.name as staff_name
       FROM transactions t
       LEFT JOIN clients c ON c.id = t.client_id
       LEFT JOIN staff s ON s.id = t.staff_id
       WHERE t.establishment_id = $1${cond}${extraCond}
       ORDER BY t.created_at DESC`,
      params
    );

    const chunks = [];
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    doc.on('data', (chunk) => chunks.push(chunk));

    doc.font('Helvetica-Bold').fontSize(18).text('Reporte de Transacciones', 50, 50);
    doc.font('Helvetica').fontSize(10);
    doc.text(`Establecimiento: ${establishmentId}`, 50, 75);
    if (date_from && date_to) doc.text(`Período: ${date_from} al ${date_to}`, 50, 90);
    else if (date) doc.text(`Fecha: ${date}`, 50, 90);
    doc.moveDown();

    // Table header
    const startY = 130;
    const colX = [50, 120, 180, 230, 280, 330, 380, 430, 480];
    const headers = ['Fecha', 'Cliente', 'Cédula', 'Tipo', 'Cant.', 'USD', 'VES', 'Método', 'Bartender'];
    doc.font('Helvetica-Bold').fontSize(8);
    headers.forEach((h, i) => {
      doc.text(h, colX[i], startY);
    });
    doc.moveTo(50, startY + 12).lineTo(560, startY + 12).stroke();

    // Table rows
    doc.font('Helvetica').fontSize(7);
    let y = startY + 20;
    for (const r of rows) {
      const values = [
        new Date(r.created_at).toLocaleDateString(),
        (r.client_name || 'N/A').substring(0, 18),
        r.document_id || 'N/A',
        r.transaction_type,
        r.quantity,
        Number(r.amount_usd || 0).toFixed(2),
        Number(r.amount_ves || 0).toFixed(2),
        (r.payment_method || 'N/A').substring(0, 10),
        (r.staff_name || 'N/A').substring(0, 14)
      ];
      values.forEach((v, i) => {
        doc.text(String(v), colX[i], y);
      });
      y += 12;
      if (y > 750) {
        doc.addPage();
        y = 50;
        doc.font('Helvetica-Bold').fontSize(8);
        headers.forEach((h, i) => { doc.text(h, colX[i], y); });
        doc.moveTo(50, y + 12).lineTo(560, y + 12).stroke();
        y += 20;
        doc.font('Helvetica').fontSize(7);
      }
    }

    doc.end();

    await new Promise((resolve, reject) => {
      doc.on('end', resolve);
      doc.on('error', reject);
    });

    const pdfBuffer = Buffer.concat(chunks);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="reporte_${establishmentId}_${date_from || date || 'all'}_${date_to || date || 'all'}.pdf"`);
    res.send(pdfBuffer);
  } catch (e) { next(e); }
});

export default router;
