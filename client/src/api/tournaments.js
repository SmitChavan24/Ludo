import { apiFetch } from './http.js';
import { useAuth } from '../store/auth.js';

const token = () => useAuth.getState().accessToken;

export const tournamentApi = {
  list: (status = 'open') => apiFetch(`/tournaments?status=${status}`, { token: token() }),
  mine: () => apiFetch('/tournaments/mine', { token: token() }),
  detail: (id) => apiFetch(`/tournaments/${id}`, { token: token() }),
  payment: (id) => apiFetch(`/tournaments/${id}/payment`, { token: token() }),
  join: (id) => apiFetch(`/tournaments/${id}/join`, { method: 'POST', token: token() }),
  claim: (id, body) => apiFetch(`/tournaments/${id}/claim`, { method: 'POST', token: token(), body }),
  withdraw: (id) => apiFetch(`/tournaments/${id}/withdraw`, { method: 'POST', token: token() }),
};
