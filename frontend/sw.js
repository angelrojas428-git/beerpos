const CACHE = 'beerpos-v11';
const ASSETS = ['/', '/index.html', '/css/app.css', '/dist/app.js', '/dist/tailwind.css', '/manifest.webmanifest', '/assets/icon.svg'];
const DB_NAME = 'beerpos-offline';
const STORE_NAME = 'fast-sales';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  // Never cache API requests — always pass through to network
  if (requestUrl.pathname.startsWith('/api/')) {
    if (event.request.method === 'POST'
      && requestUrl.pathname === '/api/redemptions/fast'
      && event.request.headers.get('X-Background-Sync') === 'true') {
      event.respondWith(fetch(event.request).catch(() => queueFastSale(event.request)));
    }
    // For all other API requests, just pass through without caching
    return;
  }

  if (event.request.method !== 'GET') return;
  event.respondWith((async () => {
    try {
      const response = await fetch(event.request);
      if (response.ok) {
        const cache = await caches.open(CACHE);
        await cache.put(event.request, response.clone());
      }
      return response;
    } catch (error) {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      if (event.request.mode === 'navigate') {
        const shell = await caches.match('/');
        if (shell) return shell;
      }
      throw error;
    }
  })());
});

self.addEventListener('sync', (event) => {
  if (event.tag === 'beerpos-fast-sales') event.waitUntil(syncFastSales());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'GET_SYNC_STATUS') {
    event.waitUntil(getQueue().then((items) => sendMessage(event.source, {
      type: 'sync-status',
      count: items.length,
      failedCount: items.filter((item) => item.failed).length
    })));
  }
  if (event.data?.type === 'SYNC_PENDING') {
    event.waitUntil(retryFastSales());
  }
});

function openQueueDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME, { keyPath: 'requestId' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function queueTransaction(mode, callback) {
  const database = await openQueueDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const store = transaction.objectStore(STORE_NAME);
      const request = callback(store);
      transaction.oncomplete = () => resolve(request?.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

function getQueue() {
  return queueTransaction('readonly', (store) => store.getAll());
}

function saveQueueItem(item) {
  return queueTransaction('readwrite', (store) => store.put(item));
}

function deleteQueueItem(requestId) {
  return queueTransaction('readwrite', (store) => store.delete(requestId));
}

async function queueFastSale(request) {
  const body = await request.clone().json();
  if (!body.request_id) throw new Error('No se pudo encolar la venta: falta el identificador de solicitud.');
  await saveQueueItem({
    requestId: body.request_id,
    url: request.url,
    method: request.method,
    headers: [...request.headers.entries()]
      .filter(([name]) => name.toLowerCase() !== 'x-session-token'),
    body: JSON.stringify(body),
    failed: false,
    createdAt: Date.now()
  });
  const queue = await getQueue();
  await notifyClients({ type: 'sync-queued', count: queue.length });
  try {
    const registration = await self.registration;
    if (registration.sync) await registration.sync.register('beerpos-fast-sales');
  } catch (error) {
    await notifyClients({
      type: 'sync-error',
      count: queue.length,
      message: 'Venta guardada; abre la aplicación con conexión para sincronizar.'
    });
  }
  return new Response(JSON.stringify({ queued: true, pending_count: queue.length }), {
    status: 202,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function syncFastSales() {
  const queue = await getQueue();
  for (const item of queue) {
    if (item.failed) continue;
    const headers = new Headers(item.headers);
    headers.delete('X-Background-Sync');
    let response;
    try {
      response = await fetch(item.url, {
        method: item.method,
        headers,
        body: item.body
      });
    } catch (error) {
      throw error;
    }
    if (response.ok) {
      await deleteQueueItem(item.requestId);
      const remaining = await getQueue();
      await notifyClients({ type: 'sync-complete', count: remaining.length });
      continue;
    }
    if (response.status === 429) throw new Error('El servidor limitó temporalmente las ventas sincronizadas.');
    if (response.status >= 400 && response.status < 500) {
      item.failed = true;
      await saveQueueItem(item);
      await notifyClients({
        type: 'sync-error',
        count: (await getQueue()).length,
        message: `Una venta pendiente requiere atención (HTTP ${response.status}).`
      });
      continue;
    }
    throw new Error(`La sincronización respondió HTTP ${response.status}.`);
  }
}

async function retryFastSales() {
  const queue = await getQueue();
  await Promise.all(queue.filter((item) => item.failed).map((item) => {
    item.failed = false;
    return saveQueueItem(item);
  }));
  await syncFastSales();
}

async function notifyClients(message) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  await Promise.all(clients.map((client) => sendMessage(client, message)));
}

function sendMessage(client, message) {
  if (client) client.postMessage(message);
  return Promise.resolve();
}
