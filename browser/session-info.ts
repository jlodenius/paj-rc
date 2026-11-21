import type { SessionState } from "./types.js";

const compact = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const validTokens = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function formatTokens(value: unknown) {
  return validTokens(value) ? compact.format(value).toLowerCase() : "—";
}

export function sessionInfo(state: SessionState = {}, fallbackModel?: string) {
  const model =
    state.model && typeof state.model.id === "string" ? state.model : null;
  const legacy =
    state.model === undefined && typeof fallbackModel === "string"
      ? fallbackModel
      : "";
  const modelText = model?.id || legacy || "Model unavailable";
  const modelTitle = model
    ? `${model.name || model.id} · ${model.provider}/${model.id}`
    : modelText;
  const usage = state.context;
  const window =
    validTokens(usage?.contextWindow) && usage.contextWindow > 0
      ? usage.contextWindow
      : null;
  const used = validTokens(usage?.tokens) ? usage.tokens : null;
  return {
    modelText,
    modelTitle,
    contextText: window
      ? `context: ${formatTokens(used)}/${formatTokens(window)}`
      : "context: —",
    contextTitle: window
      ? `Estimated context: ${used === null ? "unknown" : used.toLocaleString("en")} / ${window.toLocaleString("en")} tokens`
      : "Context usage unavailable; reload the Pi extension if needed",
  };
}
