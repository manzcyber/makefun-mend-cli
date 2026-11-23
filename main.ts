// mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
// The last lines hand a trial over to runner.ts when MAKEFUN_ENV_URL is set; keep that hand-over as it is.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';
const trimEndWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

interface FileShape {
  lines: string[];
  nl: string;
  final: boolean;
}

function fileShape(text: string): FileShape {
  const i = text.indexOf('\n');
  const nl = i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], nl, final: false };
  const lines = text.split(nl);
  const final = text.endsWith(nl);
  if (final) lines.pop();
  return { lines, nl, final };
}

function serialize(f: FileShape): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.nl) + (f.final ? f.nl : '');
}

function guardPaths(paths: (string | null)[]): void {
  for (const p of paths) {
    if (p === null || p === '/dev/null') continue;
    if (!safe(p)) throw new Fail('unsafe', p);
  }
}

interface NLine {
  text: string;
  ctx: number | null;
}
interface Match {
  tier: number;
  pos: number;
}

function norm(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return trimEndWS(line);
  return trimWS(line);
}

function findMatch(lines: string[], old: string[], strict: boolean, ok: (p: number) => boolean): { tier: number; positions: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier += 1) {
    const want = old.map((l) => norm(l, tier));
    const positions: number[] = [];
    for (let i = 0; i + want.length <= lines.length; i += 1) {
      if (!ok(i)) continue;
      let same = true;
      for (let j = 0; j < want.length; j += 1) {
        if (norm(lines[i + j]!, tier) !== want[j]) {
          same = false;
          break;
        }
      }
      if (same) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

function materialize(fileLines: string[], m: Match, n: NLine[], old: string[]): string[] {
  const f = leadWS(fileLines[m.pos] ?? '');
  const p = leadWS(old[0] ?? '');
  return n.map((line) => {
    if (line.ctx !== null) return fileLines[m.pos + line.ctx] ?? line.text;
    if (m.tier === 2 && line.text.trim() !== '' && line.text.startsWith(p)) return f + line.text.slice(p.length);
    return line.text;
  });
}

type BodyKind = 'ctx' | 'old' | 'new' | 'slash';
interface BodyEntry {
  kind: BodyKind;
  text: string;
  blank: boolean;
}

function trimBody(body: BodyEntry[]): BodyEntry[] {
  const out = body.slice();
  while (out.length > 0 && out[out.length - 1]!.blank) out.pop();
  return out;
}

function bodyON(body: BodyEntry[]): { old: string[]; n: NLine[] } {
  const old: string[] = [];
  const n: NLine[] = [];
  for (const e of body) {
    if (e.kind === 'ctx') {
      const at = old.length;
      old.push(e.text);
      n.push({ text: e.text, ctx: at });
    } else if (e.kind === 'old') old.push(e.text);
    else if (e.kind === 'new') n.push({ text: e.text, ctx: null });
  }
  return { old, n };
}

function bodyNoNewline(body: BodyEntry[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i += 1) {
    if (body[i]!.kind === 'ctx' || body[i]!.kind === 'new') last = i;
  }
  return last >= 0 && body[last + 1]?.kind === 'slash';
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

interface Hunk {
  at: number;
  old: string[];
  n: NLine[];
  noNewline: boolean;
}
interface Section {
  oldName: string | null;
  newName: string | null;
  oldExplicit: boolean;
  newExplicit: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  gitOld: string | null;
  gitNew: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function stripPrefix(p: string): string {
  const t = p.trim();
  return t.startsWith('a/') || t.startsWith('b/') ? t.slice(2) : t;
}

function headerPath(l: string): string {
  let t = l.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  return t === '/dev/null' ? '/dev/null' : stripPrefix(t);
}

function newSection(gitOld: string | null = null, gitNew: string | null = null): Section {
  return {
    oldName: null, newName: null, oldExplicit: false, newExplicit: false,
    renameFrom: null, renameTo: null, gitOld, gitNew, create: false, del: false, hunks: [],
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let body: BodyEntry[] | null = null;
  let at = 0;
  const finish = (): void => {
    if (body === null || cur === null) return;
    const b = trimBody(body);
    const on = bodyON(b);
    cur.hunks.push({ at, old: on.old, n: on.n, noNewline: bodyNoNewline(b) });
    body = null;
  };
  const startsSection = (i: number): boolean =>
    lines[i]!.startsWith('diff --git ') || (lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '));
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (body !== null && (startsSection(i) || (l.startsWith('@@') && !/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(l)))) {
      finish();
      continue;
    }
    if (body !== null && (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\'))) {
      if (l === '') body.push({ kind: 'ctx', text: '', blank: true });
      else if (l.startsWith(' ')) body.push({ kind: 'ctx', text: l.slice(1), blank: false });
      else if (l.startsWith('-')) body.push({ kind: 'old', text: l.slice(1), blank: false });
      else if (l.startsWith('+')) body.push({ kind: 'new', text: l.slice(1), blank: false });
      else body.push({ kind: 'slash', text: l, blank: false });
      i += 1;
      continue;
    }
    if (body !== null) finish();
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(l.trimEnd());
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection(m[1]!, m[2]!);
      sections.push(cur);
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldPath = headerPath(l);
      const newPath = headerPath(lines[i + 1]!);
      if (cur === null || cur.hunks.length > 0) {
        cur = newSection();
        sections.push(cur);
      }
      cur.oldName = oldPath;
      cur.newName = newPath;
      cur.oldExplicit = true;
      cur.newExplicit = true;
      i += 2;
      continue;
    }
    if (cur !== null) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) {
        cur.renameFrom = l.slice(12).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameTo = l.slice(10).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.create = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.del = true;
        i += 1;
        continue;
      }
      if (l.startsWith('@@')) {
        const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        at = Number(m[1]!);
        body = [];
        i += 1;
        continue;
      }
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    i += 1;
  }
  finish();

  const edits: Edit[] = [];
  for (const s of sections) {
    const oldName = s.oldExplicit ? s.oldName : (s.renameFrom ?? s.gitOld);
    const newName = s.newExplicit ? s.newName : (s.renameTo ?? s.gitNew);
    const oldPath = oldName === '/dev/null' ? null : oldName;
    const newPath = newName === '/dev/null' ? null : newName;
    edits.push((tree) => {
      guardPaths([oldPath, newPath]);
      if (s.create || oldPath === null) {
        if (newPath === null) throw new Fail('missing', oldPath ?? '');
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const lines: string[] = [];
        let noNewline = false;
        for (const h of s.hunks) {
          const plus = h.n.filter((x) => x.ctx === null);
          for (const x of plus) lines.push(x.text);
          if (plus.length > 0) noNewline = h.noNewline;
        }
        tree.now.set(newPath, serialize({ lines, nl: '\n', final: !noNewline }));
        return;
      }
      if (s.del || newPath === null) {
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.now.set(oldPath, null);
        return;
      }
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (oldPath !== newPath && tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const f = fileShape(before);
      const lines = f.lines.slice();
      let final = f.final;
      let d = 0;
      for (const h of s.hunks) {
        if (h.old.length === 0) {
          const at = Math.min(Math.max(h.at + d, 0), lines.length);
          const end = at === lines.length;
          lines.splice(at, 0, ...h.n.map((x) => x.text));
          if (end) final = !h.noNewline;
          d += h.n.length;
          continue;
        }
        const found = findMatch(lines, h.old, strict, () => true);
        if (found === null) throw new Fail('no-match', oldPath);
        const target = h.at - 1 + d;
        let pos = found.positions[0]!;
        for (const p of found.positions) {
          if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
        }
        const repl = materialize(lines, { tier: found.tier, pos }, h.n, h.old);
        const end = pos + h.old.length === lines.length;
        lines.splice(pos, h.old.length, ...repl);
        if (end) final = !h.noNewline;
        d += h.n.length - h.old.length;
      }
      const out = serialize({ ...f, lines, final });
      if (oldPath !== newPath) {
        tree.now.set(oldPath, null);
        tree.now.set(newPath, out);
        tree.moves.push({ old: oldPath, new: newPath });
      } else tree.now.set(oldPath, out);
    });
  }
  return edits;
}

interface VBodyEntry extends BodyEntry {}
interface VChunk {
  anchor: string | null;
  body: VBodyEntry[];
  eof: boolean;
}
interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number;
  moveTo: string | null;
  addLines: VBodyEntry[];
  chunks: VChunk[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first < 0 ? 1 : first + 1}`);
  const last = lines.findLastIndex((l) => !blank(l));
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let cur: VSection | null = null;
  let body: VBodyEntry[] | null = null;
  let anchor: string | null = null;
  const finishChunk = (): void => {
    if (body === null || cur === null) return;
    cur.chunks.push({ anchor, body: trimBody(body), eof: false });
    body = null;
    anchor = null;
  };
  const finishSection = (): void => {
    finishChunk();
    if (cur !== null) cur.addLines = trimBody(cur.addLines);
    cur = null;
  };
  for (let i = first + 1; i < last; i += 1) {
    const l = lines[i]!;
    if (blank(l)) {
      if (cur?.kind === 'update' && body !== null) body.push({ kind: 'ctx', text: '', blank: true });
      else if (cur?.kind === 'add') cur.addLines.push({ kind: 'new', text: '', blank: true });
      continue;
    }
    if (l.trim() === '*** End of File') {
      if (cur?.kind !== 'update') throw new Exit2(`error: parse ${i + 1}`);
      if (body !== null) {
        cur.chunks.push({ anchor, body: trimBody(body), eof: true });
        body = null;
      } else cur.chunks.push({ anchor: null, body: [], eof: true });
      anchor = null;
      continue;
    }
    const head = l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'delete' : l.startsWith('*** Update File: ') ? 'update' : null;
    if (head !== null) {
      finishSection();
      const prefix = head === 'add' ? '*** Add File: ' : head === 'delete' ? '*** Delete File: ' : '*** Update File: ';
      cur = { kind: head, path: l.slice(prefix.length).trim(), line: i + 1, moveTo: null, addLines: [], chunks: [] };
      sections.push(cur);
      continue;
    }
    if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
    if (cur.kind === 'add') {
      if (!l.startsWith('+')) throw new Exit2(`error: parse ${i + 1}`);
      cur.addLines.push({ kind: 'new', text: l.slice(1), blank: false });
      continue;
    }
    if (cur.kind === 'delete') throw new Exit2(`error: parse ${i + 1}`);
    if (l.startsWith('*** Move to: ')) {
      if (cur.moveTo !== null || cur.chunks.length > 0 || body !== null) throw new Exit2(`error: parse ${i + 1}`);
      cur.moveTo = l.slice(13).trim();
      continue;
    }
    if (l.startsWith('@@')) {
      finishChunk();
      anchor = l.slice(2).trim();
      if (anchor === '') anchor = null;
      body = [];
      continue;
    }
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (body === null) body = [];
      if (l.startsWith(' ')) body.push({ kind: 'ctx', text: l.slice(1), blank: false });
      else if (l.startsWith('-')) body.push({ kind: 'old', text: l.slice(1), blank: false });
      else body.push({ kind: 'new', text: l.slice(1), blank: false });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  finishSection();
  for (const s of sections) {
    if (s.kind !== 'update' || s.chunks.length > 0 || s.moveTo !== null) continue;
    throw new Exit2(`error: parse ${s.line}`);
  }

  return sections.map((s) => (tree: Tree) => {
    guardPaths([s.path, s.moveTo]);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, serialize({ lines: s.addLines.map((e) => e.text), nl: '\n', final: true }));
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const f = fileShape(before);
    const lines = f.lines.slice();
    let cursor = 0;
    for (const ch of s.chunks) {
      if (ch.anchor !== null) {
        const found = findMatch(lines, [ch.anchor], strict, (p) => p >= cursor);
        if (found === null) throw new Fail('no-match', s.path);
        cursor = found.positions[0]! + 1;
      }
      const on = bodyON(ch.body);
      if (on.old.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        lines.splice(at, 0, ...on.n.map((x) => x.text));
        cursor = at + on.n.length;
        continue;
      }
      const found = findMatch(lines, on.old, strict, (p) => p >= cursor && (!ch.eof || p + on.old.length === lines.length));
      if (found === null) throw new Fail('no-match', s.path);
      const pos = found.positions[0]!;
      const repl = materialize(lines, { tier: found.tier, pos }, on.n, on.old);
      lines.splice(pos, on.old.length, ...repl);
      cursor = pos + repl.length;
    }
    const out = serialize({ ...f, lines });
    if (s.moveTo !== null) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, out);
      tree.moves.push({ old: s.path, new: s.moveTo });
    } else tree.now.set(s.path, out);
  });
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevReplace = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const at = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j > prevReplace; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${at}`);
    let eq = -1;
    let rep = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${at}`);
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${at}`);
    const old = lines.slice(i + 1, eq);
    const n = lines.slice(eq + 1, rep).map((text) => ({ text, ctx: null }));
    const target = path;
    edits.push((tree) => {
      guardPaths([target]);
      if (old.length === 0) {
        if (tree.get(target) !== null) throw new Fail('exists', target);
        tree.now.set(target, serialize({ lines: n.map((x) => x.text), nl: '\n', final: true }));
        return;
      }
      const before = tree.get(target);
      if (before === null) throw new Fail('missing', target);
      const f = fileShape(before);
      const found = findMatch(f.lines, old, strict, () => true);
      if (found === null) throw new Fail('no-match', target);
      if (found.positions.length > 1) throw new Fail('ambiguous', target);
      const match = { tier: found.tier, pos: found.positions[0]! };
      const repl = materialize(f.lines, match, n, old);
      const out = f.lines.slice();
      out.splice(match.pos, old.length, ...repl);
      tree.now.set(target, serialize({ ...f, lines: out }));
    });
    prevPath = target;
    prevReplace = rep;
    i = rep + 1;
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'v4a') edits = v4aEdits(lines, strict);
    else edits = srEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const mv of tree.moves) {
    if (tree.original(mv.old) === null || tree.now.get(mv.old) !== null || tree.original(mv.new) !== null || tree.now.get(mv.new) === null) continue;
    const d = rows.findIndex((r) => r.text === `D ${mv.old}`);
    if (d >= 0) rows.splice(d, 1);
    const a = rows.findIndex((r) => r.text === `A ${mv.new}`);
    if (a >= 0) rows.splice(a, 1);
    rows.push({ key: mv.new, text: `R ${mv.old} -> ${mv.new}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  if (!check) {
    for (const [p, now] of [...tree.now].sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])))) {
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
