import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const pool = { query: jest.fn() };
jest.unstable_mockModule('../src/db/pool.js', () => ({ pool }));

const { bootstrap } = await import('../src/db/bootstrap.js');

describe('database bootstrap', () => {
  beforeEach(() => {
    pool.query.mockReset();
    process.env.DB_AUTOINIT = '1';
    delete process.env.BOOTSTRAP_ADMIN_NAME;
    delete process.env.BOOTSTRAP_ADMIN_PIN;
  });

  test('propagates schema failures so the server cannot start with a partial schema', async () => {
    const error = new Error('database unavailable');
    pool.query.mockRejectedValueOnce(error);

    await expect(bootstrap()).rejects.toBe(error);
  });
});
