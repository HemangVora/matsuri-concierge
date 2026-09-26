import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORE_VERSION } from '../src/index.ts';

test('core loads', () => {
  assert.equal(CORE_VERSION, '0.1.0');
});
