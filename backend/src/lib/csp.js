// Content Security Policy directives (enforced in production).
//
// Tuned so the app keeps working while adding meaningful hardening:
//  - 'unsafe-eval'  → Alpine.js evaluates x-data expressions via new Function
//  - 'unsafe-inline' (script/style) → inline <style> (dark mode) and the inline
//    service-worker registration <script> in index.html
//  - img-src cdn.jsdelivr.net → Twemoji SVGs
//  - connect-src ws:/wss: → Socket.io + SSE
//  - object-src/base-uri/form-action/frame-ancestors → real hardening
//
// A stricter nonce-based CSP (removing 'unsafe-inline'/'unsafe-eval') requires the
// @alpinejs/csp build and templating index.html per request — tracked as a future step.

export const cspDirectives = {
  'default-src': ["'self'"],
  'script-src': ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'https://cdn.jsdelivr.net'],
  'connect-src': ["'self'", 'ws:', 'wss:'],
  'font-src': ["'self'", 'data:'],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'self'"],
};