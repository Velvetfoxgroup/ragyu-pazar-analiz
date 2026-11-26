import { randomBytes, scrypt as _scrypt, timingSafeEqual, createHash } from 'node:crypto';

export type Role = 'admin' | 'editor' | 'approver' | 'viewer';
export const ROLES: Role[] = ['admin', 'editor', 'approver', 'viewer'];
export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Sistem yöneticisi', editor: 'E-ticaret editörü', approver: 'Onay yetkilisi', viewer: 'Salt okunur yönetici',
};

export type Permission =
  | 'read' | 'catalog:write' | 'url:write' | 'check:run' | 'match:write' | 'match:approve'
  | 'gram:write' | 'gram:approve' | 'source:manage' | 'user:manage' | 'audit:read' | 'alert:resolve';

const P: Record<Role, Permission[]> = {
  admin: ['read', 'catalog:write', 'url:write', 'check:run', 'match:write', 'match:approve', 'gram:write', 'gram:approve', 'source:manage', 'user:manage', 'audit:read', 'alert:resolve'],
  editor: ['read', 'catalog:write', 'url:write', 'check:run', 'match:write', 'gram:write', 'alert:resolve'],
  approver: ['read', 'check:run', 'match:approve', 'gram:approve', 'alert:resolve', 'audit:read'],
  viewer: ['read'],
};
export const can = (role: Role, perm: Permission) => P[role]?.includes(perm) ?? false;
export const permissionsOf = (role: Role) => P[role] ?? [];

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const scrypt = (pw: string, salt: Buffer, len: number) =>
  new Promise<Buffer>((res, rej) => _scrypt(pw, salt, len, SCRYPT, (e, k) => (e ? rej(e) : res(k))));

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, , saltB64, keyB64] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const key = Buffer.from(keyB64, 'base64');
  const test = await scrypt(password, Buffer.from(saltB64, 'base64'), key.length);
  return timingSafeEqual(key, test);
}

/** Parola politikası: en az 10 karakter, harf ve rakam içermeli. */
export function passwordProblem(pw: string): string | null {
  if (pw.length < 10) return 'Şifre en az 10 karakter olmalıdır.';
  if (!/[A-Za-zÇĞİÖŞÜçğıöşü]/.test(pw) || !/\d/.test(pw)) return 'Şifre hem harf hem rakam içermelidir.';
  return null;
}

export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');
export const generateTempPassword = () => randomBytes(9).toString('base64url') + '7a';
