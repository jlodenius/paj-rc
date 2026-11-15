import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTokens, sessionInfo } from '../public/session-info.js';

test('context counts use compact lowercase numbers without inventing unknown usage', () => {
  for (const [input, output] of [[0, '0'], [999, '999'], [1500, '1.5k'], [200000, '200k'],
    [500000, '500k'], [999999, '1m'], [1100000, '1.1m']]) assert.equal(formatTokens(input), output);
  for (const value of [null, undefined, NaN, Infinity, -1, 1.5, '500000']) assert.equal(formatTokens(value), '—');
});

test('model and estimated context readouts preserve exact values in titles', () => {
  const info = sessionInfo({ model: { id: 'gpt-6.1-sol', provider: 'openai-codex', name: 'GPT 6.1 Sol' },
    context: { tokens: 200000, contextWindow: 500000 } });
  assert.equal(info.modelText, 'gpt-6.1-sol');
  assert.equal(info.modelTitle, 'GPT 6.1 Sol · openai-codex/gpt-6.1-sol');
  assert.equal(info.contextText, 'context: 200k/500k');
  assert.equal(info.contextTitle, 'Estimated context: 200,000 / 500,000 tokens');
});

test('zero, unknown-after-compaction, and overflow counts remain distinct', () => {
  assert.equal(sessionInfo({ context: { tokens: 0, contextWindow: 500000 } }).contextText, 'context: 0/500k');
  assert.equal(sessionInfo({ context: { tokens: null, contextWindow: 500000 } }).contextText, 'context: —/500k');
  assert.equal(sessionInfo({ context: { tokens: 600000, contextWindow: 500000 } }).contextText, 'context: 600k/500k');
  for (const context of [undefined, null, {}, { tokens: 10, contextWindow: 0 }]) {
    assert.equal(sessionInfo({ context }).contextText, 'context: —');
  }
});

test('legacy model fallback is separate from an explicitly unavailable current model', () => {
  assert.equal(sessionInfo({}, 'openai-codex/gpt-6.1-sol').modelText, 'openai-codex/gpt-6.1-sol');
  assert.equal(sessionInfo({ model: null }, 'stale model').modelText, 'Model unavailable');
  assert.equal(sessionInfo().modelText, 'Model unavailable');
});
