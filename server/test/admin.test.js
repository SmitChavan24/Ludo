import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signAdminToken, verifyAdminToken, signAccessToken } from '../src/auth/jwt.js';
import { safeEqual } from '../src/util/safeEqual.js';

test('safeEqual is correct for equal/unequal/empty inputs', () => {
  assert.equal(safeEqual('secret', 'secret'), true);
  assert.equal(safeEqual('secret', 'Secret'), false);
  assert.equal(safeEqual('a', 'abc'), false); // different lengths, no crash
  assert.equal(safeEqual('', ''), true);
  assert.equal(safeEqual(undefined, 'x'), false);
});

test('admin token round-trips and carries the admin scope', () => {
  const token = signAdminToken('admin');
  const payload = verifyAdminToken(token);
  assert.equal(payload.scope, 'admin');
  assert.equal(payload.sub, 'admin:admin');
});

test('a normal player token can NOT be used as an admin token', () => {
  const playerToken = signAccessToken({ id: 'u1', name: 'Player', picture: null });
  assert.throws(() => verifyAdminToken(playerToken), /Not an admin token/);
});

test('a tampered admin token is rejected', () => {
  const token = signAdminToken('admin');
  assert.throws(() => verifyAdminToken(token.slice(0, -3) + 'xxx'));
});
