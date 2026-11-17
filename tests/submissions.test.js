import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubmissionFeedback, steeringLabel } from '../dist/public/submissions.js';
import { projectMessage } from '../dist/src/session.js';

const begin = (feedback, id = 'request', scope = 'session:generation') => feedback.begin(scope,
  { requestId: id, text: 'Change direction', seq: 10 });
const message = (id = 'native', seq = 11) => ({ seq,
  event: { type: 'message', message: { id, role: 'user', text: 'Change direction' } } });
const scope = 'session:generation';

test('steering feedback appears immediately and differentiates submitted from execution', () => {
  const feedback = createSubmissionFeedback();
  begin(feedback);
  assert.equal(steeringLabel(feedback.messages(scope, [])[0]), 'Steering · submitting…');
  feedback.update(scope, 'request', 'submitted');
  const rows = feedback.messages(scope, []);
  assert.equal(rows[0].text, 'Change direction');
  assert.equal(steeringLabel(rows[0]), 'Steering · submitted');
  assert.equal(rows[0].steering, true);
});

test('a new matching live user message replaces the visual receipt without mutating history', () => {
  const feedback = createSubmissionFeedback();
  begin(feedback);
  feedback.update(scope, 'request', 'submitted');
  const event = message();
  feedback.observe(scope, event);
  const native = event.event.message;
  const rows = feedback.messages(scope, [native]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'native');
  assert.equal(steeringLabel(rows[0]), 'Steering');
  assert.equal(native.steering, undefined);
  assert.equal(feedback.messages(scope, [{ ...native, id: 'persisted-id' }]).length, 1);
});

test('long and escaped steering text reconciles using the actual bounded native projection', () => {
  for (const text of ['x'.repeat(9000), '🍉'.repeat(4500), '\n"\\'.repeat(4000)]) {
    const feedback = createSubmissionFeedback();
    feedback.begin(scope, { requestId: 'request', text, seq: 10 });
    feedback.update(scope, 'request', 'submitted');
    assert.equal(feedback.messages(scope, [])[0].text, text);
    const native = projectMessage({ role: 'user', content: text }, 'native');
    feedback.observe(scope, { seq: 11, event: { type: 'message', message: native } });
    const rows = feedback.messages(scope, [native]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].observed, true);
  }
});

test('photo-only steering ignores whitespace omitted by the input adapter', () => {
  const feedback = createSubmissionFeedback();
  feedback.begin(scope, { requestId: 'photo', text: '  ', imageCount: 1, seq: 10 });
  feedback.update(scope, 'photo', 'submitted');
  const native = projectMessage({ role: 'user', content: [{ type: 'image' }] }, 'native');
  feedback.observe(scope, { seq: 11, event: { type: 'message', message: native } });
  assert.equal(feedback.messages(scope, [native]).length, 1);
});

test('identical repeated steers reconcile one-to-one and duplicate events cannot consume another receipt', () => {
  const feedback = createSubmissionFeedback();
  begin(feedback, 'first');
  begin(feedback, 'second');
  feedback.update(scope, 'first', 'submitted');
  feedback.update(scope, 'second', 'submitted');
  feedback.observe(scope, message('native-one'));
  feedback.observe(scope, message('native-one'));
  let rows = feedback.messages(scope, [message('native-one').event.message]);
  assert.equal(rows.length, 2);
  assert.equal(rows.filter(row => row.id.startsWith('submission:')).length, 1);
  feedback.observe(scope, message('native-two', 12));
  rows = feedback.messages(scope, [message('native-one').event.message, message('native-two').event.message]);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.observed));
});

test('uncertain delivery is never silently confirmed or retried by feedback matching', () => {
  const feedback = createSubmissionFeedback();
  begin(feedback);
  feedback.update(scope, 'request', 'unknown');
  const event = message();
  feedback.observe(scope, event);
  const rows = feedback.messages(scope, [event.event.message]);
  assert.equal(rows.length, 1);
  assert.equal(steeringLabel(rows[0]), 'Steering · delivery unconfirmed');
  assert.equal(rows[0].submissionStatus, 'unknown');
});

test('stale history, other sessions and generations, wrong roles and images cannot absorb a receipt', () => {
  const feedback = createSubmissionFeedback();
  begin(feedback);
  feedback.observe(scope, message('old', 9));
  feedback.observe('other:generation', message());
  feedback.observe('session:other-generation', message());
  feedback.observe(scope, { seq: 11, event: { type: 'message', message: { ...message().event.message, id: 'assistant', role: 'assistant' } } });
  feedback.observe(scope, { seq: 12, event: { type: 'message', message: { ...message().event.message, id: 'photo', imageCount: 1 } } });
  assert.equal(feedback.messages(scope, [])[0].id, 'submission:request');
  assert.deepEqual(feedback.messages('other:generation', []), []);
  feedback.update(scope, 'request', 'rejected');
  feedback.observe(scope, message('later', 13));
  assert.equal(steeringLabel(feedback.messages(scope, [])[0]), 'Steering · not submitted');
});

test('feedback is bounded and logout can remove all private in-memory receipts', () => {
  const feedback = createSubmissionFeedback(2);
  for (const id of ['one', 'two', 'three']) begin(feedback, id);
  assert.deepEqual(feedback.messages(scope, []).map(row => row.id), ['submission:two', 'submission:three']);
  feedback.clear();
  assert.deepEqual(feedback.messages(scope, []), []);
  for (const limit of [0, -1, 1.5, NaN]) assert.throws(() => createSubmissionFeedback(limit), RangeError);
});
