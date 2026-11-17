export const MESSAGE_TEXT_LIMIT = 8192;
const encoder = new TextEncoder();

export function boundedMessageText(value: string) {
  let text = value.slice(0, MESSAGE_TEXT_LIMIT);
  while (encoder.encode(JSON.stringify(text)).byteLength > MESSAGE_TEXT_LIMIT + 2) {
    text = text.slice(0, Math.floor(text.length * 0.75));
  }
  return text;
}
