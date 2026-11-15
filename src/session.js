import { randomUUID } from 'node:crypto';
import { validateImages, hashImages } from './images.js';
import { boundedMessageText as boundedText, MESSAGE_TEXT_LIMIT as TEXT_LIMIT } from '../public/text.js';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

export function isEligible(ctx, snapshot, { env = process.env, pid = process.pid } = {}) {
  const identity = snapshot?.identity;
  return ctx?.mode === 'tui' && ctx.hasUI === true && identity?.role === 'primary' &&
    identity.pid === pid && identity.piSessionId === ctx.sessionManager.getSessionId() &&
    typeof identity.id === 'string' && Boolean(identity.id) &&
    !identity.parentPiSessionId && !identity.spawnId && !identity.parentTaskId &&
    !identity.taskId && !identity.child && !identity.parentSessionId && !identity.childTaskId &&
    !env.PAJ_PARENT_PI_SESSION_ID &&
    !env.PAJ_SPAWN_ID && !env.PAJ_TASK_ID && !env.PAJ_PARENT_TASK_ID &&
    (!env.PAJ_ROLE || env.PAJ_ROLE === 'primary');
}

function textContent(content) {
  if (typeof content === 'string') return boundedText(content);
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') {
      text += part.text.slice(0, TEXT_LIMIT - text.length);
      if (text.length >= TEXT_LIMIT) break;
    }
  }
  return boundedText(text);
}

export function projectMessage(message, id) {
  if (!message || (!['user', 'assistant', 'toolResult'].includes(message.role) &&
      !(message.role === 'custom' && message.display === true))) return null;
  const role = message.role === 'toolResult' ? 'tool'
    : message.role === 'custom' ? 'assistant' : message.role;
  const imageCount = message.role === 'user' && Array.isArray(message.content)
    ? Math.min(3, message.content.filter(part => part?.type === 'image').length) : 0;
  const text = role === 'tool'
    ? `${String(message.toolName ?? 'Tool').slice(0, 100)}: ${message.isError ? 'failed' : 'completed'}`
    : textContent(message.content) || (imageCount === 1 ? '[Image attached]'
      : imageCount ? `[${imageCount} images attached]` : '');
  return text ? { id, role, text,
    ...(imageCount ? { imageCount } : {}),
    ...(message.role === 'custom' && message.customType === 'paj-messages'
      ? { customType: 'paj-messages' } : {}) } : null;
}

function modelMetadata(model) {
  const result = {};
  for (const key of ['id', 'provider', 'name']) {
    const value = model?.[key];
    if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) return null;
    result[key] = value.slice(0, 200);
  }
  return result;
}

function contextMetadata(ctx) {
  try {
    const usage = ctx.getContextUsage?.();
    if (!Number.isSafeInteger(usage?.contextWindow) || usage.contextWindow <= 0) return null;
    return { tokens: Number.isSafeInteger(usage.tokens) && usage.tokens >= 0 ? usage.tokens : null,
      contextWindow: usage.contextWindow };
  } catch {
    return null;
  }
}

