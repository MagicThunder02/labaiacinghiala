import {
  isRelativeApiPath,
  parseApiError,
  type ApiTransportRequest,
} from '../../shared/api-contracts.js';
import { coreApiRequest, isTauriRuntime } from './tauri-bridge';

const ALLOWED_METHODS = new Set<ApiTransportRequest['method']>([
  'GET', 'HEAD', 'POST', 'PUT', 'DELETE',
]);
const ALLOWED_HEADERS = new Set(['accept', 'content-type']);

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code = '') {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
  }
}

function normalizeMethod(method?: string): ApiTransportRequest['method'] {
  const normalized = (method || 'GET').toUpperCase() as ApiTransportRequest['method'];
  if (!ALLOWED_METHODS.has(normalized)) throw new TypeError('Metodo API non consentito.');
  return normalized;
}

function normalizeHeaders(headers?: HeadersInit): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of new Headers(headers).entries()) {
    const lower = name.toLowerCase();
    if (lower.startsWith('x-baia-') || !ALLOWED_HEADERS.has(lower)) {
      throw new TypeError(`Header API non consentito: ${name}.`);
    }
    normalized[lower] = value;
  }
  return normalized;
}

async function parseJsonBody<T>(body: string, status: number): Promise<T> {
  if (!body) return null as T;
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new ApiClientError('Risposta JSON del server non valida.', status);
  }
}

export async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!isRelativeApiPath(path)) throw new TypeError('Il client accetta soltanto path relativi /api/.');
  const method = normalizeMethod(init.method);
  if (init.body != null && typeof init.body !== 'string') {
    throw new TypeError('Il body API deve essere una stringa JSON.');
  }

  if (isTauriRuntime()) {
    const response = await coreApiRequest({
      path,
      method,
      headers: normalizeHeaders(init.headers),
      body: typeof init.body === 'string' ? init.body : null,
    });
    const payload = await parseJsonBody<T>(response.body, response.status);
    if (!response.ok) {
      const error = parseApiError(payload);
      throw new ApiClientError(error?.error || `Errore HTTP ${response.status}`, response.status, error?.code);
    }
    return payload;
  }

  const response = await fetch(path, { ...init, method });
  const body = await response.text();
  const payload = await parseJsonBody<T>(body, response.status);
  if (!response.ok) {
    const error = parseApiError(payload);
    throw new ApiClientError(error?.error || `Errore HTTP ${response.status}`, response.status, error?.code);
  }
  return payload;
}
