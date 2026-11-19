import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const query = jest.fn();
const pool = { connect: jest.fn() };
const dbQuery = jest.fn();
const auditLog = jest.fn();
const generateRegistrationOptions = jest.fn();
const generateAuthenticationOptions = jest.fn();
const verifyRegistrationResponse = jest.fn();
const verifyAuthenticationResponse = jest.fn();

jest.unstable_mockModule('../src/db/pool.js', () => ({ pool, query }));
jest.unstable_mockModule('../src/lib/audit.js', () => ({ auditLog }));
jest.unstable_mockModule('@simplewebauthn/server', () => ({
  generateRegistrationOptions,
  generateAuthenticationOptions,
  verifyRegistrationResponse,
  verifyAuthenticationResponse,
}));
jest.unstable_mockModule('../src/middleware/auth.js', () => ({
  requireStaffSession: (req, _res, next) => {
    req.establishmentId = 1;
    req.staff = { id: 8, role: 'owner' };
    req.session = { establishment_id: 1, staff: { id: 8, role: 'owner' } };
    next();
  },
  requireOwnerRole: (_req, _res, next) => next(),
}));

const { default: router } = await import('../src/routes/client-passkeys.js');
const app = express();
app.use(express.json());
app.use('/api/client-passkeys', router);

const client = { id: 7, establishment_id: 1, full_name: 'Cliente de prueba' };

