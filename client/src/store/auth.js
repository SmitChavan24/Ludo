import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { apiFetch } from '../api/http.js';

const REF_KEY = 'coinludo-ref';
const GUEST_KEY = 'coinludo-guest';

// Guest sessions live outside the main auth store so that returning to the
// login screen doesn't destroy them (and with them, the push subscription).
function writeGuestSession(data) {
  try {
    localStorage.setItem(GUEST_KEY, JSON.stringify({ user: data.user, accessToken: data.accessToken }));
  } catch {
    /* ignore */
  }
}

function readGuestSession() {
  try {
    const raw = localStorage.getItem(GUEST_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s?.accessToken) return null;
    // Drop it once expired, with a minute of headroom.
    const { exp } = JSON.parse(atob(s.accessToken.split('.')[1] || '')) || {};
    if (!exp || exp * 1000 < Date.now() + 60_000) {
      localStorage.removeItem(GUEST_KEY);
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

export function clearGuestSession() {
  try {
    localStorage.removeItem(GUEST_KEY);
  } catch {
    /* ignore */
  }
}

// A visitor arriving from an invite link (…/?ref=ABC123) may not sign up on that
// first visit, so remember the code until they do. Cleared once it pays out.
export function capturePendingReferral() {
  try {
    const code = new URLSearchParams(window.location.search).get('ref');
    if (code) {
      localStorage.setItem(REF_KEY, code.toUpperCase().slice(0, 12));
      // Tidy the URL so a refresh (or a screenshot) doesn't keep the code around.
      window.history.replaceState({}, '', window.location.pathname);
    }
  } catch {
    /* ignore */
  }
}

function takePendingReferral() {
  try {
    return localStorage.getItem(REF_KEY) || undefined;
  } catch {
    return undefined;
  }
}

function clearPendingReferral() {
  try {
    localStorage.removeItem(REF_KEY);
  } catch {
    /* ignore */
  }
}

// Holds the signed-in user + tokens, persisted to localStorage so a refresh
// keeps you logged in. Tokens are short-lived; `bootstrap` silently refreshes.
export const useAuth = create(
  persist(
    (set, get) => ({
      user: null,
      accessToken: null,
      refreshToken: null,

      async loginDev(name) {
        const data = await apiFetch('/auth/dev', { method: 'POST', body: { name, referralCode: takePendingReferral() } });
        set({ user: data.user, accessToken: data.accessToken, refreshToken: data.refreshToken });
        if (data.referral) clearPendingReferral();
        return data;
      },

      // Anonymous practice session: no account, no name, no coins.
      // A guest token is REUSED while it is still valid. Minting a fresh guest
      // on every visit would burn rate limits and — worse — orphan the push
      // subscription, which is stored against the guest's id.
      async loginGuest() {
        const cached = readGuestSession();
        if (cached) {
          set({ user: cached.user, accessToken: cached.accessToken, refreshToken: null });
          return cached;
        }
        const data = await apiFetch('/auth/guest', { method: 'POST' });
        set({ user: data.user, accessToken: data.accessToken, refreshToken: null });
        writeGuestSession(data);
        return data;
      },

      async loginGoogle(idToken) {
        const data = await apiFetch('/auth/google', { method: 'POST', body: { idToken, referralCode: takePendingReferral() } });
        clearGuestSession();
        set({ user: data.user, accessToken: data.accessToken, refreshToken: data.refreshToken });
        if (data.referral) clearPendingReferral();
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
