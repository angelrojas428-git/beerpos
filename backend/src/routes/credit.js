// Cuentas por Cobrar / Fiado — API.
//
// All routes require a staff session scoped to the establishment. Owner-only
// actions (limit, adjust, credit note, void, hold) are enforced by the route.
import { Router } from 'express';
import PDFDocument from 'pdfkit';
import { requireStaffSession, requireOwnerRole } from '../middleware/auth.js';
import { getIO } from '../lib/socket.js';
import { broadcastSse } from './events.js';
import {
  creditSale,
  creditPayment,
  setCreditLimit,
  setCreditHold,
  creditAdjust,
  creditNote,
  voidEntry,
  getStatement,
  getAging,
  CreditError,
} from '../lib/credit.js';
import { query } from '../db/pool.js';

const router = Router();

function notify(establishmentId, payload) {
  const io = getIO();
  if (io) io.to(`est:${establishmentId}`).emit('credit_updated', payload);
  broadcastSse('credit_updated', payload, establishmentId);
}

// Clients with credit (debt / limit / available).
router.get('/clients', requireStaffSession, async (req, res, next) => {
  try {
    const establishmentId = req.establishmentId;
    const { rows } = await query(
      `SELECT id, full_name, document_id, phone,
              credit_limit_usd, credit_balance_usd, credit_hold_reason,
              (credit_limit_usd - credit_balance_usd) AS available_usd
         FROM clients
        WHERE establishment_id = $1
        ORDER BY credit_balance_usd DESC, full_name`,
      [establishmentId]
    );
    res.json({ ok: true, clients: rows });
  } catch (e) { next(e); }
});

// Aging report (per client).
router.get('/aging', requireStaffSession, async (req, res, next) => {
  try {
    const aging = await getAging(req.establishmentId);
    res.json({ ok: true, aging });
  } catch (e) { next(e); }
});