describe('client passkeys', () => {
  beforeEach(() => {
    query.mockReset();
    pool.connect.mockReset();
    dbQuery.mockReset();
    pool.connect.mockResolvedValue({ query: dbQuery, release: jest.fn() });
    auditLog.mockReset();
    generateRegistrationOptions.mockReset().mockResolvedValue({ challenge: 'registration-challenge' });
    generateAuthenticationOptions.mockReset().mockResolvedValue({ challenge: 'authentication-challenge' });
    verifyRegistrationResponse.mockReset().mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: 'credential-id',
          publicKey: Buffer.from([1, 2, 3]),
          counter: 0,
        },
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
      },
    });
    verifyAuthenticationResponse.mockReset().mockResolvedValue({
      verified: true,
      authenticationInfo: {
        userVerified: true,
        newCounter: 1,
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
      },
    });
    query.mockImplementation(async (sql) => {
      if (sql.includes('FROM clients') && sql.includes('access_token')) {
        return { rows: [client], rowCount: 1 };
      }
      if (sql.includes('FROM client_passkeys')) return { rows: [], rowCount: 0 };
      if (sql.includes('DELETE FROM webauthn_challenges')) {
        return {
          rows: [{
            expected_origin: 'https://beerpos.onrender.com',
            rp_id: 'beerpos.onrender.com',
            requested_quantity: 1,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });
    dbQuery.mockImplementation(async (sql) => {
      if (sql.includes('SELECT id FROM clients')) return { rows: [client], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
  });

  test('creates a short-lived registration challenge for a client with no enrolled passkey', async () => {
    const response = await request(app)
      .post('/api/client-passkeys/registration/options')
      .set('Origin', 'https://beerpos.onrender.com')
      .set('x-client-token', 'client-token');

    expect(response.status).toBe(200);
    expect(response.body.challenge).toBe('registration-challenge');
    expect(generateRegistrationOptions).toHaveBeenCalledWith(expect.objectContaining({
      rpID: 'beerpos.onrender.com',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    }));
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO webauthn_challenges'),
      expect.arrayContaining(['registration-challenge', 'client-registration', client.id, client.establishment_id])
    );
  });

  test('requires a fresh management authentication before registering an additional passkey', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('FROM clients') && sql.includes('access_token')) {
        return { rows: [client], rowCount: 1 };
      }
      if (sql.includes('FROM client_passkeys')) {
        return { rows: [{ credential_id: 'existing-id', transports: ['internal'] }], rowCount: 1 };
      }
      if (sql.includes('DELETE FROM client_passkey_authorizations')) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    });

    const response = await request(app)
      .post('/api/client-passkeys/registration/options')
      .set('Origin', 'https://beerpos.onrender.com')
      .set('x-client-token', 'client-token');

    expect(response.status).toBe(401);
    expect(generateRegistrationOptions).not.toHaveBeenCalled();
  });

  test('binds a withdrawal authentication challenge to the requested quantity', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('FROM clients') && sql.includes('access_token')) {
        return { rows: [client], rowCount: 1 };
      }
      if (sql.includes('FROM client_passkeys')) {
        return { rows: [{ credential_id: 'credential-id', transports: ['internal'] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    const invalid = await request(app)
      .post('/api/client-passkeys/authentication/options')
      .set('Origin', 'https://beerpos.onrender.com')
      .set('x-client-token', 'client-token')
      .send({ purpose: 'withdrawal', quantity: 0 });
    const valid = await request(app)
      .post('/api/client-passkeys/authentication/options')
      .set('Origin', 'https://beerpos.onrender.com')
      .set('x-client-token', 'client-token')
      .send({ purpose: 'withdrawal', quantity: 2 });

    expect(invalid.status).toBe(400);
    expect(valid.status).toBe(200);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO webauthn_challenges'),
      expect.arrayContaining(['authentication-challenge', 'client-withdrawal', client.id, client.establishment_id, 2])
    );
  });

  test('stores only a verified public credential and rejects replayed registration challenges', async () => {
    let challengeAvailable = true;
    query.mockImplementation(async (sql) => {
      if (sql.includes('FROM clients') && sql.includes('access_token')) {
        return { rows: [client], rowCount: 1 };
      }
      if (sql.includes('DELETE FROM webauthn_challenges')) {
        if (!challengeAvailable) return { rows: [], rowCount: 0 };
        challengeAvailable = false;
        return {
          rows: [{
            expected_origin: 'https://beerpos.onrender.com',
            rp_id: 'beerpos.onrender.com',
            requested_quantity: null,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });
    dbQuery.mockImplementation(async (sql) => {
      if (sql.includes('SELECT id FROM clients')) return { rows: [client], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const registration = {
      id: 'credential-id',
      rawId: 'credential-id',
      type: 'public-key',
      response: { clientDataJSON: 'client-data', attestationObject: 'attestation' },
    };

    const first = await request(app)
      .post('/api/client-passkeys/registration/verify')
      .set('x-client-token', 'client-token')
      .send({ challenge: 'registration-challenge', response: registration });
    const replay = await request(app)
      .post('/api/client-passkeys/registration/verify')
      .set('x-client-token', 'client-token')
      .send({ challenge: 'registration-challenge', response: registration });

    expect(first.status).toBe(201);
    expect(dbQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO client_passkeys'),
      expect.arrayContaining(['credential-id', client.id, client.establishment_id])
    );
    expect(replay.status).toBe(400);
    expect(verifyRegistrationResponse).toHaveBeenCalledTimes(1);
  });

  test('issues a scoped authorization only after user-verified authentication', async () => {
    const credential = {
      id: 3,
      credential_id: 'credential-id',
      public_key: Buffer.from([1, 2, 3]),
      sign_count: '0',
      transports: ['internal'],
    };
    query.mockImplementation(async (sql) => {
      if (sql.includes('FROM clients') && sql.includes('access_token')) {
        return { rows: [client], rowCount: 1 };
      }
      if (sql.includes('DELETE FROM webauthn_challenges')) {
        return {
          rows: [{
            expected_origin: 'https://beerpos.onrender.com',
            rp_id: 'beerpos.onrender.com',
            requested_quantity: 1,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('FROM client_passkeys')) return { rows: [credential], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });

    const response = await request(app)
      .post('/api/client-passkeys/authentication/verify')
      .set('x-client-token', 'client-token')
      .send({
        challenge: 'authentication-challenge',
        purpose: 'withdrawal',
        response: {
          id: 'credential-id',
          rawId: 'credential-id',
          type: 'public-key',
          response: { clientDataJSON: 'client-data', authenticatorData: 'auth-data' },
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.authorization).toEqual(expect.any(String));
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO client_passkey_authorizations'),
      expect.arrayContaining([expect.any(String), client.id, client.establishment_id, 'withdrawal', 1])
    );
    expect(verifyAuthenticationResponse).toHaveBeenCalledWith(expect.objectContaining({
      expectedOrigin: 'https://beerpos.onrender.com',
      expectedRPID: 'beerpos.onrender.com',
      requireUserVerification: true,
    }));
  });
});
