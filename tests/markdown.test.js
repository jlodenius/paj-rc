import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../public/markdown.js';

class Node {
  constructor(document, tag, text = '') {
    this.ownerDocument = document;
    this.tagName = tag;
    this.text = text;
    this.children = [];
    this.attributes = {};
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = value; }
  get textContent() { return this.text + this.children.map(node => node.textContent).join(''); }
  set innerHTML(value) { throw new Error(`Unsafe HTML insertion: ${value}`); }
}

function container() {
  const document = {
    createElement(tag) { return new Node(document, tag); },
    createTextNode(text) { return new Node(document, '#text', text); },
  };
  return document.createElement('div');
}

function descendants(node, tag) {
  return node.children.flatMap(child => [
    ...(child.tagName === tag ? [child] : []), ...descendants(child, tag),
  ]);
}

function render(text) {
  const root = container();
  renderMarkdown(root, text);
  return root;
}

test('renders paragraphs, headings, Unicode, and explicit soft line breaks', () => {
  const root = render('# Status 👋\r\n\r\nHello 世界\r\nnext line\n\n## Details\nDone');
  assert.deepEqual(root.children.map(node => node.tagName), ['h1', 'p', 'h2', 'p']);
  assert.equal(root.children[0].textContent, 'Status 👋');
  assert.equal(root.children[1].textContent, 'Hello 世界next line');
  assert.equal(descendants(root, 'br').length, 1);
  assert.equal(root.children[2].textContent, 'Details');
  assert.equal(render('').children.length, 0);
});

test('renders unordered and ordered lists and blockquotes', () => {
  const root = render('- first\n- **second**\n\n3. third\n4. fourth\n\n> Quoted\n>\n> *Again*');
  assert.deepEqual(root.children.map(node => node.tagName), ['ul', 'ol', 'blockquote']);
  assert.deepEqual(root.children[0].children.map(node => node.textContent), ['first', 'second']);
  assert.equal(root.children[1].attributes.start, '3');
  assert.deepEqual(root.children[1].children.map(node => node.textContent), ['third', 'fourth']);
  assert.equal(descendants(root, 'blockquote')[0].children.length, 2);
  assert.equal(descendants(root, 'strong')[0].textContent, 'second');
  assert.equal(descendants(root, 'em')[0].textContent, 'Again');
});

test('renders inline code, bold, italic, strike, and escaped punctuation', () => {
  const root = render('A **bold** and *italic* with ~~old~~ and `<script>**literal**</script>`; \\*plain\\*.');
  assert.equal(descendants(root, 'strong')[0].textContent, 'bold');
  assert.equal(descendants(root, 'em')[0].textContent, 'italic');
  assert.equal(descendants(root, 'del')[0].textContent, 'old');
  assert.equal(descendants(root, 'code')[0].textContent, '<script>**literal**</script>');
  assert.match(root.textContent, /; \*plain\*\.$/);
  assert.equal(descendants(root, 'script').length, 0);
});

test('simple nested emphasis and escaped closing delimiters remain bounded and correct', () => {
  const root = render('**bold and *italic* inside** plus *escaped \\* marker*');
  assert.equal(descendants(root, 'strong')[0].textContent, 'bold and italic inside');
  assert.deepEqual(descendants(root, 'em').map(node => node.textContent),
    ['italic', 'escaped * marker']);
});

test('fenced code stays literal, including HTML, links, newlines, and shorter fences', () => {
  const root = render('````js\n<script>alert(1)</script>\n**bold** [x](https://example.com)\n```\n````\n\n~~~\nconst x = 1;\n~~~');
  assert.equal(descendants(root, 'pre').length, 2);
  assert.equal(descendants(root, 'code')[0].textContent,
    '<script>alert(1)</script>\n**bold** [x](https://example.com)\n```');
  assert.equal(descendants(root, 'code')[1].textContent, 'const x = 1;');
  assert.equal(descendants(root, 'a').length, 0);
  assert.equal(descendants(root, 'strong').length, 0);
  assert.equal(render('```\nunclosed\ncode').textContent, 'unclosed\ncode');
});

test('only explicit http(s) links become safe external anchors', () => {
  const root = render('[one](https://example.com/path?q=1&x=2) [two](http://example.org)\nhttps://plain.example');
  const links = descendants(root, 'a');
  assert.equal(links.length, 2);
  assert.equal(links[0].textContent, 'one');
  assert.deepEqual(links[0].attributes, {
    href: 'https://example.com/path?q=1&x=2', target: '_blank', rel: 'noopener noreferrer',
  });
  assert.equal(links[1].attributes.href, 'http://example.org');
  assert.match(root.textContent, /https:\/\/plain.example$/);
});

test('XSS, raw HTML, unsafe links, images, and embeds remain inert text', () => {
  const payloads = [
    '<script>alert(1)</script>', '<img src="https://tracker.example" onerror="alert(1)">',
    '<iframe src="https://example.com"></iframe>',
    '[bad](javascript:alert(1))', '[bad](data:text/html,evil)', '[bad](vbscript:evil)',
    '[bad](//example.com)', '[bad](/api/auth)', '[bad](https://user:password@example.com)',
    '[bad](https://)', '![tracking](https://tracker.example/pixel.png)',
    '![bad](data:image/svg+xml,evil)', '<a href="javascript:evil">click</a>',
    '<svg/onload=alert(1)>', '&lt;script&gt;not decoded&lt;/script&gt;',
  ];
  for (const payload of payloads) {
    const root = render(payload);
    assert.equal(root.textContent, payload);
    for (const tag of ['a', 'script', 'img', 'iframe', 'svg', 'object', 'embed']) {
      assert.equal(descendants(root, tag).length, 0, `${tag}: ${payload}`);
    }
  }
});

test('rendering replaces prior content rather than retaining old message text', () => {
  const root = render('old **content**');
  renderMarkdown(root, 'new');
  assert.equal(root.children.length, 1);
  assert.equal(root.textContent, 'new');
  assert.equal(descendants(root, 'strong').length, 0);
});

test('pathological input is bounded and oversized content is retained as literal text', () => {
  const deep = `${'> '.repeat(500)}hello`;
  const root = render(deep);
  assert.ok(descendants(root, 'blockquote').length <= 8);
  assert.match(root.textContent, /hello$/);
  const markers = '*`~[\\'.repeat(1500);
  assert.doesNotThrow(() => render(markers));
  const oversized = '**'.repeat(100000);
  const literal = render(oversized);
  assert.equal(literal.children.length, 1);
  assert.equal(literal.children[0].tagName, '#text');
  assert.equal(literal.textContent, oversized);
});