export function createSessionAdapter({ pi, ctx, paj, env = process.env, pid = process.pid,
  uuid = randomUUID, dedupLimit = 512 }) {
  const sessionId = ctx.sessionManager.getSessionId();
  const identity = paj.getSnapshot().identity;
  const generation = uuid();
  const listeners = new Set();
  const dedup = new Map();
  const leases = new Set();
  const unsubscribers = [];
  let closed = false;
  let modelCtx = ctx;
  let seq = 0;
  let runId = ctx.isIdle() ? null : uuid();
  let leaseRunId = null;
  let terminalDepth = 0;
  let partial = null;
  let finalized = [];
  let reconcileImmediate;
  let metadataImmediate;
  let reconcileTimer;
  let reconcileDelay = 25;

  const eligible = () => !closed && paj.version === 1 &&
    isEligible(ctx, paj.getSnapshot(), { env, pid }) &&
    paj.getSnapshot().identity?.id === identity?.id;
  const assertEligible = () => {
    if (!eligible()) fail('unavailable', 'Session is not an eligible live main TUI');
  };
  const state = () => ({ busy: !ctx.isIdle() || leases.size > 0,
    runId, editorBusy: Boolean(paj.getSnapshot().editorBusy),
    terminalRequired: terminalDepth > 0,
    supportsImages: Array.isArray(modelCtx.model?.input) && modelCtx.model.input.includes('image'),
    model: modelMetadata(modelCtx.model), context: contextMetadata(modelCtx) });
  const emit = (event) => {
    if (!eligible()) return;
    const frame = { type: 'event', seq: ++seq, event };
    for (const listener of listeners) {
      try { listener(frame); } catch { /* Transport errors cannot break the Pi event path. */ }
    }
  };
  const refreshState = () => emit({ type: 'state', state: state() });
  const deferState = () => {
    if (metadataImmediate) return;
    const previous = JSON.stringify(state());
    metadataImmediate = setImmediate(() => {
      metadataImmediate = undefined;
      if (eligible() && JSON.stringify(state()) !== previous) refreshState();
    });
    metadataImmediate.unref?.();
  };
  const entryMessage = (entry) => entry.type === 'message' ? entry.message
    : entry.type === 'custom_message' ? { ...entry, role: 'custom' } : null;
  // Later async message_end handlers can postpone persistence beyond any event-loop boundary.
  const reconcileFinalized = (branch = ctx.sessionManager.getBranch()) => {
    const used = new Set();
    const previousLength = finalized.length;
    finalized = finalized.filter((overlay, overlayIndex) => {
      const anchor = overlay.after == null ? -1 : branch.findIndex(entry => entry.id === overlay.after);
      if (overlay.after != null && anchor < 0) return true;
      for (let index = anchor + 1; index < branch.length; index++) {
        const entry = branch[index];
        if (used.has(entry.id)) continue;
        const value = entryMessage(entry);
        if (!value || value.role !== overlay.role) continue;
        const sameIdentity = value === overlay.source.deref() ||
          (overlay.role !== 'custom' && overlay.timestamp != null &&
            value.timestamp === overlay.timestamp && value.toolCallId === overlay.toolCallId);
        const projected = sameIdentity ? null : projectMessage(value, entry.id);
        const customMatch = overlay.role === 'custom' && value.customType === overlay.customType;
        if (!sameIdentity && ((!customMatch && overlay.timestamp != null) ||
            projected?.role !== overlay.message.role || projected?.text !== overlay.message.text)) continue;
        used.add(entry.id);
        for (let next = overlayIndex + 1; next < finalized.length; next++) {
          const later = finalized[next];
          const laterAnchor = later.after == null ? -1
            : branch.findIndex(value => value.id === later.after);
          if (laterAnchor < index) later.after = entry.id;
        }
        return false;
      }
      return true;
    });
    return finalized.length !== previousLength;
  };
  const cancelReconciliation = () => {
    clearImmediate(reconcileImmediate);
    clearTimeout(reconcileTimer);
    reconcileImmediate = undefined;
    reconcileTimer = undefined;
  };
  const observePersistence = () => {
    reconcileImmediate = undefined;
    reconcileTimer = undefined;
    if (!eligible()) return;
    if (reconcileFinalized()) {
      refreshState();
      emit({ type: 'reset' });
    }
    if (!finalized.length) return;
    reconcileTimer = setTimeout(observePersistence, reconcileDelay);
    reconcileTimer.unref?.();
    reconcileDelay = Math.min(1000, reconcileDelay * 2);
  };
  const releaseLeases = () => {
    for (const token of leases) paj.release(token);
    leases.clear();
    leaseRunId = null;
  };
  const on = (name, handler) => {
    const unsubscribe = pi.on(name, (event, currentCtx) => {
      if (!eligible() || currentCtx?.sessionManager.getSessionId() !== sessionId) return;
      modelCtx = currentCtx;
      handler(event, currentCtx);
    });
    if (typeof unsubscribe === 'function') unsubscribers.push(unsubscribe);
  };
  on('before_agent_start', () => {
    if (!runId) runId = uuid();
    emit({ type: 'state', state: state() });
  });
  on('agent_start', () => {
    if (!runId) runId = uuid();
    releaseLeases();
    emit({ type: 'state', state: state() });
  });
  on('agent_settled', () => {
    reconcileFinalized();
    releaseLeases();
    runId = null;
    emit({ type: 'state', state: state() });
    deferState();
    emit({ type: 'reset' });
  });
  on('model_select', () => {
    refreshState();
    deferState();
  });
  for (const name of ['turn_end', 'agent_end']) {
    on(name, () => {
      refreshState();
      deferState();
    });
  }
  on('ui_prompt_start', () => {
    terminalDepth++;
    emit({ type: 'state', state: state() });
  });
  on('ui_prompt_end', () => {
    terminalDepth = Math.max(0, terminalDepth - 1);
    emit({ type: 'state', state: state() });
  });
  on('message_start', (event) => {
    if (event.message.role === 'assistant') partial = { id: uuid(), role: 'assistant', text: '' };
  });
  on('message_update', (event) => {
    const update = event.assistantMessageEvent;
    if (update?.type !== 'text_delta' || typeof update.delta !== 'string') return;
    partial ??= { id: uuid(), role: 'assistant', text: '' };
    const text = update.delta.slice(0, TEXT_LIMIT - partial.text.length);
    partial.text += text;
    if (text) emit({ type: 'delta', messageId: partial.id, text });
  });
  on('message_end', (event) => {
    refreshState();
    deferState();
    const message = projectMessage(event.message,
      event.message.role === 'assistant' && partial ? partial.id : uuid());
    if (message) {
      const branch = ctx.sessionManager.getBranch();
      finalized.push({ message, source: new WeakRef(event.message), role: event.message.role,
        timestamp: event.message.timestamp, toolCallId: event.message.toolCallId,
        customType: event.message.customType,
        after: branch.at(-1)?.id ?? null });
      if (finalized.length > 100) finalized.shift();
      emit({ type: 'message', message });
    }
    if (event.message.role === 'assistant') partial = null;
    if (finalized.length && !reconcileImmediate && !reconcileTimer) {
      reconcileDelay = 25;
      reconcileImmediate = setImmediate(observePersistence);
      reconcileImmediate.unref?.();
    }
  });
  for (const name of ['session_tree', 'session_compact']) {
    on(name, () => {
      cancelReconciliation();
      finalized = [];
      partial = null;
      refreshState();
      deferState();
      emit({ type: 'reset' });
    });
  }
  on('session_compact_failed', () => {
    reconcileFinalized();
    refreshState();
    deferState();
    emit({ type: 'reset' });
  });
  on('tool_execution_start', (event) => {
    emit({ type: 'message', message: { id: `tool:${event.toolCallId}`, role: 'tool',
      text: `${String(event.toolName).slice(0, 100)}: running` } });
  });

  function validateTarget(params) {
    assertEligible();
    if (params?.generation !== generation) fail('stale_generation', 'Session generation changed');
  }
  return {
    generation,
    identity,
    eligible,
    state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    notifyState() { emit({ type: 'state', state: state() }); },
    snapshot(params) {
      validateTarget(params);
      const messages = [];
      let cursorSeen = params.before == null;
      const branch = ctx.sessionManager.getBranch();
      if (reconcileFinalized(branch)) emit({ type: 'reset' });
      const append = (message) => {
        if (!message) return;
        if (!cursorSeen) {
          if (message.id === params.before) cursorSeen = true;
          return;
        }
        messages.unshift(message);
      };
      const live = finalized.map(overlay => overlay.message);
      if (partial?.text) live.push({ ...partial });
      for (let index = live.length - 1; index >= 0 && messages.length <= 100; index--) {
        append(live[index]);
      }
      for (let index = branch.length - 1; index >= 0 && messages.length <= 100; index--) {
        const entry = branch[index];
        append(projectMessage(entryMessage(entry), entry.id));
      }
      if (!cursorSeen) fail('invalid_cursor', 'History cursor no longer exists; resnapshot');
      const hasMore = messages.length > 100;
      if (hasMore) messages.shift();
      return { sessionId, generation, seq, state: state(), messages,
        hasMore, before: hasMore ? messages[0].id : null };
    },
    prompt(params) {
      validateTarget(params);
      const { requestId, text, deliverAs } = params;
      const images = validateImages(params.images);
      const imageHash = hashImages(images);
      if (typeof requestId !== 'string' || !/^[\w-]{1,128}$/.test(requestId) ||
          typeof text !== 'string' || (!text.trim() && !images.length) || Buffer.byteLength(text) > 65536 ||
          !['reject', 'steer', 'followUp'].includes(deliverAs)) {
        fail('invalid_request', 'A bounded text, request ID and explicit delivery choice are required');
      }
      const previous = dedup.get(requestId);
      if (previous) {
        if (previous.text !== text || previous.deliverAs !== deliverAs || previous.imageHash !== imageHash) {
          fail('request_conflict', 'Request ID was already used for different input');
        }
        if (previous.error) fail(previous.error.code, previous.error.message);
        return { ...previous.result, duplicate: true };
      }
      if (images.length && !state().supportsImages) {
        fail('images_unsupported', 'The selected Pi model does not support images');
      }
      if (paj.getSnapshot().editorBusy) fail('editor_busy', 'An editor request owns this session');
      const queueDuringRun = !ctx.isIdle() && Boolean(runId) && deliverAs !== 'reject';
      const reuseLease = leases.size > 0;
      if (reuseLease && (!queueDuringRun || leaseRunId !== runId)) {
        fail('busy', 'A previous submission has not started or settled');
      }
      if (!ctx.isIdle() && deliverAs === 'reject') fail('busy', 'Choose steering or follow-up explicitly');
      // Queued input shares its active run's reservation; uncertain idle dispatch stays exclusive.
      const token = reuseLease ? leases.values().next().value : `${generation}:${requestId}`;
      if (!paj.tryReserve(token)) fail('editor_busy', 'An editor request owns this session');
      if (!reuseLease) {
        leases.add(token);
        leaseRunId = queueDuringRun ? runId : null;
      }
      const record = { text, deliverAs, imageHash };
      dedup.set(requestId, record);
      while (dedup.size > Math.max(1, dedupLimit)) dedup.delete(dedup.keys().next().value);
      try {
        const content = images.length ? [
          ...(text.trim() ? [{ type: 'text', text }] : []),
          ...images.map(image => ({ type: 'image', ...image })),
        ] : text;
        pi.sendUserMessage(content, { expandPromptTemplates: false,
          ...(deliverAs === 'reject' ? {} : { deliverAs }) });
        record.result = { status: 'submitted', requestId };
        emit({ type: 'state', state: state() });
        return record.result;
      } catch (error) {
        if (!reuseLease) {
          leases.delete(token);
          paj.release(token);
          leaseRunId = null;
        }
        record.error = { code: 'submission_failed', message: 'Pi could not submit this input' };
        fail(record.error.code, record.error.message);
      }
    },
    abort(params) {
      validateTarget(params);
      if (paj.getSnapshot().editorBusy) fail('editor_busy', 'An editor request owns this session');
      if (!runId || params.runId !== runId || ctx.isIdle()) {
        fail('stale_run', 'The requested run is no longer active');
      }
      ctx.abort();
      return { status: 'submitted', runId };
    },
    close() {
      if (closed) return;
      closed = true;
      cancelReconciliation();
      clearImmediate(metadataImmediate);
      finalized = [];
      partial = null;
      for (const unsubscribe of unsubscribers) unsubscribe();
      releaseLeases();
      listeners.clear();
      dedup.clear();
    },
  };
}
