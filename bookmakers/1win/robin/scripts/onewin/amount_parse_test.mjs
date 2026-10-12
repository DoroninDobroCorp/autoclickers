import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAmount } from './browser_cart.mjs';

test('reads the actual English coupon thousands format without changing stake', () => {
  assert.equal(parseAmount('USDT\u00a09,999.00'), 9999);
  assert.equal(parseAmount('USDT 1,234,567.89'), 1234567.89);
  assert.equal(parseAmount('9,999'), 9999);
});

test('retains exact odds and bounded coupon amounts', () => {
  assert.equal(parseAmount('1.87'), 1.87);
  assert.equal(parseAmount('USDT 1.00'), 1);
  assert.equal(parseAmount('1,87'), 1.87);
  assert.equal(parseAmount('0'), 0);
});

test('does not turn blank, labels or malformed numbers into a stake', () => {
  for (const text of ['', 'MAX', 'USDT', 'USDT 1,23,4.00', '1.2.3', '1abc2', '1e3']) {
    assert.equal(parseAmount(text), null, text);
  }
});
