import { apiFetch } from './http.js';
import { useAuth } from '../store/auth.js';

const token = () => useAuth.getState().accessToken;

export function fetchMyGames(limit = 30) {
  return apiFetch(`/me/games?limit=${limit}`, { token: token() });
}

export function fetchLeaderboard(period = 'all', limit = 50) {
  return apiFetch(`/leaderboard?period=${period}&limit=${limit}`, { token: token() });
}
