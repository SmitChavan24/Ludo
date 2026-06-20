import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { apiFetch } from '../api/http.js';

// Holds the signed-in user + tokens, persisted to localStorage so a refresh
// keeps you logged in. Tokens are short-lived; `bootstrap` silently refreshes.
export const useAuth = create(
  persist(
    (set, get) => ({
      user: null,
      accessToken: null,
      refreshToken: null,

      async loginDev(name) {
        const data = await apiFetch('/auth/dev', { method: 'POST', body: { name } });
        set({ user: data.user, accessToken: data.accessToken, refreshToken: data.refreshToken });
        return data;
      },

      async loginGoogle(idToken) {
        const data = await apiFetch('/auth/google', { method: 'POST', body: { idToken } });
        set({ user: data.user, accessToken: data.accessToken, refreshToken: data.refreshToken });
        return data;
      },

      async refresh() {
        const refreshToken = get().refreshToken;
        if (!refreshToken) throw new Error('No refresh token');
        const data = await apiFetch('/auth/refresh', { method: 'POST', body: { refreshToken } });
        set({ accessToken: data.accessToken, refreshToken: data.refreshToken });
        return data.accessToken;
      },

      // On app start: validate the session, refreshing once if the access token
      // has expired. Logs out only if both fail.
      async bootstrap() {
        const token = get().accessToken;
        if (!token) return;
        try {
          const data = await apiFetch('/me', { token });
          set({ user: data.user });
        } catch {
          try {
            const fresh = await get().refresh();
            const data = await apiFetch('/me', { token: fresh });
            set({ user: data.user });
          } catch {
            get().logout();
          }
        }
      },

      setCoins(coins) {
        set((s) => (s.user ? { user: { ...s.user, coins } } : s));
      },

      async claimDailyBonus() {
        const data = await apiFetch('/me/daily-bonus', { method: 'POST', token: get().accessToken });
        if (data.granted) get().setCoins(data.balance);
        return data;
      },

      logout() {
        const refreshToken = get().refreshToken;
        if (refreshToken) {
          apiFetch('/auth/logout', { method: 'POST', body: { refreshToken } }).catch(() => {});
        }
        set({ user: null, accessToken: null, refreshToken: null });
      },
    }),
    { name: 'coinludo-auth' },
  ),
);
