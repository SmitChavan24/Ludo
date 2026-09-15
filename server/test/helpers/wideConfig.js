import { config } from '../../src/config.js';

// Production ships a deliberately NARROW lobby (one stake, one table size) so the
// matchmaking pool stays concentrated. The tests need to exercise several stakes
// and 2/3/4-player tables, so widen the allow-list for the test run.
// Importing this module applies the change before any test body executes.
config.economy.stakes = [10, 50, 100, 250, 500];
config.economy.playerCounts = [2, 3, 4];
