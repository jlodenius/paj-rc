export function createTranscript() {
  return { generation: null, seq: 0, state: {}, messages: [], hasMore: false, before: null };
}

export function applySnapshot(snapshot) {
  return {
    generation: snapshot.generation,
    seq: snapshot.seq,
    state: { ...snapshot.state },
    messages: snapshot.messages.map(message => ({ ...message })),
    hasMore: snapshot.hasMore,
    before: snapshot.before,
  };
}

export function applyEvent(transcript, envelope) {
  if (envelope.generation !== transcript.generation) return 'resync';
  if (envelope.seq <= transcript.seq) return 'duplicate';
  if (envelope.seq !== transcript.seq + 1) return 'resync';
  const event = envelope.event;
  if (event.type === 'reset') return 'resync';
  if (event.type === 'state') transcript.state = { ...event.state };
  else if (event.type === 'message') {
    const index = transcript.messages.findIndex(message => message.id === event.message.id);
    if (index < 0) transcript.messages.push({ ...event.message });
    else transcript.messages[index] = { ...event.message };
  } else if (event.type === 'delta') {
    let message = transcript.messages.find(message => message.id === event.messageId);
    if (!message) {
      message = { id: event.messageId, role: 'assistant', text: '' };
      transcript.messages.push(message);
    }
    message.text += event.text;
  } else return 'resync';
  transcript.seq = envelope.seq;
  return 'applied';
}

export function prependHistory(transcript, page) {
  if (page.generation !== transcript.generation) return false;
  const ids = new Set(transcript.messages.map(message => message.id));
  transcript.messages.unshift(...page.messages.filter(message => !ids.has(message.id)));
  transcript.before = page.before;
  transcript.hasMore = page.hasMore;
  return true;
}
