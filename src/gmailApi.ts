import { buildLifecycleQueryForWindow, type SyncWindow } from './syncPolicy.js';

export interface GoogleOAuthCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface GmailLifecycleMessage {
  id: string;
  threadId?: string;
  subject: string;
  body: string;
  receivedAt: string;
}

interface GmailListResponse {
  messages?: Array<{ id: string; threadId?: string }>;
  nextPageToken?: string;
}

interface GmailHeader {
  name?: string;
  value?: string;
}

interface GmailBody {
  data?: string;
}

interface GmailPart {
  mimeType?: string;
  headers?: GmailHeader[];
  body?: GmailBody;
  parts?: GmailPart[];
}

interface GmailMessageResponse {
  id: string;
  threadId?: string;
  internalDate?: string;
  payload?: GmailPart;
}

function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"');
}

function collectBodies(part: GmailPart | undefined, plain: string[], html: string[]): void {
  if (!part) return;
  const mime = part.mimeType?.toLowerCase();
  const data = part.body?.data;
  if (data && mime === 'text/plain') plain.push(decodeBase64Url(data));
  if (data && mime === 'text/html') html.push(decodeBase64Url(data));
  for (const child of part.parts ?? []) collectBodies(child, plain, html);
}

function headerValue(headers: GmailHeader[] | undefined, name: string): string | undefined {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value;
}

async function googleFetch<T>(url: string, accessToken: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GMAIL_API_${response.status}:${text.slice(0, 500)}`);
  }
  return response.json() as Promise<T>;
}

export async function refreshGoogleAccessToken(credentials: GoogleOAuthCredentials): Promise<string> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GOOGLE_OAUTH_REFRESH_${response.status}:${text.slice(0, 500)}`);
  }

  const payload = (await response.json()) as { access_token?: string };
  if (!payload.access_token) throw new Error('GOOGLE_OAUTH_ACCESS_TOKEN_MISSING');
  return payload.access_token;
}

export async function listLifecycleMessageIds(
  accessToken: string,
  window: SyncWindow,
): Promise<Array<{ id: string; threadId?: string }>> {
  const query = buildLifecycleQueryForWindow(window);
  const results: Array<{ id: string; threadId?: string }> = [];
  let pageToken: string | undefined;

  do {
    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    url.searchParams.set('q', query);
    url.searchParams.set('maxResults', '500');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const payload = await googleFetch<GmailListResponse>(url.toString(), accessToken);
    results.push(...(payload.messages ?? []));
    pageToken = payload.nextPageToken;
  } while (pageToken);

  return results;
}

export async function getLifecycleMessage(accessToken: string, id: string): Promise<GmailLifecycleMessage> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`;
  const message = await googleFetch<GmailMessageResponse>(url, accessToken);
  const plain: string[] = [];
  const html: string[] = [];
  collectBodies(message.payload, plain, html);

  const subject = headerValue(message.payload?.headers, 'Subject');
  if (!subject) throw new Error(`GMAIL_SUBJECT_MISSING:${id}`);

  const body = plain.join('\n').trim() || stripHtml(html.join('\n')).trim();
  if (!body) throw new Error(`GMAIL_BODY_MISSING:${id}`);

  const receivedAt = message.internalDate
    ? new Date(Number(message.internalDate)).toISOString()
    : new Date().toISOString();

  return {
    id: message.id,
    threadId: message.threadId,
    subject,
    body,
    receivedAt,
  };
}
