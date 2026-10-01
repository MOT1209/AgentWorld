const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:4000/api/v1";

export function getToken(): string | null {
  return sessionStorage.getItem("kw.token");
}

export function setToken(token: string | null): void {
  if (token === null) sessionStorage.removeItem("kw.token");
  else sessionStorage.setItem("kw.token", token);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token !== null ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as T & { code?: string; message?: string };
  if (!res.ok) throw new Error((body as { message?: string }).message ?? `Request failed (${res.status})`);
  return body as T;
}

export const api = {
  login: (email: string, password: string): Promise<{ token: string }> =>
    request<{ token: string }>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  me: (): Promise<unknown> => request("/auth/me"),
  get: <T>(path: string): Promise<{ data: T }> => request<{ data: T }>(path),
  post: <T>(path: string, body?: unknown): Promise<{ data: T }> =>
    request<{ data: T }>(path, { method: "POST", body: JSON.stringify(body ?? {}) }),
};
