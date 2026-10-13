// TinyJS backend: file access for the workspace folder chosen by the user.
// Runs in txiki.js (https://github.com/saghul/txiki.js); see tinyjs.json.

const SKIP = /^\./;

async function walk(root, rel, out) {
  const dir = rel ? `${root}/${rel}` : root;
  for await (const entry of await tjs.readDir(dir)) {
    if (SKIP.test(entry.name)) continue;
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory) await walk(root, path, out);
    else out.push(path);
  }
  return out;
}

function resolve(dir, path) {
  if (path.split('/').includes('..')) throw new Error('Invalid path');
  return `${dir}/${path}`;
}

async function ensureParent(file) {
  const parent = file.slice(0, file.lastIndexOf('/'));
  if (parent) await tjs.makeDir(parent, { recursive: true });
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const api = {
  list: async ({ dir }) => (await walk(dir, '', [])).sort(),
  readText: async ({ dir, path }) => tjs.readFile(resolve(dir, path), 'utf8'),
  readBase64: async ({ dir, path }) => toBase64(await tjs.readFile(resolve(dir, path))),
  writeText: async ({ dir, path, text }) => {
    const file = resolve(dir, path);
    await ensureParent(file);
    await tjs.writeFile(file, text);
  },
  writeBase64: async ({ dir, path, data }) => {
    const file = resolve(dir, path);
    await ensureParent(file);
    await tjs.writeFile(file, fromBase64(data));
  },
  remove: async ({ dir, path }) => tjs.remove(resolve(dir, path)),
  rename: async ({ dir, from, to }) => {
    const target = resolve(dir, to);
    const exists = await tjs.stat(target).then(() => true, () => false);
    if (exists) throw new Error(`File exists: ${to}`);
    await ensureParent(target);
    await tjs.rename(resolve(dir, from), target);
  },
  // Files chosen by the user in a native open dialog.
  readAbsolute: async ({ path }) => toBase64(await tjs.readFile(path)),
  // Target chosen by the user in a native save dialog.
  writeAbsolute: async ({ path, data }) => tjs.writeFile(path, fromBase64(data)),
};
