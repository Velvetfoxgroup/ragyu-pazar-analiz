import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';

export class UrlBlockedError extends Error {}

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return true;
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith('ff');
  }
  return true;
}

export function allowedHostsFromEnv(): string[] {
  return (process.env.SCRAPER_ALLOW_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** Yalnızca genel internet adreslerine giden http(s) URL'lerini kabul eder. */
export function validateUrlSyntax(raw: string, allow: string[] = allowedHostsFromEnv()): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new UrlBlockedError('Geçersiz URL.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UrlBlockedError('Yalnızca http/https adresleri kabul edilir.');
  if (u.username || u.password) throw new UrlBlockedError('URL içinde kullanıcı bilgisi olamaz.');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const hostPort = `${host}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
  const allowed = allow.includes(host) || allow.includes(hostPort);
  if (allowed) return u;
  if (u.port && !['80', '443'].includes(u.port)) throw new UrlBlockedError('Yalnızca 80/443 portları kabul edilir.');
  if (net.isIP(host)) { if (isPrivateIp(host)) throw new UrlBlockedError('Yerel/dahili ağ adreslerine erişim engellendi.'); return u; }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan') || !host.includes('.')) {
    throw new UrlBlockedError('Yerel/dahili ağ adreslerine erişim engellendi.');
  }
  return u;
}

function safeLookup(allow: string[]): any {
  return (hostname: string, options: any, cb: any) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addrs: any) => {
      if (err) return cb(err);
      const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: 4 }];
      const bad = list.find((a: any) => isPrivateIp(a.address));
      if (bad && !allow.includes(hostname.toLowerCase())) return cb(new UrlBlockedError('Alan adı yerel/dahili bir adrese çözümleniyor; engellendi.'));
      if (options?.all) return cb(null, list);
      cb(null, list[0].address, list[0].family);
    });
  };
}

export interface FetchOpts { timeoutMs?: number; maxBytes?: number; maxRedirects?: number; allow?: string[]; userAgent?: string }
export interface FetchResult { status: number; body: string; finalUrl: string; contentType: string }

export async function safeFetch(rawUrl: string, opts: FetchOpts = {}): Promise<FetchResult> {
  const allow = opts.allow ?? allowedHostsFromEnv();
  const timeoutMs = opts.timeoutMs ?? 10000;
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  const maxRedirects = opts.maxRedirects ?? 3;
  let url = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const u = validateUrlSyntax(url, allow);
    const res = await once(u, { timeoutMs, maxBytes, allow, userAgent: opts.userAgent });
    if (res.status >= 300 && res.status < 400 && res.location) {
      url = new URL(res.location, u).toString();
      continue; // her yönlendirme yeniden doğrulanır
    }
    return { status: res.status, body: res.body, finalUrl: u.toString(), contentType: res.contentType };
  }
  throw new UrlBlockedError('Çok fazla yönlendirme.');
}

function once(u: URL, o: { timeoutMs: number; maxBytes: number; allow: string[]; userAgent?: string }) {
  return new Promise<{ status: number; body: string; location?: string; contentType: string }>((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: 'GET', lookup: safeLookup(o.allow), timeout: o.timeoutMs,
      headers: { 'User-Agent': o.userAgent ?? 'RagyuPazarAnaliz/1.0 (+fiyat izleme)', Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'tr-TR,tr;q=0.9' },
    }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) { res.resume(); return resolve({ status, body: '', location: String(res.headers.location), contentType: '' }); }
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (c: Buffer) => { size += c.length; if (size > o.maxBytes) { req.destroy(new Error('Yanıt boyut sınırını aştı.')); } else chunks.push(c); });
      res.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8'), contentType: String(res.headers['content-type'] ?? '') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('İstek zaman aşımına uğradı.')));
    req.on('error', reject);
    req.end();
  });
}
