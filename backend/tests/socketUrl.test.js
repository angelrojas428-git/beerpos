import { describe, expect, test } from '@jest/globals';
import { computeSocketUrl } from '../../frontend/js/socketUrl.js';

describe('computeSocketUrl', () => {
  test('production (https, no port) resolves to same-origin', () => {
    expect(computeSocketUrl({ protocol: 'https:', hostname: 'midominio.com', port: '' }))
      .toBe('https://midominio.com');
  });

  test('production on port 443 keeps same-origin', () => {
    expect(computeSocketUrl({ protocol: 'https:', hostname: 'midominio.com', port: '443' }))
      .toBe('https://midominio.com:443');
  });

  test('BrowserSync dev (:3000) targets the API on :3001', () => {
    expect(computeSocketUrl({ protocol: 'http:', hostname: 'localhost', port: '3000' }))
      .toBe('http://localhost:3001');
  });

  test('direct :3001 access stays same-origin', () => {
    expect(computeSocketUrl({ protocol: 'http:', hostname: 'localhost', port: '3001' }))
      .toBe('http://localhost:3001');
  });

  test('LAN dev host on :3000 still targets :3001', () => {
    expect(computeSocketUrl({ protocol: 'http:', hostname: '192.168.0.117', port: '3000' }))
      .toBe('http://192.168.0.117:3001');
  });
});