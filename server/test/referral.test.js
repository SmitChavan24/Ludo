import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/db/MemoryStore.js';
import { newReferralCode, normalizeReferralCode } from '../src/util/referral.js';

test('referral codes avoid look-alike characters', () => {
  for (let i = 0; i < 200; i++) {
    const code = newReferralCode();
    assert.equal(code.length, 6);
    assert.match(code, /^[A-Z2-9]+$/);
    // 0/O and 1/I/L are excluded so codes survive being retyped from a chat.
    assert.ok(!/[01ILO]/.test(code), `ambiguous char in ${code}`);
  }
});

test('normalizeReferralCode handles casing, spaces and pasted links', () => {
  assert.equal(normalizeReferralCode('  abc123 '), 'ABC123');
  assert.equal(normalizeReferralCode('https://coinludo.app/?ref=xy9z8w'), 'XY9Z8W');
  assert.equal(normalizeReferralCode('https://x.dev/?a=1&ref=Ab2Cd3'), 'AB2CD3');
  assert.equal(normalizeReferralCode(''), '');
  assert.equal(normalizeReferralCode(null), '');
});

test('every new user gets a unique referral code, findable by code', async () => {
  const store = new MemoryStore();
  const a = await store.createUser({ provider: 'dev', providerId: 'r-a', name: 'A' });
  const b = await store.createUser({ provider: 'dev', providerId: 'r-b', name: 'B' });

  assert.ok(a.referralCode && b.referralCode);
  assert.notEqual(a.referralCode, b.referralCode);
  assert.equal((await store.findUserByReferralCode(a.referralCode)).id, a.id);
  // Lookup is case-insensitive, as users will retype it however they like.
  assert.equal((await store.findUserByReferralCode(a.referralCode.toLowerCase())).id, a.id);
  assert.equal(await store.findUserByReferralCode('NOSUCH'), null);
});

test('referral counts track who invited whom', async () => {
  const store = new MemoryStore();
  const host = await store.createUser({ provider: 'dev', providerId: 'r-host', name: 'Host' });
  const g1 = await store.createUser({ provider: 'dev', providerId: 'r-g1', name: 'G1' });
  const g2 = await store.createUser({ provider: 'dev', providerId: 'r-g2', name: 'G2' });

  assert.equal(await store.countReferrals(host.id), 0);
  await store.setReferredBy(g1.id, host.id);
  await store.setReferredBy(g2.id, host.id);
  assert.equal(await store.countReferrals(host.id), 2);
  assert.equal(await store.countReferrals(g1.id), 0);
});
