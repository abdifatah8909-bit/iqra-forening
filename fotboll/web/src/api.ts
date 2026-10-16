/** Thin fetch wrapper. The token is set by the session module. */

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

let token: string | null = null;
let onUnauthorized: () => void = () => {};

export function setToken(next: string | null) {
  token = next;
}

export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.json);
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { ...init, headers, body });
  } catch {
    throw new ApiError(0, 'network');
  }
  if (res.status === 401 && token) onUnauthorized();
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error ?? 'unknown');
  }
  const type = res.headers.get('content-type') ?? '';
  return (type.includes('application/json') ? res.json() : res.blob()) as Promise<T>;
}
