import speakeasy from 'speakeasy';

/**
 * Genera un secreto TOTP base32 para un staff.
 */
export function generateTOTPSecret() {
  return speakeasy.generateSecret({ length: 20 }).base32;
}

/**
 * Genera la URL provisioning para mostrar un QR al usuario (Google Authenticator, etc.)
 */
export function getTOTPAuthUrl(secret, staffName, establishmentName) {
  return speakeasy.otpauthURL({
    secret,
    label: `${establishmentName} - ${staffName}`,
    issuer: establishmentName,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  });
}

/**
 * Verifica un código TOTP de 6 dígitos.
 * window: 1 permite ±1 periodo (30s) de tolerancia por desfases de reloj.
 */
export function verifyTOTPToken(secret, token, window = 1) {
  return speakeasy.totp.verify({
    secret,
    encoding: 'base32',
    token,
    window,
  });
}
