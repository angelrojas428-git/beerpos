import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, jest, test } from '@jest/globals';

const serviceWorkerSource = readFileSync(
  new URL('../../frontend/sw.js', import.meta.url),
  'utf8'
);

function createServiceWorker(fetch) {
  const listeners = {};
  const put = jest.fn();
  const caches = {
    open: jest.fn().mockResolvedValue({ put }),
    match: jest.fn().mockResolvedValue(null),
  };
  const self = {
    location: { origin: 'https://beerpos.example' },
    addEventListener: (type, listener) => { listeners[type] = listener; },
  };

  runInNewContext(serviceWorkerSource, { self, URL, caches, fetch });
  return { listeners, caches, put };
}

describe('service worker fetch scope', () => {
  test('does not intercept external CDN resources', () => {
    const fetch = jest.fn();
    const { listeners } = createServiceWorker(fetch);
    const respondWith = jest.fn();

    listeners.fetch({
      request: { url: 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.0.3/assets/svg/2705.svg', method: 'GET' },
      respondWith,
    });

    expect(respondWith).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  test('keeps network-first caching for same-origin assets', async () => {
    const response = { ok: true, clone: jest.fn(() => 'cached response') };
    const fetch = jest.fn().mockResolvedValue(response);
    const { listeners, caches, put } = createServiceWorker(fetch);
    const responses = [];

    listeners.fetch({
      request: { url: 'https://beerpos.example/dist/app.js', method: 'GET' },
      respondWith: (promise) => responses.push(promise),
    });

    await expect(responses[0]).resolves.toBe(response);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(caches.open).toHaveBeenCalledWith('beerpos-v11');
    expect(put).toHaveBeenCalledWith(
      { url: 'https://beerpos.example/dist/app.js', method: 'GET' },
      'cached response'
    );
  });
});
