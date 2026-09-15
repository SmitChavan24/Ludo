import { create } from 'zustand';
import { apiFetch } from '../api/http.js';

// Server-driven lobby options. The server decides which stakes / table sizes are
// open (keeping the matchmaking pool concentrated), so the UI must ask rather
// than hardcode. Falls back to a safe single-pool default if the call fails.
export const useAppConfig = create((set) => ({
  stakes: [50],
  playerCounts: [2],
  rakeBips: 500,
  dailyBonus: 100,
  referralBonus: 500,
  googleEnabled: false,
  practiceEnabled: true,
  pushRequiredForPractice: false,
  pushRequiredForTournaments: false,
  practiceBotWaitMs: 20000,
  loaded: false,

  async load() {
    try {
      const c = await apiFetch('/config');
      set({
        stakes: c.stakes?.length ? c.stakes : [50],
        playerCounts: c.playerCounts?.length ? c.playerCounts : [2],
        rakeBips: c.rakeBips ?? 500,
        dailyBonus: c.dailyBonus ?? 100,
        referralBonus: c.referralBonus ?? 500,
        googleEnabled: !!c.googleEnabled,
        practiceEnabled: c.practiceEnabled !== false,
        pushRequiredForPractice: !!c.pushRequiredForPractice,
        pushRequiredForTournaments: !!c.pushRequiredForTournaments,
        practiceBotWaitMs: c.practiceBotWaitMs ?? 20000,
        loaded: true,
      });
    } catch {
      set({ loaded: true }); // keep defaults
    }
  },
}));
