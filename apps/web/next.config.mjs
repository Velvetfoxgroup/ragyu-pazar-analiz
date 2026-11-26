/** API istekleri aynı kökenden (/api) geçer; çerez SameSite=Strict çalışır ve CORS gerekmez. */
const API = process.env.API_URL ?? 'http://localhost:4000';
export default {
  output: 'standalone',
  poweredByHeader: false,
  async rewrites() { return [{ source: '/api/:path*', destination: `${API}/api/:path*` }]; },
  async headers() { return [{ source: '/:path*', headers: [{ key: 'X-Frame-Options', value: 'DENY' }, { key: 'X-Content-Type-Options', value: 'nosniff' }, { key: 'Referrer-Policy', value: 'same-origin' }] }]; },
};
