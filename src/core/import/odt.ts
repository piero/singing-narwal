// OpenDocument Text (.odt) reader: extracts paragraphs with the position of each
// character, computed from the document's fonts, sizes, indents and tab stops.

import { unzipSync, strFromU8 } from 'fflate';
import { fontVariant, type FontRegistry } from '../fonts';
import type { SheetChar, SheetLine } from './sheet';
import { child, elements, parseXml, type XmlElement } from './xml';

interface TextProps {
  font?: string;
  size?: number;
  sizePct?: number;
  bold?: boolean;
  italic?: boolean;
}
interface ParaProps {
  marginLeft?: number;
  textIndent?: number;
  align?: SheetLine['align'];
}
interface Style {
  parent?: string;
  text: TextProps;
  para: ParaProps;
}

/** Convert an ODF length ("1cm", "0.5in", "12pt") to points. */
export function toPt(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const m = /^(-?[\d.]+)(cm|mm|in|pt|pc|px)?$/.exec(v.trim());
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  switch (m[2]) {
    case 'cm':
      return (n / 2.54) * 72;
    case 'mm':
      return (n / 25.4) * 72;
    case 'in':
      return n * 72;
    case 'pc':
      return n * 12;
    case 'px':
      return n * 0.75;
    default:
      return n;
  }
}

