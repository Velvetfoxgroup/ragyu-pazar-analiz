import { tr } from '@/messages/tr';
const catalogs: Record<string, Record<string, string>> = { tr };
let locale = 'tr';
export const setLocale = (l: string) => { if (catalogs[l]) locale = l; };
export function t(key: string, vars?: Record<string, string | number>): string {
  let s = catalogs[locale][key] ?? catalogs.tr[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  return s;
}
