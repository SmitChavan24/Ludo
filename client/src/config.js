// Where the backend lives. Override with VITE_SERVER_URL in a .env for prod.
export const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:4000';
export const API_BASE = `${SERVER_URL}/api`;

// Optional Google OAuth client id (same value as the server's GOOGLE_CLIENT_ID).
export const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';

// Stake presets shown in the lobby.
export const STAKES = [50, 100, 250, 500];
