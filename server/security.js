import os from 'node:os';
import net from 'node:net';

function localNames() {
  const names = new Set(['localhost', '127.0.0.1', '::1']);
  for (const host of (process.env.ALLOWED_HOSTS || '').split(',').map(x => x.trim()).filter(Boolean)) names.add(host);
  for (const list of Object.values(os.networkInterfaces())) for (const item of list || []) names.add(item.address);
  return names;
}

export function isSafeLocalRequest(req) {
  const host = req.headers.host;
  if (!host || host.length > 255 || /[@\s\\]/.test(host)) return false;
  let parsed;
  try { parsed = new URL('http://' + host); } catch { return false; }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!localNames().has(hostname) || (!net.isIP(hostname) && hostname !== 'localhost')) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const value = new URL(origin);
    return value.protocol === 'http:' && value.host.toLowerCase() === host.toLowerCase();
  } catch { return false; }
}

export function requireSafeLocal(req, res) {
  if (isSafeLocalRequest(req)) return true;
  res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify({ error: 'local_origin_required' }));
  return false;
}
