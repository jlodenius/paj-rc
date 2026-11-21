import { boundedMessageText } from "./text.js";

import type { Envelope, Message, SubmissionStatus } from "./types.js";

interface Feedback {
  scope: string;
  requestId: string;
  text: string;
  matchText: string;
  imageCount: number;
  seq: number;
  status: SubmissionStatus;
  nativeId: string | null;
}

export function createSubmissionFeedback(limit = 128) {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new RangeError("Positive feedback limit required");
  const entries = new Map<string, Feedback>();
  const observed = new Set<string>();
  const key = (scope: string, id: string) => `${scope}:${id}`;
  return {
    clear() {
      entries.clear();
      observed.clear();
    },
    forget(scope: string, requestId: string) {
      entries.delete(key(scope, requestId));
    },
    begin(
      scope: string,
      {
        requestId,
        text,
        imageCount = 0,
        seq,
      }: {
        requestId: string;
        text: string;
        imageCount?: number;
        seq: number;
      },
    ) {
      const matchText =
        imageCount && !text.trim()
          ? imageCount === 1
            ? "[Image attached]"
            : `[${imageCount} images attached]`
          : boundedMessageText(text);
      entries.set(key(scope, requestId), {
        scope,
        requestId,
        text,
        matchText,
        imageCount,
        seq,
        status: "submitting",
        nativeId: null,
      });
      while (entries.size > limit) entries.delete(entries.keys().next().value);
    },
    update(scope: string, requestId: string, status: SubmissionStatus) {
      const entry = entries.get(key(scope, requestId));
      if (entry) entry.status = status;
    },
    observe(scope: string, envelope: Envelope) {
      const message =
        envelope.event?.type === "message" ? envelope.event.message : null;
      if (message?.role !== "user" || observed.has(key(scope, message.id)))
        return;
      observed.add(key(scope, message.id));
      while (observed.size > limit * 2)
        observed.delete(observed.values().next().value);
      // Content matching only replaces a visual receipt; it never confirms execution or retries input.
      for (const entry of entries.values()) {
        if (
          entry.scope !== scope ||
          entry.nativeId ||
          entry.status === "rejected" ||
          envelope.seq <= entry.seq
        )
          continue;
        if (
          message.text === entry.matchText &&
          (message.imageCount || 0) === entry.imageCount
        ) {
          entry.nativeId = message.id;
          break;
        }
      }
    },
    messages(scope: string, messages: Message[]) {
      const current = [...entries.values()].filter(
        (entry) => entry.scope === scope,
      );
      const decorated = messages.map((message) => {
        const entry = current.find(
          (value) =>
            value.nativeId === message.id && value.status !== "rejected",
        );
        return entry
          ? {
              ...message,
              steering: true,
              submissionStatus: entry.status,
              observed: true,
            }
          : message;
      });
      for (const entry of current) {
        if (entry.nativeId && entry.status === "submitted") continue;
        if (
          entry.nativeId &&
          messages.some((message) => message.id === entry.nativeId) &&
          entry.status !== "rejected"
        )
          continue;
        decorated.push({
          id: `submission:${entry.requestId}`,
          role: "user",
          text: entry.text,
          ...(entry.imageCount ? { imageCount: entry.imageCount } : {}),
          steering: true,
          submissionStatus: entry.status,
        });
      }
      return decorated;
    },
  };
}

export function steeringLabel(message: Message) {
  if (message.observed && message.submissionStatus === "submitted")
    return "Steering";
  return (
    {
      submitting: "Steering · submitting…",
      submitted: "Steering · submitted",
      unknown: "Steering · delivery unconfirmed",
      rejected: "Steering · not submitted",
    }[message.submissionStatus] || "Steering"
  );
}
