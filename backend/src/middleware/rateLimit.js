import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

// Disable rate limiting under tests so suites are deterministic (Jest sets NODE_ENV=test).
const skipInTests = () => process.env.NODE_ENV === 'test';

export const clientLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  message: { error: 'Demasiadas solicitudes, intente más tarde.' }
});

// Limiter estricto para login: máximo 5 intentos por ventana de 15 min por IP
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip || req.connection.remoteAddress || 'unknown'),
  skip: skipInTests,
  message: { error: 'Demasiados intentos de inicio de sesión. Intente nuevamente en 15 minutos.' }
});

export const redeemLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  message: { error: 'Límite de redenciones alcanzado.' }
});

export const fastSaleLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  message: { error: 'Límite de ventas rápidas alcanzado.' }
});

export const tokenRotationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  message: { error: 'Límite de rotación de tokens alcanzado.' }
});