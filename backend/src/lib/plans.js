// Subscription plan catalog.
//
// A single source of truth for plans, prices and limits. The platform admin
// console and the billing logic both read from here.
//
// maxClients / maxEstablishments: null = unlimited.
// priceUsd: null = "quote" (Enterprise), not self-serve.

export const PLANS = {
  free: {
    id: 'free',
    name: 'Gratis',
    priceUsd: 0,
    maxClients: 20,
    maxEstablishments: 1,
    features: ['reportes_basicos'],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceUsd: 12,
    maxClients: null,
    maxEstablishments: 1,
    features: ['reportes', 'export_pdf', 'export_excel', 'qr_antifraude'],
  },
  business: {
    id: 'business',
    name: 'Business',
    priceUsd: 32,
    maxClients: null,
    maxEstablishments: 3,
    features: ['2fa', 'biometricos', 'soporte_prioritario'],
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    priceUsd: null, // cotizar
    maxClients: null,
    maxEstablishments: null,
    features: ['sla', 'integraciones', 'marca_blanca'],
  },
};

/** Default plan when none is specified. */
export const DEFAULT_PLAN = 'free';

/** Grace period (days) after current_period_end before auto-suspension. */
export const GRACE_PERIOD_DAYS = 3;

/** Look up a plan by id; falls back to the default plan for unknown ids. */
export function getPlan(planId) {
  return PLANS[planId] || PLANS[DEFAULT_PLAN];
}

/** True if the id is a known plan. */
export function isKnownPlan(planId) {
  return Object.prototype.hasOwnProperty.call(PLANS, planId);
}

/** List all plans as an array (for the console). */
export function listPlans() {
  return Object.values(PLANS);
}

/**
 * Check a limit for a plan.
 * @param {string} planId
 * @param {'maxClients'|'maxEstablishments'} kind
 * @param {number} current usage
 * @returns {{ allowed: boolean, limit: number|null }}
 */
export function checkLimit(planId, kind, current) {
  const plan = getPlan(planId);
  const limit = plan[kind];
  if (limit === null || limit === undefined) return { allowed: true, limit: null };
  return { allowed: Number(current) < limit, limit };
}