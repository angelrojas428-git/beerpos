// Resolve the Socket.io connection URL from the current page location.
//
// Production: same-origin, so it works behind a TLS reverse proxy on 443
// (e.g. https://midominio.com/socket.io), with no hardcoded port or mixed content.
//
// Dev fallback: when the page is served by BrowserSync on :3000, the API and
// Socket.io live on :3001, so target that explicitly. Direct :3001 access is
// already same-origin and needs no rewrite.
//
// Pure function (no browser globals) so it can be unit-tested.
export function computeSocketUrl(loc) {
  const protocol = loc.protocol || 'http:';
  const hostname = loc.hostname || 'localhost';
  const port = loc.port || '';
  if (port === '3000') {
    return `${protocol}//${hostname}:3001`;
  }
  return `${protocol}//${hostname}${port ? ':' + port : ''}`;
}