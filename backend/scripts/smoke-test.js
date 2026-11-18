// BeerPOS post-deploy smoke test.
//
// Runs a set of safe (mostly read-only) checks against a deployed instance and
// exits non-zero if any critical check fails. Use it right after a Render deploy.
//
// Usage (from backend/):
//   node scripts/smoke-test.js
//
// Configuration via env:
//   SMOKE_BASE_URL      Base URL (default: http://localhost:3001)
//   SMOKE_EST_ID        Establishment id to test (default: 1)
//   SMOKE_STAFF_NAME    Staff username for login (optional)
//   SMOKE_STAFF_PIN     Staff PIN (optional)
//   SMOKE_ADMIN_NAME    Platform admin username (optional)
//   SMOKE_ADMIN_PIN     Platform admin PIN (optional)
//
// Environment variables SMOKE_STAFF_* / SMOKE_ADMIN_* enable the authenticated
// checks. Without them the script still runs the public checks.
//
// Exit code: 0 = all passed, 1 = one or more critical checks failed.

const BASE = (process.env.SMOKE_BASE_URL || 'http://localhost:3001').replace(/\/+$/, '');
const EST_ID = process.env.SMOKE_EST_ID || '1';

let failures = 0;
let passes = 0;

function ok(name) {
  passes++;
  console.log(`  \u2713 ${name}`);
}
function fail(name, detail) {
  failures++;
  console.error(`  \u2717 ${name}${detail ? ' -> ' + detail : ''}`);
}

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { res, json, text };
}

function jsonPost(body, token) {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-session-token': token } : {}),
    },
    body: JSON.stringify(body),
  };
}

async function checkHealth() {
  console.log('\n[1] Health & liveness');
  try {
    const { res, json } = await req('/api/health/live');
    if (res.status === 200 && json?.ok === true && json?.db === 'up') ok('GET /api/health/live -> 200 db up');
    else fail('GET /api/health/live', `status ${res.status} ${JSON.stringify(json)}`);
  } catch (e) { fail('GET /api/health/live', e.message); }
}

async function checkPublicEstablishment() {
  console.log('\n[2] Public establishment payload');
  try {
    const { res, json } = await req(`/api/establishments/${EST_ID}`);
    if (res.status !== 200) return fail('GET /api/establishments/:id', `status ${res.status}`);
    if (!json?.name) return fail('establishment has name', JSON.stringify(json));
    if ('owner_name' in (json || {}) || 'phone' in (json || {}))
      return fail('public payload hides owner_name/phone', 'leaked sensitive fields');
    ok('GET /api/establishments/:id -> public fields only');
  } catch (e) { fail('GET /api/establishments/:id', e.message); }
}

async function checkAuthList() {
  console.log('\n[3] Establishments list (login dropdown)');
  try {
    const { res, json } = await req('/api/auth');
    if (res.status === 200 && Array.isArray(json) && json.length > 0) ok(`GET /api/auth -> ${json.length} establishment(s)`);
    else fail('GET /api/auth', `status ${res.status}`);
  } catch (e) { fail('GET /api/auth', e.message); }
}

async function checkSecurityHeaders() {
  console.log('\n[4] Security headers (Helmet)');
  try {
    const { res } = await req('/api/health/live');
    const ncto = res.headers.get('x-content-type-options');
    if (ncto === 'nosniff') ok('X-Content-Type-Options: nosniff');
    else fail('X-Content-Type-Options', ncto || 'missing');
  } catch (e) { fail('security headers', e.message); }
}

async function checkStaffLogin() {
  const name = process.env.SMOKE_STAFF_NAME;
  const pin = process.env.SMOKE_STAFF_PIN;
  if (!name || !pin) { console.log('\n[5] Staff login (skipped: set SMOKE_STAFF_NAME/PIN)'); return; }
  console.log('\n[5] Staff login & protected endpoint');
  try {
    const { res, json } = await req('/api/auth/login', jsonPost({ establishment_id: Number(EST_ID), name, pin }));
    if (res.status !== 200 || !json?.sessionToken) return fail('staff login', `status ${res.status} ${JSON.stringify(json)}`);
    ok('staff login -> sessionToken');
    const summary = await req(`/api/transactions/summary/${EST_ID}`, { headers: { 'x-session-token': json.sessionToken } });
    if (summary.res.status === 200) ok('GET /api/transactions/summary/:id (authed)');
    else fail('GET /api/transactions/summary/:id', `status ${summary.res.status}`);
  } catch (e) { fail('staff login', e.message); }
}

async function checkPlatformLogin() {
  const name = process.env.SMOKE_ADMIN_NAME;
  const pin = process.env.SMOKE_ADMIN_PIN;
  if (!name || !pin) { console.log('\n[6] Platform admin (skipped: set SMOKE_ADMIN_NAME/PIN)'); return; }
  console.log('\n[6] Platform admin login & metrics');
  try {
    const { res, json } = await req('/api/auth/login', jsonPost({ establishment_id: 0, name, pin }));
    if (res.status !== 200 || json?.staff?.role !== 'platform_admin') return fail('platform login', `status ${res.status} role ${json?.staff?.role}`);
    ok('platform admin login');
    const m = await req('/api/platform/metrics', { headers: { 'x-session-token': json.sessionToken } });
    if (m.res.status === 200) ok('GET /api/platform/metrics (authed)');
    else fail('GET /api/platform/metrics', `status ${m.res.status}`);
  } catch (e) { fail('platform admin', e.message); }
}

async function checkUnauthorized() {
  console.log('\n[7] Auth is enforced');
  try {
    const { res } = await req('/api/clients?establishment_id=' + EST_ID);
    if (res.status === 401) ok('GET /api/clients without token -> 401');
    else fail('GET /api/clients should be 401', `got ${res.status}`);
  } catch (e) { fail('auth enforcement', e.message); }
}

async function main() {
  console.log(`BeerPOS smoke test against ${BASE} (est ${EST_ID})`);
  await checkHealth();
  await checkPublicEstablishment();
  await checkAuthList();
  await checkSecurityHeaders();
  await checkUnauthorized();
  await checkStaffLogin();
  await checkPlatformLogin();

  console.log(`\nResult: ${passes} passed, ${failures} failed.`);
  const code = failures > 0 ? 1 : 0;
  if (failures > 0) console.error('SMOKE TEST FAILED');
  else console.log('SMOKE TEST PASSED');
  process.exitCode = code;
  // Give undici/fetch sockets a moment to close before exiting (avoids a Node/Windows
  // libuv assertion when calling process.exit while handles are closing).
  setTimeout(() => process.exit(code), 250);
}

main().catch((e) => { console.error('smoke-test crashed:', e); process.exit(1); });