const MAX_DEPTH = 8;
const MAX_PARSE_LENGTH = 16384;

function appendText(container: HTMLElement, text: string) {
  container.append(container.ownerDocument.createTextNode(text));
}

function element(container: HTMLElement, tag: string) {
  const node = container.ownerDocument.createElement(tag);
  container.append(node);
  return node;
}

function safeLink(destination: string) {
  if (!/^https?:\/\//i.test(destination)) return false;
  try {
    const url = new URL(destination);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function closingMarker(text: string, marker: string, from: number) {
  let index = text.indexOf(marker, from);
  while (index !== -1) {
    let slashes = 0;
    for (let before = index - 1; before >= 0 && text[before] === "\\"; before--)
      slashes++;
    if (slashes % 2 === 0) return index;
    index = text.indexOf(marker, index + marker.length);
  }
  return -1;
}

function inline(container: HTMLElement, text: string, depth = 0) {
  if (depth >= MAX_DEPTH) {
    appendText(container, text);
    return;
  }
  let start = 0;
  let index = 0;
  const flush = () => {
    if (index > start) appendText(container, text.slice(start, index));
  };
  while (index < text.length) {
    const rest = text.slice(index);
    const escaped = /^\\([\\`*{}\[\]()#+\-.!_>~])/.exec(rest);
    if (escaped) {
      flush();
      appendText(container, escaped[1]);
      index += escaped[0].length;
      start = index;
      continue;
    }
    const image = /^!\[[^\]\n]*\]\([^\n)]*\)/.exec(rest);
    if (image) {
      flush();
      appendText(container, image[0]);
      index += image[0].length;
      start = index;
      continue;
    }
    const link = /^\[([^\]\n]+)\]\(([^\s()]+)\)/.exec(rest);
    if (link) {
      flush();
      if (safeLink(link[2])) {
        const anchor = element(container, "a");
        anchor.setAttribute("href", link[2]);
        anchor.setAttribute("target", "_blank");
        anchor.setAttribute("rel", "noopener noreferrer");
        appendText(anchor, link[1]);
      } else appendText(container, link[0]);
      index += link[0].length;
      start = index;
      continue;
    }
    const marker = ["`", "**", "~~", "*"].find((value) =>
      rest.startsWith(value),
    );
    if (marker) {
      const end =
        marker === "`"
          ? text.indexOf(marker, index + marker.length)
          : closingMarker(text, marker, index + marker.length);
      if (end > index + marker.length) {
        flush();
        const tag = (
          { "`": "code", "**": "strong", "*": "em", "~~": "del" } as Record<
            string,
            string
          >
        )[marker];
        const node = element(container, tag);
        const content = text.slice(index + marker.length, end);
        if (marker === "`") appendText(node, content);
        else inline(node, content, depth + 1);
        index = end + marker.length;
        start = index;
        continue;
      }
    }
    if (text[index] === "\n") {
      flush();
      element(container, "br");
      index++;
      start = index;
      continue;
    }
    index++;
  }
  flush();
}

const fence = (line: string) => /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
const heading = (line: string) => /^ {0,3}(#{1,6})\s+(.+)$/.exec(line);
const listItem = (line: string) => /^ {0,3}([-+*]|\d+[.)])\s+(.+)$/.exec(line);
const quote = (line: string) => /^ {0,3}> ?(.*)$/.exec(line);
const special = (line: string) =>
  fence(line) || heading(line) || listItem(line) || quote(line);

function blocks(container: HTMLElement, lines: string[], depth = 0) {
  if (depth >= MAX_DEPTH) {
    appendText(container, lines.join("\n"));
    return;
  }
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index++;
      continue;
    }
    const opening = fence(line);
    if (opening) {
      const code = element(element(container, "pre"), "code");
      const contents = [];
      index++;
      while (index < lines.length) {
        const closing = /^ {0,3}(`+|~+)\s*$/.exec(lines[index]);
        if (
          closing &&
          closing[1][0] === opening[1][0] &&
          closing[1].length >= opening[1].length
        ) {
          index++;
          break;
        }
        contents.push(lines[index++]);
      }
      appendText(code, contents.join("\n"));
      continue;
    }
    const title = heading(line);
    if (title) {
      inline(element(container, `h${title[1].length}`), title[2]);
      index++;
      continue;
    }
    if (quote(line)) {
      const contents = [];
      while (index < lines.length && quote(lines[index]))
        contents.push(quote(lines[index++])[1]);
      blocks(element(container, "blockquote"), contents, depth + 1);
      continue;
    }
    const item = listItem(line);
    if (item) {
      const ordered = /^\d/.test(item[1]);
      const list = element(container, ordered ? "ol" : "ul");
      if (ordered && Number.parseInt(item[1], 10) !== 1) {
        list.setAttribute("start", String(Number.parseInt(item[1], 10)));
      }
      while (index < lines.length) {
        const next = listItem(lines[index]);
        if (!next || /^\d/.test(next[1]) !== ordered) break;
        inline(element(list, "li"), next[2]);
        index++;
      }
      continue;
    }
    const paragraph = [lines[index++]];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !special(lines[index])
    ) {
      paragraph.push(lines[index++]);
    }
    inline(element(container, "p"), paragraph.join("\n"));
  }
}

export function renderMarkdown(container: HTMLElement, text: string) {
  container.replaceChildren();
  const input = String(text ?? "").replace(/\r\n?/g, "\n");
  if (input.length > MAX_PARSE_LENGTH) {
    appendText(container, input);
    return;
  }
  blocks(container, input.split("\n"));
}
