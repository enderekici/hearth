import os from 'node:os';
import net from 'node:net';

function normalizeHostname(value) {
  const hostname = value.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (net.isIP(hostname)) return hostname;
  if (hostname.length > 253 || !hostname
      || !hostname.split('.').every(label => label.length <= 63
        && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return null;
  return hostname;
}

function localNames() {
  const names = new Set(['localhost', '127.0.0.1', '::1']);
  for (const configured of (process.env.ALLOWED_HOSTS || '').split(',').map(x => x.trim()).filter(Boolean)) {
    const hostname = normalizeHostname(configured);
    if (hostname) names.add(hostname);
  }
  for (const list of Object.values(os.networkInterfaces())) for (const item of list || []) {
    const hostname = normalizeHostname(item.address);
    if (hostname) names.add(hostname);
  }
  return names;
}

export function isSafeLocalRequest(req) {
  const host = req.headers.host;
  if (typeof host !== 'string' || host.length > 255 || /[@\s\\/?#]/.test(host) || host.endsWith(':')) return false;
  let parsed;
  try { parsed = new URL('http://' + host); } catch { return false; }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return false;
  const hostname = normalizeHostname(parsed.hostname);
  const port = Number(parsed.port || 80);
  if (!hostname || port < 1 || port > 65535 || !localNames().has(hostname)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const value = new URL(origin);
    if (value.protocol !== 'http:' || value.username || value.password
        || value.pathname !== '/' || value.search || value.hash) return false;
    return normalizeHostname(value.hostname) && value.hostname.toLowerCase() === parsed.hostname.toLowerCase()
      && Number(value.port || 80) === port;
  } catch { return false; }
}

export function requireSafeLocal(req, res) {
  if (isSafeLocalRequest(req)) return true;
  res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify({ error: 'local_origin_required' }));
  return false;
}
