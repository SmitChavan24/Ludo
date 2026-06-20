import { API_BASE } from '../config.js';

// Thin fetch wrapper: JSON in/out, attaches the bearer token, throws a clean
// Error (with the server's message) on non-2xx so callers can show it.
export async function apiFetch(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(API_BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
