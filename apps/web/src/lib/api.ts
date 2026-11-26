export class ApiError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
export async function api<T = any>(path: string, opts: { method?: string; body?: any; query?: Record<string, any> } = {}): Promise<T> {
  const qs = opts.query ? '?' + new URLSearchParams(Object.entries(opts.query).filter(([, v]) => v !== undefined && v !== '' && v !== null).map(([k, v]) => [k, String(v)])).toString() : '';
  const res = await fetch('/api' + path + qs, {
    method: opts.method ?? 'GET', credentials: 'same-origin',
    headers: { 'X-Requested-With': 'ragyu', ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(res.status, data?.code ?? 'error', data?.message ?? 'Bir hata oluştu');
  return data as T;
}
export const downloadUrl = (path: string, query: Record<string, any> = {}) => '/api' + path + '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)])).toString();
