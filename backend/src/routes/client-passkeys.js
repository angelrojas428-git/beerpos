import { createHash, randomBytes } from 'crypto';
import { Router } from 'express';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { pool, query } from '../db/pool.js';
import { auditLog } from '../lib/audit.js';
import { config } from '../lib/config.js';
import { hashAccessToken } from '../lib/token.js';
import { requireOwnerRole, requireStaffSession } from '../middleware/auth.js';

const router = Router();
const challengeTtlMs = 5 * 60 * 1000;
const authorizationTtlMs = 2 * 60 * 1000;

function allowedOrigins() {
  const configured = Array.isArray(config.corsOrigin) ? config.corsOrigin : [config.corsOrigin];
  return [...configured, process.env.RENDER_EXTERNAL_URL]
    .filter((origin) => typeof origin === 'string' && origin.trim() && origin.trim() !== '*')
    .map((origin) => {
      try {
        return new URL(origin.trim()).origin;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function getRelyingParty(req) {
  const rawOrigin = req.get('origin');
  if (!rawOrigin || rawOrigin === 'null') {
    const error = new Error('WebAuthn requires a valid browser origin');
    error.status = 400;
    throw error;
  }

  let url;
  try {
    url = new URL(rawOrigin);
  } catch {
    const error = new Error('Invalid WebAuthn origin');
    error.status = 400;
    throw error;
  }

  const origin = url.origin;
  if (rawOrigin !== origin) {
    const error = new Error('WebAuthn origin must not include a path or credentials');
    error.status = 400;
    throw error;
  }
  const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !config.isProd && localHost)) {
    const error = new Error('WebAuthn requires HTTPS');
    error.status = 403;
    throw error;
  }

  const configuredOrigins = allowedOrigins();
  const isAllowed = configuredOrigins.includes(origin);
  if ((config.isProd && !isAllowed) || (!config.isProd && config.corsOrigin !== '*' && !isAllowed)) {
    const error = new Error('WebAuthn origin is not allowed');
    error.status = 403;
    throw error;
  }

  return { origin, rpId: url.hostname };
}

async function saveChallenge({
  challenge,
  purpose,
  clientId,
  establishmentId,
  requestedQuantity = null,
  origin,
  rpId,
}) {
  await query('DELETE FROM webauthn_challenges WHERE expires_at <= NOW()');
  await query(
    `INSERT INTO webauthn_challenges
      (challenge, purpose, client_id, establishment_id, requested_quantity, expected_origin, rp_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + ($8 * INTERVAL '1 millisecond'))`,
    [challenge, purpose, clientId, establishmentId, requestedQuantity, origin, rpId, challengeTtlMs]
  );
}

async function consumeChallenge(challenge, purpose, clientId, establishmentId) {
  const { rows } = await query(
    `DELETE FROM webauthn_challenges
     WHERE challenge = $1 AND purpose = $2
       AND client_id IS NOT DISTINCT FROM $3
       AND establishment_id = $4 AND expires_at > NOW()
     RETURNING expected_origin, rp_id, requested_quantity`,
    [challenge, purpose, clientId, establishmentId]
  );
  return rows[0] || null;
}

async function clientFromToken(req) {
  const token = req.get('x-client-token');
  if (!token) return null;
  const { rows } = await query(
    `SELECT id, establishment_id, full_name
     FROM clients
     WHERE access_token = $1 AND (token_expires_at IS NULL OR token_expires_at > NOW())`,
    [hashAccessToken(token)]
  );
  return rows[0] || null;
}

async function consumeClientAuthorization(req, client, scope) {
  const token = req.get('x-client-passkey-auth');
  if (!token) return false;
  const { rows } = await query(
    `DELETE FROM client_passkey_authorizations
     WHERE token_hash = $1 AND client_id = $2 AND establishment_id = $3
       AND scope = $4 AND expires_at > NOW()
     RETURNING token_hash`,
    [hashAccessToken(token), client.id, client.establishment_id, scope]
  );
  return rows.length > 0;
}

function validCredentialResponse(response, kind) {
  return response && response.type === 'public-key' &&
    typeof response.id === 'string' && response.id.length > 0 &&
    typeof response.rawId === 'string' && response.rawId.length > 0 &&
    response.response && typeof response.response.clientDataJSON === 'string' &&
    typeof response.response[kind === 'registration' ? 'attestationObject' : 'authenticatorData'] === 'string';
}

function credentialForVerification(row) {
  return {
    id: row.credential_id,
    publicKey: new Uint8Array(row.public_key),
    counter: Number(row.sign_count),
    transports: row.transports || undefined,
  };
}

async function issueAuthorization(client, scope, quantity = null) {
  const authorization = randomBytes(32).toString('base64url');
  await query('DELETE FROM client_passkey_authorizations WHERE expires_at <= NOW()');
  await query(
    `INSERT INTO client_passkey_authorizations
      (token_hash, client_id, establishment_id, scope, quantity, expires_at)
     VALUES ($1, $2, $3, $4, $5, NOW() + ($6 * INTERVAL '1 millisecond'))`,
    [hashAccessToken(authorization), client.id, client.establishment_id, scope, quantity, authorizationTtlMs]
  );
  return authorization;
}

router.get('/', async (req, res, next) => {
  try {
    const client = await clientFromToken(req);
    if (!client) return res.status(401).json({ error: 'Valid client token required' });
    const { rows } = await query(
      `SELECT id, device_type, backed_up, created_at, last_used_at
       FROM client_passkeys
       WHERE client_id = $1 AND establishment_id = $2
       ORDER BY created_at`,
      [client.id, client.establishment_id]
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

router.post('/registration/options', async (req, res, next) => {
  try {
    const client = await clientFromToken(req);
    if (!client) return res.status(401).json({ error: 'Valid client token required' });
    const { origin, rpId } = getRelyingParty(req);

    const { rows: existing } = await query(
      `SELECT credential_id, transports FROM client_passkeys
       WHERE client_id = $1 AND establishment_id = $2`,
      [client.id, client.establishment_id]
    );
    if (existing.length && !(await consumeClientAuthorization(req, client, 'manage'))) {
      return res.status(401).json({ error: 'Passkey authentication required to add another passkey' });
    }

    const options = await generateRegistrationOptions({
      rpName: 'BeerPOS',
      rpID: rpId,
      userID: createHash('sha256').update(`beerpos-client:${client.establishment_id}:${client.id}`).digest(),
      userName: `beerpos-client-${client.id}`,
      userDisplayName: client.full_name,
      attestationType: 'none',
      timeout: 60000,
      excludeCredentials: existing.map((credential) => ({
        id: credential.credential_id,
        transports: credential.transports || undefined,
      })),
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
    });
    await saveChallenge({
      challenge: options.challenge,
      purpose: 'client-registration',
      clientId: client.id,
      establishmentId: client.establishment_id,
      origin,
      rpId,
    });
    res.json(options);
  } catch (error) {
    next(error);
  }
});

router.post('/registration/verify', async (req, res, next) => {
  try {
    const client = await clientFromToken(req);
    if (!client) return res.status(401).json({ error: 'Valid client token required' });
    const { challenge, response } = req.body || {};
    if (typeof challenge !== 'string' || !validCredentialResponse(response, 'registration')) {
      return res.status(400).json({ error: 'Valid registration response and challenge required' });
    }

    const context = await consumeChallenge(
      challenge,
      'client-registration',
      client.id,
      client.establishment_id
    );
    if (!context) return res.status(400).json({ error: 'Registration challenge expired or already used' });

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: context.expected_origin,
        expectedRPID: context.rp_id,
        requireUserVerification: true,
      });
    } catch {
      return res.status(400).json({ error: 'Passkey registration could not be verified' });
    }
    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'Passkey registration could not be verified' });
    }

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const { rows: clients } = await db.query(
        `SELECT id FROM clients WHERE id = $1 AND establishment_id = $2 FOR UPDATE`,
        [client.id, client.establishment_id]
      );
      if (!clients.length) {
        await db.query('ROLLBACK');
        return res.status(404).json({ error: 'Client not found' });
      }
      await db.query(
        `INSERT INTO client_passkeys
          (credential_id, client_id, establishment_id, public_key, sign_count, transports, device_type, backed_up)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
        [
          credential.id,
          client.id,
          client.establishment_id,
          Buffer.from(credential.publicKey),
          credential.counter,
          JSON.stringify(response.response.transports || []),
          credentialDeviceType,
          credentialBackedUp,
        ]
      );
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      if (error.code === '23505') {
        return res.status(409).json({ error: 'This passkey is already registered' });
      }
      throw error;
    } finally {
      db.release();
    }
    await auditLog({
      establishmentId: client.establishment_id,
      clientId: client.id,
      action: 'client_passkey_registered',
      entityType: 'client_passkey',
      ipAddress: req.ip || null,
    });
    res.status(201).json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.post('/authentication/options', async (req, res, next) => {
  try {
    const client = await clientFromToken(req);
    if (!client) return res.status(401).json({ error: 'Valid client token required' });
    const requestedPurpose = req.body?.purpose || 'withdrawal';
    if (!['withdrawal', 'manage'].includes(requestedPurpose)) {
      return res.status(400).json({ error: 'purpose must be withdrawal or manage' });
    }
    const purpose = requestedPurpose === 'manage' ? 'client-manage' : 'client-withdrawal';
    const requestedQuantity = purpose === 'client-withdrawal' ? Number(req.body?.quantity) : null;
    if (purpose === 'client-withdrawal' &&
        (!Number.isInteger(requestedQuantity) || requestedQuantity <= 0)) {
      return res.status(400).json({ error: 'A positive integer quantity is required for withdrawal authentication' });
    }
    const { origin, rpId } = getRelyingParty(req);
    const { rows } = await query(
      `SELECT credential_id, transports FROM client_passkeys
       WHERE client_id = $1 AND establishment_id = $2`,
      [client.id, client.establishment_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'No passkeys are registered for this client' });
    const options = await generateAuthenticationOptions({
      rpID: rpId,
      timeout: 60000,
      userVerification: 'required',
      allowCredentials: rows.map((credential) => ({
        id: credential.credential_id,
        transports: credential.transports || undefined,
      })),
    });
    await saveChallenge({
      challenge: options.challenge,
      purpose,
      clientId: client.id,
      establishmentId: client.establishment_id,
      requestedQuantity,
      origin,
      rpId,
    });
    res.json(options);
  } catch (error) {
    next(error);
  }
});

router.post('/authentication/verify', async (req, res, next) => {
  try {
    const client = await clientFromToken(req);
    if (!client) return res.status(401).json({ error: 'Valid client token required' });
    const { challenge, response, purpose: requestedPurpose } = req.body || {};
    if (requestedPurpose && !['withdrawal', 'manage'].includes(requestedPurpose)) {
      return res.status(400).json({ error: 'purpose must be withdrawal or manage' });
    }
    if (typeof challenge !== 'string' || !validCredentialResponse(response, 'authentication')) {
      return res.status(400).json({ error: 'Valid authentication response and challenge required' });
    }
    const purpose = requestedPurpose === 'manage' ? 'client-manage' : 'client-withdrawal';
    const context = await consumeChallenge(challenge, purpose, client.id, client.establishment_id);
    if (!context) return res.status(400).json({ error: 'Authentication challenge expired or already used' });
    if (purpose === 'client-withdrawal' &&
        (!Number.isInteger(Number(context.requested_quantity)) || Number(context.requested_quantity) <= 0)) {
      return res.status(400).json({ error: 'Withdrawal challenge is not bound to a valid quantity' });
    }

    const { rows } = await query(
      `SELECT * FROM client_passkeys
       WHERE credential_id = $1 AND client_id = $2 AND establishment_id = $3`,
      [response.id, client.id, client.establishment_id]
    );
    const credential = rows[0];
    if (!credential) return res.status(401).json({ error: 'Passkey is not registered for this client' });

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: context.expected_origin,
        expectedRPID: context.rp_id,
        credential: credentialForVerification(credential),
        requireUserVerification: true,
      });
    } catch {
      return res.status(401).json({ error: 'Passkey authentication could not be verified' });
    }
    if (!verification.verified || !verification.authenticationInfo.userVerified) {
      return res.status(401).json({ error: 'Passkey authentication could not be verified' });
    }

    await query(
      `UPDATE client_passkeys
       SET sign_count = $1, device_type = $2, backed_up = $3, last_used_at = NOW()
       WHERE id = $4`,
      [
        verification.authenticationInfo.newCounter,
        verification.authenticationInfo.credentialDeviceType,
        verification.authenticationInfo.credentialBackedUp,
        credential.id,
      ]
    );
    const authorization = await issueAuthorization(
      client,
      purpose === 'client-manage' ? 'manage' : 'withdrawal',
      purpose === 'client-manage' ? null : Number(context.requested_quantity)
    );
    await auditLog({
      establishmentId: client.establishment_id,
      clientId: client.id,
      action: 'client_passkey_authenticated',
      entityType: 'client_passkey',
      entityId: credential.id,
      details: { purpose },
      ipAddress: req.ip || null,
    });
    res.json({ authorization });
  } catch (error) {
    next(error);
  }
});

router.delete('/:passkeyId', async (req, res, next) => {
  try {
    const client = await clientFromToken(req);
    if (!client) return res.status(401).json({ error: 'Valid client token required' });
    const passkeyId = Number(req.params.passkeyId);
    if (!Number.isInteger(passkeyId) || passkeyId <= 0) {
      return res.status(400).json({ error: 'Valid passkey ID required' });
    }
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const { rows: authorizationRows } = await db.query(
        `DELETE FROM client_passkey_authorizations
         WHERE token_hash = $1 AND client_id = $2 AND establishment_id = $3
           AND scope = 'manage' AND expires_at > NOW()
         RETURNING token_hash`,
        [hashAccessToken(req.get('x-client-passkey-auth') || ''), client.id, client.establishment_id]
      );
      if (!authorizationRows.length) {
        await db.query('ROLLBACK');
        return res.status(401).json({ error: 'Passkey authentication required to remove a passkey' });
      }
      const { rows } = await db.query(
        `DELETE FROM client_passkeys WHERE id = $1 AND client_id = $2 AND establishment_id = $3
         RETURNING id`,
        [passkeyId, client.id, client.establishment_id]
      );
      if (!rows.length) {
        await db.query('ROLLBACK');
        return res.status(404).json({ error: 'Passkey not found' });
      }
      await db.query('COMMIT');
      await auditLog({
        establishmentId: client.establishment_id,
        clientId: client.id,
        action: 'client_passkey_deleted',
        entityType: 'client_passkey',
        entityId: passkeyId,
        ipAddress: req.ip || null,
      });
      res.json({ ok: true });
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  } catch (error) {
    next(error);
  }
});

router.post('/pos/authentication/options', requireStaffSession, async (req, res, next) => {
  try {
    const { origin, rpId } = getRelyingParty(req);
    const options = await generateAuthenticationOptions({
      rpID: rpId,
      timeout: 60000,
      userVerification: 'required',
    });
    await saveChallenge({
      challenge: options.challenge,
      purpose: 'pos-identification',
      clientId: null,
      establishmentId: req.establishmentId,
      origin,
      rpId,
    });
    res.json(options);
  } catch (error) {
    next(error);
  }
});

router.post('/pos/authentication/verify', requireStaffSession, async (req, res, next) => {
  try {
    const { challenge, response } = req.body || {};
    if (typeof challenge !== 'string' || !validCredentialResponse(response, 'authentication')) {
      return res.status(400).json({ error: 'Valid authentication response and challenge required' });
    }
    const { rows } = await query(
      `SELECT * FROM client_passkeys
       WHERE credential_id = $1 AND establishment_id = $2`,
      [response.id, req.establishmentId]
    );
    const credential = rows[0];
    if (!credential) return res.status(404).json({ error: 'No matching client passkey was found' });
    const context = await consumeChallenge(
      challenge,
      'pos-identification',
      null,
      req.establishmentId
    );
    if (!context) return res.status(400).json({ error: 'Authentication challenge expired or already used' });

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: context.expected_origin,
        expectedRPID: context.rp_id,
        credential: credentialForVerification(credential),
        requireUserVerification: true,
      });
    } catch {
      return res.status(401).json({ error: 'Passkey authentication could not be verified' });
    }
    if (!verification.verified || !verification.authenticationInfo.userVerified) {
      return res.status(401).json({ error: 'Passkey authentication could not be verified' });
    }

    await query(
      `UPDATE client_passkeys
       SET sign_count = $1, device_type = $2, backed_up = $3, last_used_at = NOW()
       WHERE id = $4`,
      [
        verification.authenticationInfo.newCounter,
        verification.authenticationInfo.credentialDeviceType,
        verification.authenticationInfo.credentialBackedUp,
        credential.id,
      ]
    );
    const { rows: clients } = await query(
      `SELECT id, full_name, current_balance, establishment_id
       FROM clients WHERE id = $1 AND establishment_id = $2`,
      [credential.client_id, req.establishmentId]
    );
    if (!clients[0]) return res.status(404).json({ error: 'Client not found' });

    await auditLog({
      establishmentId: req.establishmentId,
      staffId: req.staff?.id || null,
      clientId: credential.client_id,
      action: 'client_passkey_authenticated_at_pos',
      entityType: 'client_passkey',
      entityId: credential.id,
      ipAddress: req.ip || null,
    });
    res.json({ client: clients[0] });
  } catch (error) {
    next(error);
  }
});

router.delete('/pos/clients/:clientId', requireStaffSession, requireOwnerRole, async (req, res, next) => {
  try {
    const clientId = Number(req.params.clientId);
    if (!Number.isInteger(clientId) || clientId <= 0) {
      return res.status(400).json({ error: 'Valid client ID required' });
    }
    const { rows: clients } = await query(
      `SELECT id FROM clients WHERE id = $1 AND establishment_id = $2`,
      [clientId, req.establishmentId]
    );
    if (!clients.length) return res.status(404).json({ error: 'Client not found' });
    const { rows } = await query(
      `DELETE FROM client_passkeys
       WHERE client_id = $1 AND establishment_id = $2
       RETURNING id`,
      [clientId, req.establishmentId]
    );
    await auditLog({
      establishmentId: req.establishmentId,
      staffId: req.staff?.id || null,
      clientId,
      action: 'client_passkeys_reset_by_owner',
      entityType: 'client_passkey',
      details: { deleted: rows.length },
      ipAddress: req.ip || null,
    });
    res.json({ ok: true, deleted: rows.length });
  } catch (error) {
    next(error);
  }
});

export default router;
