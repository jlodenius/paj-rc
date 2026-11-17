import test from 'node:test';
import assert from 'node:assert/strict';
import { compactProjectPath } from '../dist/public/paths.js';

const within = width => text => [...text].length <= width;

test('project paths remain complete when they fit', () => {
  assert.equal(compactProjectPath('/home/developer/Development/paj', within(100)), '/home/developer/Development/paj');
});

test('project paths retain the largest suffix of whole directories', () => {
  assert.equal(compactProjectPath('/home/developer/Development/paj', within(22)), '../Development/paj');
  assert.equal(compactProjectPath('/home/developer/Development/paj', within(10)), '../paj');
});

test('the current directory is never cut even when no candidate fits', () => {
  assert.equal(compactProjectPath('/home/an-extremely-long-directory', within(3)), '../an-extremely-long-directory');
  assert.equal(compactProjectPath('/one-directory', within(3)), '/one-directory');
});

test('relative, Unicode, root and trailing-slash paths preserve whole names', () => {
  assert.equal(compactProjectPath('work/日本語/paj/', within(12)), '../日本語/paj');
  assert.equal(compactProjectPath('/', within(0)), '/');
  assert.equal(compactProjectPath('', within(0)), '');
});
