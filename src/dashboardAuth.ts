const COOKIE_NAME = 'hera_preconsult_session';
const SESSION_HOURS = 8;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

function secureEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function dashboardPasswordMatches(input: string | undefined, expected: string | undefined): boolean {
  if (!input || !expected) return false;
  return secureEqual(input, expected);
}

export async function createDashboardSession(signingSecret: string, now = Date.now()): Promise<string> {
  const expiresAt = now + SESSION_HOURS * 60 * 60 * 1000;
  const payload = `v1.${expiresAt}`;
  return `${payload}.${await hmac(signingSecret, payload)}`;
}

export async function verifyDashboardSession(token: string | undefined, signingSecret: string, now = Date.now()): Promise<boolean> {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  const expiresAt = Number(parts[1]);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = await hmac(signingSecret, payload);
  return secureEqual(parts[2], expected);
}

function cookieValue(request: Request, name: string): string | undefined {
  const raw = request.headers.get('cookie') ?? '';
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

export async function isDashboardAuthorized(request: Request, env: Record<string, string | undefined>): Promise<boolean> {
  const signingSecret = env.CRON_SECRET;
  if (!signingSecret) return false;
  return verifyDashboardSession(cookieValue(request, COOKIE_NAME), signingSecret);
}

export function sessionCookie(token: string): string {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_HOURS * 60 * 60}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
