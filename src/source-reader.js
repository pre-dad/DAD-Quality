import { readdir, readFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { digest, redact } from './core.js';

// The reader sees only the committed archive, never the operator's working tree.
const excluded =
  /(^|\/)(?:node_modules|\.git|\.atm|dist|build|vendor|\.next|\.env[^/]*)(?:\/|$)|(?:package-lock\.json|\.pem|\.key|\.p12|\.zip|\.png|\.jpg)$/i;
const textFile = /(?:\.(?:js|mjs|cjs|ts|tsx|jsx|go|sql|json|ya?ml|md|toml|html|css)|(?:^|\/)(?:Dockerfile|Makefile))$/i;
export async function sourceReader(root) {
  const base = await realpath(root),
    files = [];
  let entries = 0;
  async function walk(directory, depth = 0) {
    if (depth > 16) return;
    const children = await readdir(path.join(base, directory), { withFileTypes: true });
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++entries > 20_000) throw new Error('Source inventory exceeds its entry budget.');
      const relative = path.posix.join(directory, child.name);
      if (excluded.test(relative) || child.isSymbolicLink()) continue;
      if (child.isDirectory()) await walk(relative, depth + 1);
      else if (child.isFile() && textFile.test(relative) && files.length < 5000) files.push(relative);
    }
  }
  await walk('');
  const load = async relative => {
    if (!files.includes(relative)) throw new Error('Read only a file in the source inventory.');
    const file = path.join(base, relative),
      info = await lstat(file);
    if (!info.isFile() || info.size > 256_000 || (await realpath(file)) !== file)
      throw new Error('Source file is oversized or no longer regular.');
    const bytes = await readFile(file);
    if (bytes.includes(0)) throw new Error('Binary source file is unavailable.');
    return { content: redact(bytes.toString('utf8')), sha256: digest(bytes) };
  };
  return {
    inventory: files,
    async fingerprints(paths, signal) {
      const result = Object.create(null);
      for (const relative of [...new Set(paths)].slice(0, 500)) {
        signal?.throwIfAborted();
        if (!files.includes(relative)) {
          let status = 'unavailable';
          if (
            typeof relative === 'string' &&
            !path.isAbsolute(relative) &&
            !relative.split('/').some(p => !p || p === '.' || p === '..') &&
            !excluded.test(relative) &&
            textFile.test(relative)
          ) {
            let current = base;
            for (const part of relative.split('/')) {
              current = path.join(current, part);
              try {
                if ((await lstat(current)).isSymbolicLink()) break;
              } catch (error) {
                if (error.code === 'ENOENT' || error.code === 'ENOTDIR') status = 'missing';
                break;
              }
            }
          }
          result[relative] = { status };
          continue;
        }
        try {
          result[relative] = { status: 'available', sha256: (await load(relative)).sha256 };
        } catch {
          result[relative] = { status: 'unavailable' };
        }
      }
      return result;
    },
    async act(action) {
      if (action.action === 'list_source') {
        const offset = Number(action.value || '0');
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid inventory offset.');
        const selected = files.filter(f => f.includes(action.target));
        return {
          files: selected.slice(offset, offset + 100),
          total: selected.length,
          nextOffset: offset + 100 < selected.length ? offset + 100 : null,
        };
      }
      if (action.action === 'read_source') {
        const start = Number(action.value || '1');
        if (!Number.isSafeInteger(start) || start < 1) throw new Error('Invalid source line.');
        const { content, sha256 } = await load(action.target),
          lines = content.split('\n');
        let text = '',
          end = start - 1;
        for (let i = start - 1; i < Math.min(lines.length, start + 99); i++) {
          const line = `${i + 1}: ${lines[i]}\n`;
          if (text.length + line.length > 12_000) {
            if (!text) {
              text = line.slice(0, 12_000);
              end = i + 1;
            }
            break;
          }
          text += line;
          end = i + 1;
        }
        return { path: action.target, sha256, start, end, text, totalLines: lines.length };
      }
      if (action.action === 'search_source') {
        if (!action.value.trim()) throw new Error('Search requires literal text in value.');
        const matches = [];
        for (const file of files.filter(f => f.includes(action.target)).slice(0, 500)) {
          let source;
          try {
            source = await load(file);
          } catch {
            continue;
          }
          for (const [i, line] of source.content.split('\n').entries()) {
            if (line.toLowerCase().includes(action.value.toLowerCase()))
              matches.push({ path: file, line: i + 1, text: line.slice(0, 240), sha256: source.sha256 });
            if (matches.length >= 30) return { matches, truncated: true };
          }
        }
        return { matches, truncated: false, scope: 'First 500 matching inventory files; search is bounded.' };
      }
      throw new Error('Unsupported source action.');
    },
  };
}
