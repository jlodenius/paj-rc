import type { Command } from "./types.js";

export const MAX_COMMAND_NAME_LENGTH = 15999;
export const COMMAND_PAGE_SIZE = 128;
export const COMMAND_PAGE_BYTE_LIMIT = 128 * 1024;

export function commandSuggestions(
  commands: Command[],
  text: string,
  start: number,
  end = start,
) {
  if (!Array.isArray(commands) || start !== end || !Number.isInteger(start))
    return [];
  const token = text.match(/^\/[^\s]*/)?.[0];
  if (!token || start < 1 || start > token.length) return [];
  const prefix = text.slice(1, start).toLowerCase();
  return commands.filter(
    (command) =>
      ["extension", "skill", "prompt"].includes(command.source) &&
      typeof command.name === "string" &&
      (command.name.toLowerCase().startsWith(prefix) ||
        (command.source === "skill" &&
          command.name.toLowerCase().slice(6).startsWith(prefix))),
  );
}

export function insertCommand(text: string, name: string) {
  const token = text.match(/^\/[^\s]*/)?.[0];
  if (!token) return null;
  const suffix =
    text.slice(token.length) ||
    (name.length < MAX_COMMAND_NAME_LENGTH ? " " : "");
  const command = `/${name}`;
  return {
    text: command + suffix,
    cursor: command.length + (/^[ \t]/.test(suffix) ? 1 : 0),
  };
}