// Statement of account for a client (JSON, or PDF via ?format=pdf).
router.get('/clients/:id/statement', requireStaffSession, async (req, res, next) => {
  try {
    const data = await getStatement(req.establishmentId, req.params.id);
    if (!data.client) return res.status(404).json({ error: 'Cliente no encontrado' });

    if (req.query.format !== 'pdf') {
      return res.json({ ok: true, ...data });
    }

    const { client, entries } = data;
    const { rows: [est] } = await query(`SELECT name FROM establishments WHERE id = $1`, [req.establishmentId]);
    const estName = est?.name || `Establecimiento ${req.establishmentId}`;

    const chunks = [];
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    doc.on('data', (chunk) => chunks.push(chunk));

    doc.font('Helvetica-Bold').fontSize(18).text('Estado de Cuenta', 50, 50);
    doc.font('Helvetica').fontSize(10);
    doc.text(estName, 50, 75);
    doc.font('Helvetica-Bold').fontSize(13).text(client.full_name || 'Cliente', 50, 100);
    doc.font('Helvetica').fontSize(10);
    doc.text(`Documento: ${client.document_id || 'N/A'}`, 50, 118);
    doc.text(`Límite de crédito: $${Number(client.credit_limit_usd || 0).toFixed(2)}`, 50, 133);
    doc.font('Helvetica-Bold').text(`Deuda actual: $${Number(client.credit_balance_usd || 0).toFixed(2)}`, 50, 148);
    doc.moveDown();

    const startY = 180;
    const colX = [50, 150, 240, 340, 470];
    const headers = ['Fecha', 'Tipo', 'Monto (USD)', 'Saldo (USD)', 'Nota'];
    doc.font('Helvetica-Bold').fontSize(8);
    headers.forEach((h, i) => doc.text(h, colX[i], startY));
    doc.moveTo(50, startY + 12).lineTo(560, startY + 12).stroke();

    doc.font('Helvetica').fontSize(7);
    let y = startY + 20;
    for (const e of entries) {
      const values = [
        new Date(e.created_at).toLocaleDateString('es-VE'),
        e.entry_type,
        `$${Number(e.amount_usd).toFixed(2)}`,
        `$${Number(e.balance_after_usd).toFixed(2)}`,
        (e.note || '').substring(0, 30)
      ];
      values.forEach((v, i) => doc.text(String(v), colX[i], y));
      y += 12;
      if (y > 750) {
        doc.addPage();
        y = 50;
        doc.font('Helvetica-Bold').fontSize(8);
        headers.forEach((h, i) => doc.text(h, colX[i], y));
        doc.moveTo(50, y + 12).lineTo(560, y + 12).stroke();
        y += 20;
        doc.font('Helvetica').fontSize(7);
      }
    }
    if (entries.length === 0) {
      doc.text('Sin movimientos.', 50, y);
    }

    doc.end();
    await new Promise((resolve, reject) => {
      doc.on('end', resolve);
      doc.on('error', reject);
    });

    const pdfBuffer = Buffer.concat(chunks);
    const safeName = String(client.full_name || 'cliente').replace(/[^a-z0-9]+/gi, '_').slice(0, 40);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="estado_cuenta_${safeName}.pdf"`);
    res.send(pdfBuffer);
  } catch (e) { next(e); }
});

// Sale on credit.
router.post('/sale', requireStaffSession, async (req, res, next) => {
  try {
    const result = await creditSale({
      clientId: req.body.client_id,
      establishmentId: req.establishmentId,
      staffId: req.staff?.id,
      amountUsd: req.body.amount_usd,
      quantity: req.body.quantity,
      amountVes: req.body.amount_ves,
      exchangeRate: req.body.exchange_rate,
      note: req.body.note,
      ip: req.ip,
    });
    notify(req.establishmentId, { client_id: result.client_id, balance_after_usd: result.balance_after_usd });
    res.status(201).json(result);
  } catch (e) {
    if (e instanceof CreditError) return res.status(e.status).json({ error: e.message, code: e.code, details: e.details });
    next(e);
  }
});

// Override a limit-exceeded sale (owner only).
router.post('/sale/override', requireStaffSession, requireOwnerRole, async (req, res, next) => {
  try {
    if (!req.body.reason) return res.status(400).json({ error: 'reason required' });
    const result = await creditSale({
      clientId: req.body.client_id,
      establishmentId: req.establishmentId,
      staffId: req.staff?.id,
      amountUsd: req.body.amount_usd,
      quantity: req.body.quantity,
      amountVes: req.body.amount_ves,
      exchangeRate: req.body.exchange_rate,
      note: req.body.reason,
      override: true,
      overrideReason: req.body.reason,
      ip: req.ip,
    });
    notify(req.establishmentId, { client_id: result.client_id, balance_after_usd: result.balance_after_usd });
    res.status(201).json(result);
  } catch (e) {
    if (e instanceof CreditError) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

// Payment / abono.
router.post('/clients/:id/payment', requireStaffSession, async (req, res, next) => {
  try {
    const result = await creditPayment({
      clientId: req.params.id,
      establishmentId: req.establishmentId,
      staffId: req.staff?.id,
      amountUsd: req.body.amount_usd,
      paymentMethod: req.body.payment_method,
      reference: req.body.reference,
      note: req.body.note,
      ip: req.ip,
    });
    notify(req.establishmentId, { client_id: result.client_id, balance_after_usd: result.balance_after_usd });
    res.json(result);
  } catch (e) {
    if (e instanceof CreditError) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

// Set credit limit (owner only).
router.post('/clients/:id/limit', requireStaffSession, requireOwnerRole, async (req, res, next) => {
  try {
    const result = await setCreditLimit({
      clientId: req.params.id,
      establishmentId: req.establishmentId,
      creditLimitUsd: req.body.credit_limit_usd,
      staffId: req.staff?.id,
      ip: req.ip,
    });
    notify(req.establishmentId, { client_id: req.params.id, credit_limit_usd: result.credit_limit_usd, credit_balance_usd: result.credit_balance_usd });
    res.json(result);
  } catch (e) {
    if (e instanceof CreditError) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

// Set / clear credit hold (owner only).
router.post('/clients/:id/hold', requireStaffSession, requireOwnerRole, async (req, res, next) => {
  try {
    const result = await setCreditHold({
      clientId: req.params.id,
      establishmentId: req.establishmentId,
      reason: req.body.reason,
      staffId: req.staff?.id,
      ip: req.ip,
    });
    res.json(result);
  } catch (e) {
    if (e instanceof CreditError) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

// Owner adjustment (+/-), reason required.
router.post('/clients/:id/adjust', requireStaffSession, requireOwnerRole, async (req, res, next) => {
  try {
    const result = await creditAdjust({
      clientId: req.params.id,
      establishmentId: req.establishmentId,
      amountUsd: req.body.amount_usd,
      note: req.body.note,
      staffId: req.staff?.id,
      ip: req.ip,
    });
    notify(req.establishmentId, { client_id: req.params.id, balance_after_usd: result.balance_after_usd });
    res.json(result);
  } catch (e) {
    if (e instanceof CreditError) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

// Owner credit note (reduces debt, references a charge), reason required.
router.post('/clients/:id/credit-note', requireStaffSession, requireOwnerRole, async (req, res, next) => {
  try {
    const result = await creditNote({
      clientId: req.params.id,
      establishmentId: req.establishmentId,
      amountUsd: req.body.amount_usd,
      note: req.body.note,
      relatedLedgerId: req.body.related_ledger_id,
      staffId: req.staff?.id,
      ip: req.ip,
    });
    notify(req.establishmentId, { client_id: req.params.id, balance_after_usd: result.balance_after_usd });
    res.json(result);
  } catch (e) {
    if (e instanceof CreditError) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

// Owner void of a specific ledger entry.
router.post('/entries/:id/void', requireStaffSession, requireOwnerRole, async (req, res, next) => {
  try {
    const result = await voidEntry({
      entryId: req.params.id,
      establishmentId: req.establishmentId,
      note: req.body.note,
      staffId: req.staff?.id,
      ip: req.ip,
    });
    res.json(result);
  } catch (e) {
    if (e instanceof CreditError) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

export default router;