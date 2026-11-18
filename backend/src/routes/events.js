import { Router } from 'express';
import { query } from '../db/pool.js';
import { getStaffSession } from '../lib/session.js';
import { hashAccessToken } from '../lib/token.js';

const router = Router();

// Server-Sent Events for real-time updates
// GET /api/events/:establishmentId
// Auth: staff session (x-session-token header) OR client token (query ?token=)
router.get('/:establishmentId', async (req, res, next) => {
  const { establishmentId } = req.params;
  const { token } = req.query;

  // Verify auth: staff session OR client token
  const sessionToken = req.headers['x-session-token'];
  let authorized = false;
  let clientId = null;

  if (sessionToken) {
    const session = await getStaffSession(sessionToken);
    if (session && Number(session.establishment_id) === Number(establishmentId)) {
      authorized = true;
    }
  } else if (token) {
    // Client token: verify it belongs to this establishment (tokens are hashed at rest)
    const { rows } = await query(
      `SELECT id FROM clients WHERE access_token = $1 AND establishment_id = $2
       AND (token_expires_at IS NULL OR token_expires_at > NOW())`,
      [hashAccessToken(token), establishmentId]
    );
    if (rows[0]) {
      authorized = true;
      clientId = rows[0].id;
    }
  }

  if (!authorized) {
    return res.status(401).send('Unauthorized');
  }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send('hello', { establishmentId, at: new Date().toISOString() });

  const ping = setInterval(() => {
    try { res.write(`event: ping\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`); } catch (e) {}
  }, 15000);

  req.on('close', () => { clearInterval(ping); });

  if (!global.__beerposSSE) global.__beerposSSE = [];
  const conn = { establishmentId, clientId, res, send };
  global.__beerposSSE.push(conn);

  req.on('close', () => {
    global.__beerposSSE = global.__beerposSSE.filter(c => c !== conn);
  });
});

// Broadcast to SSE listeners for clients and legacy browser connections.
// `clientId` (optional) targets a specific client's stream. Tokens are never used as channel keys.
export function broadcastSse(event, data, establishmentId, clientId) {
  if (!global.__beerposSSE) return;
  for (const c of global.__beerposSSE) {
    if (establishmentId && String(c.establishmentId) !== String(establishmentId)) continue;
    if (clientId && String(c.clientId) !== String(clientId)) continue;
    try { c.send(event, data); } catch (e) {}
  }
}

// Broadcast to all (or filtered) listeners
export function broadcast(event, data, establishmentId, clientId) {
  broadcastSse(event, data, establishmentId, clientId);
}

export default router;