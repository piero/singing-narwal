// Minimal XML parser, sufficient for OpenDocument files: elements, attributes,
// text and the predefined/numeric entities. Works the same in browsers and Node.

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}
export type XmlNode = XmlElement | string;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? m;
  });
}

const TAG_RE = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<![^>]*>/g;
const ATTR_RE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export function parseXml(src: string): XmlElement {
  const root: XmlElement = { name: '#document', attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  let last = 0;
  for (const m of src.matchAll(TAG_RE)) {
    const top = stack[stack.length - 1];
    if (m.index! > last) {
      const text = src.slice(last, m.index);
      if (text) top.children.push(decodeEntities(text));
    }
    last = m.index! + m[0].length;
    if (m[5] !== undefined) {
      top.children.push(m[5]);
      continue;
    }
    if (!m[2]) continue; // comment, declaration, processing instruction
    if (m[1]) {
      // Closing tag: pop up to the matching element.
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name === m[2]) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of m[3].matchAll(ATTR_RE)) attrs[a[1]] = decodeEntities(a[2] ?? a[3] ?? '');
    const el: XmlElement = { name: m[2], attrs, children: [] };
    top.children.push(el);
    if (!m[4]) stack.push(el);
  }
  return root;
}

export function* elements(node: XmlElement, name?: string): Generator<XmlElement> {
  for (const c of node.children) {
    if (typeof c === 'string') continue;
    if (!name || c.name === name) yield c;
    yield* elements(c, name);
  }
}

export function child(node: XmlElement, name: string): XmlElement | undefined {
  return node.children.find((c): c is XmlElement => typeof c !== 'string' && c.name === name);
}
