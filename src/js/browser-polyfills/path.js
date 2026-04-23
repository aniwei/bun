const sep = '/';
function normalize(p) {
  const abs = p.startsWith('/');
  const segs = p.split('/').reduce((a, s) => {
    if (s === '' || s === '.') return a;
    if (s === '..') { a.pop(); return a; }
    a.push(s); return a;
  }, []);
  return (abs ? '/' : '') + segs.join('/');
}
function join(...parts) { return normalize(parts.filter(Boolean).join('/')); }
function resolve(...ps) {
  let r = typeof globalThis.__bun_cwd === 'string' ? globalThis.__bun_cwd : '/';
  for (const p of ps) r = p.startsWith('/') ? p : r.endsWith('/') ? r+p : r+'/'+p;
  return normalize(r);
}
function dirname(p) { const i = p.lastIndexOf('/'); return i <= 0 ? (i===0?'/':'.') : p.slice(0,i); }
function basename(p, ext) { let b = p.split('/').pop() || ''; if (ext && b.endsWith(ext)) b = b.slice(0, b.length - ext.length); return b; }
function extname(p) { const b = basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; }
function isAbsolute(p) { return p.startsWith('/'); }
function relative(from, to) {
  const f = resolve(from).split('/').filter(Boolean);
  const t = resolve(to).split('/').filter(Boolean);
  let i = 0; while (i < f.length && f[i] === t[i]) i++;
  return [...Array(f.length - i).fill('..'), ...t.slice(i)].join('/');
}
module.exports = { sep, normalize, join, resolve, dirname, basename, extname, isAbsolute, relative, posix: module.exports };