function readTextProps(el: XmlElement | undefined): TextProps {
  if (!el) return {};
  const a = el.attrs;
  const t: TextProps = {};
  if (a['style:font-name']) t.font = a['style:font-name'];
  else if (a['fo:font-family']) t.font = a['fo:font-family'].replace(/['"]/g, '');
  const size = a['fo:font-size'];
  if (size?.endsWith('%')) t.sizePct = parseFloat(size);
  else if (size) t.size = toPt(size);
  if (a['fo:font-weight']) t.bold = a['fo:font-weight'] === 'bold' || parseInt(a['fo:font-weight']) >= 600;
  if (a['fo:font-style']) t.italic = a['fo:font-style'] === 'italic' || a['fo:font-style'] === 'oblique';
  return t;
}

function readParaProps(el: XmlElement | undefined): ParaProps {
  if (!el) return {};
  const a = el.attrs;
  const p: ParaProps = {};
  if (a['fo:margin-left'] !== undefined) p.marginLeft = toPt(a['fo:margin-left']);
  if (a['fo:text-indent'] !== undefined) p.textIndent = toPt(a['fo:text-indent']);
  const al = a['fo:text-align'];
  if (al) p.align = al === 'center' ? 'center' : al === 'end' || al === 'right' ? 'right' : al === 'justify' ? 'justify' : 'left';
  return p;
}

function mergeText(base: TextProps, over: TextProps): TextProps {
  const r = { ...base, ...over };
  if (over.sizePct !== undefined) r.size = ((base.size ?? 12) * over.sizePct) / 100;
  delete r.sizePct;
  return r;
}

class Styles {
  map = new Map<string, Style>();
  defaultText: TextProps = { font: 'Liberation Serif', size: 12 };
  tabDistance = toPt('1.25cm')!;
  fontFaces = new Map<string, string>();

  addDoc(root: XmlElement) {
    for (const ff of elements(root, 'style:font-face')) {
      this.fontFaces.set(ff.attrs['style:name'], (ff.attrs['svg:font-family'] ?? ff.attrs['style:name']).replace(/['"]/g, ''));
    }
    for (const d of elements(root, 'style:default-style')) {
      if (d.attrs['style:family'] !== 'paragraph') continue;
      this.defaultText = mergeText(this.defaultText, readTextProps(child(d, 'style:text-properties')));
      const tab = toPt(child(d, 'style:paragraph-properties')?.attrs['style:tab-stop-distance']);
      if (tab) this.tabDistance = tab;
    }
    for (const s of elements(root, 'style:style')) {
      this.map.set(s.attrs['style:name'], {
        parent: s.attrs['style:parent-style-name'],
        text: readTextProps(child(s, 'style:text-properties')),
        para: readParaProps(child(s, 'style:paragraph-properties')),
      });
    }
  }

  private chain(name: string | undefined): Style[] {
    const out: Style[] = [];
    const seen = new Set<string>();
    while (name && !seen.has(name)) {
      seen.add(name);
      const s = this.map.get(name);
      if (!s) break;
      out.unshift(s);
      name = s.parent;
    }
    return out;
  }

  text(name: string | undefined, base: TextProps): TextProps {
    return this.chain(name).reduce((t, s) => mergeText(t, s.text), base);
  }

  para(name: string | undefined): ParaProps {
    return this.chain(name).reduce((p, s) => ({ ...p, ...s.para }), {} as ParaProps);
  }

  fontFamily(face: string | undefined): string {
    return (face && this.fontFaces.get(face)) || face || 'Liberation Serif';
  }
}

/** Map a document font name to a registry family. */
function registryFamily(reg: FontRegistry, name: string): string {
  const compact = name.replace(/\s+/g, '');
  if (reg.ids().some((id) => id.startsWith(compact + '-') || id === compact)) return compact;
  if (/mono|courier|consol|cousine/i.test(name)) return 'LiberationMono';
  if (/sans|arial|helvetica|arimo|calibri|verdana/i.test(name)) return 'LiberationSans';
  return 'LiberationSerif';
}

interface Run {
  text: string;
  props: TextProps;
}

export function readOdt(bytes: Uint8Array, fonts: FontRegistry): SheetLine[] {
  const files = unzipSync(bytes, { filter: (f) => f.name === 'content.xml' || f.name === 'styles.xml' });
  if (!files['content.xml']) throw new Error('Not an OpenDocument file (content.xml missing)');
  const styles = new Styles();
  if (files['styles.xml']) styles.addDoc(parseXml(strFromU8(files['styles.xml'])));
  const content = parseXml(strFromU8(files['content.xml']));
  styles.addDoc(content);

  const body = [...elements(content, 'office:text')][0];
  if (!body) return [];
  const lines: SheetLine[] = [];

  const measure = (runs: Run[], para: ParaProps, first: boolean): SheetLine => {
    const left = (para.marginLeft ?? 0) + (first ? (para.textIndent ?? 0) : 0);
    const chars: SheetChar[] = [];
    let x = left;
    let bold = true;
    let italic = true;
    let size = 0;
    for (const run of runs) {
      const p = run.props;
      const family = registryFamily(fonts, styles.fontFamily(p.font));
      const id = fontVariant(fonts, family, !!p.bold, !!p.italic);
      const sz = p.size ?? 12;
      if (run.text.trim()) {
        bold &&= !!p.bold;
        italic &&= !!p.italic;
        size = Math.max(size, sz);
      }
      // Tabs move to the next tab stop; other text is measured as a whole run so
      // that kerning matches the word processor.
      let segStart = x;
      let seg = '';
      for (const ch of run.text) {
        if (ch === '\t') {
          const tab = styles.tabDistance;
          const nx = (para.marginLeft ?? 0) + (Math.floor((x - (para.marginLeft ?? 0)) / tab + 1e-6) + 1) * tab;
          chars.push({ ch: ' ', x0: x, x1: nx });
          x = nx;
          segStart = x;
          seg = '';
          continue;
        }
        const x0 = segStart + fonts.width(id, sz, seg);
        seg += ch;
        x = segStart + fonts.width(id, sz, seg);
        chars.push({ ch, x0, x1: x });
      }
    }
    return { chars, indent: left, align: para.align, size: size || undefined, bold, italic };
  };

  const paragraph = (p: XmlElement, heading: boolean) => {
    const styleName = p.attrs['text:style-name'];
    const para = styles.para(styleName);
    const paraText = styles.text(styleName, styles.defaultText);
    let runs: Run[] = [];
    let first = true;
    const flush = () => {
      const l = measure(runs, para, first);
      l.heading = heading;
      lines.push(l);
      runs = [];
      first = false;
    };
    const walk = (el: XmlElement, props: TextProps) => {
      for (const c of el.children) {
        if (typeof c === 'string') {
          const t = c.replace(/[\t\n\r ]+/g, ' ');
          if (t) runs.push({ text: t, props });
          continue;
        }
        switch (c.name) {
          case 'text:s':
            runs.push({ text: ' '.repeat(parseInt(c.attrs['text:c'] ?? '1') || 1), props });
            break;
          case 'text:tab':
            runs.push({ text: '\t', props });
            break;
          case 'text:line-break':
            flush();
            break;
          case 'text:span':
          case 'text:a':
          case 'text:meta':
            walk(c, styles.text(c.attrs['text:style-name'], props));
            break;
          case 'text:note':
          case 'draw:frame':
          case 'office:annotation':
            break;
          default:
            walk(c, props);
        }
      }
    };
    walk(p, paraText);
    flush();
  };

  const block = (el: XmlElement) => {
    for (const c of el.children) {
      if (typeof c === 'string') continue;
      if (c.name === 'text:p') paragraph(c, false);
      else if (c.name === 'text:h') paragraph(c, true);
      else if (c.name !== 'text:sequence-decls' && c.name !== 'office:forms') block(c);
    }
  };
  block(body);
  return lines;
}
