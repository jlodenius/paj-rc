import test from 'node:test';
import assert from 'node:assert/strict';
import { commandSuggestions, insertCommand } from '../dist/public/commands.js';
import { applySnapshot, createTranscript } from '../dist/public/state.js';

const commands = [
  { name: 'review', description: 'Review changes', source: 'prompt' },
  { name: 'skill:research', description: 'Investigate', source: 'skill' },
  { name: 'reload', description: 'Terminal only', source: 'extension' },
];

test('slash completion filters loaded skills and templates, not terminal commands', () => {
  assert.deepEqual(commandSuggestions(commands, '/', 1), commands.slice(0, 2));
  assert.deepEqual(commandSuggestions(commands, '/RE', 3), commands.slice(0, 2));
  assert.deepEqual(commandSuggestions(commands, '/skill:re', 9), [commands[1]]);
  assert.deepEqual(commandSuggestions(commands, '/unknown', 8), []);
});

test('completion only edits an initial slash token under an unselected caret', () => {
  for (const [text, start, end] of [['hello /re', 9, 9], ['/re arguments', 8, 8], ['/re', 0, 0], ['/re', 1, 3]]) {
    assert.deepEqual(commandSuggestions(commands, text, start, end), []);
  }
  assert.deepEqual(commandSuggestions(undefined, '/', 1), []);
  assert.deepEqual(commandSuggestions(commands, '/review args', 3), commands.slice(0, 2));
});

test('inserting a command preserves arguments without submitting or expanding locally', () => {
  assert.deepEqual(insertCommand('/re', 'skill:research'), { text: '/skill:research ', cursor: 16 });
  assert.deepEqual(insertCommand('/re "API safety"', 'review'), { text: '/review "API safety"', cursor: 8 });
  assert.deepEqual(insertCommand('/re\nNext line', 'review'), { text: '/review\nNext line', cursor: 7 });
  assert.equal(insertCommand('ordinary text', 'review'), null);
});

test('command catalog is scoped to each snapshot and older adapters have no suggestions', () => {
  const base = { generation: 'first', seq: 0, state: {}, messages: [] };
  assert.deepEqual(createTranscript().commands, []);
  const transcript = applySnapshot({ ...base, commands });
  assert.deepEqual(transcript.commands, commands);
  assert.notEqual(transcript.commands[0], commands[0]);
  assert.deepEqual(applySnapshot({ ...base, generation: 'second' }).commands, []);
});
