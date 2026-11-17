import type { Command } from './types.js';

export function commandSuggestions(commands: Command[], text: string, start: number, end = start) {
  if (!Array.isArray(commands) || start !== end || !Number.isInteger(start)) return [];
  const token = text.match(/^\/[^\s]*/)?.[0];
  if (!token || start < 1 || start > token.length) return [];
  const prefix = text.slice(1, start).toLowerCase();
  return commands.filter(command => (command.source === 'skill' || command.source === 'prompt') &&
    typeof command.name === 'string' && (command.name.toLowerCase().startsWith(prefix) ||
      command.source === 'skill' && command.name.toLowerCase().slice(6).startsWith(prefix)));
}

export function insertCommand(text: string, name: string) {
  const token = text.match(/^\/[^\s]*/)?.[0];
  if (!token) return null;
  const suffix = text.slice(token.length) || ' ';
  const command = `/${name}`;
  return { text: command + suffix, cursor: command.length + (/^[ \t]/.test(suffix) ? 1 : 0) };
}
