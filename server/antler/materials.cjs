// Shared materials library — a folder on disk that the boss can browse in the UI
// and OpenClaw agents can read/write via absolute paths.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('./store');

const IMG_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'webm', 'avi', 'mkv', 'm4v']);
const PDF_EXTS = new Set(['pdf']);
const DOC_EXTS = new Set(['doc', 'docx', 'rtf', 'odt']);
const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'yaml', 'yml', 'csv', 'xml', 'html', 'htm',
  'js', 'ts', 'tsx', 'jsx', 'vue', 'css', 'scss', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'sh',
]);

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  m4v: 'video/x-m4v',
};

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

function defaultRoot() {
  const fromEnv = process.env.ANTLEROFFICE_MATERIALS_DIR;
  if (fromEnv && String(fromEnv).trim()) {
    return path.resolve(expandHome(String(fromEnv).trim()));
  }
  return path.join(store.getDataDir(), 'materials');
}

function ensureDefaultMaterialsRoot() {
  const settings = store.readSettings();
  const configured = String(settings.materials?.rootPath || '').trim();
  if (configured) {
    const abs = path.resolve(expandHome(configured));
    store.ensureDir(abs);
    return abs;
  }
  const root = defaultRoot();
  store.ensureDir(root);
  settings.materials = { ...(settings.materials || {}), rootPath: root };
  store.writeSettings(settings);
  return root;
}

function getRootPath() {
  return ensureDefaultMaterialsRoot();
}

function resetToDefaultRoot() {
  const root = defaultRoot();
  store.ensureDir(root);
  const settings = store.readSettings();
  settings.materials = { ...(settings.materials || {}), rootPath: root };
  store.writeSettings(settings);
  return { ok: true, rootPath: root };
}

function setRootPath(nextPath) {
  const trimmed = String(nextPath || '').trim();
  if (!trimmed) {
    return { ok: false, error: 'Path is required' };
  }
  const abs = path.resolve(expandHome(trimmed));
  try {
    store.ensureDir(abs);
    if (!fs.statSync(abs).isDirectory()) {
      return { ok: false, error: 'Path must be a folder' };
    }
  } catch (e) {
    return { ok: false, error: e.message || 'Could not access folder' };
  }
  const settings = store.readSettings();
  settings.materials = { ...(settings.materials || {}), rootPath: abs };
  store.writeSettings(settings);
  return { ok: true, rootPath: abs };
}

function safePath(relPath, root) {
  const base = path.resolve(root);
  const target = path.resolve(base, relPath || '');
  if (!target.toLowerCase().startsWith(base.toLowerCase())) return null;
  return target;
}

function relFromAbs(absPath, root) {
  const rel = path.relative(root, absPath);
  return rel.replace(/\\/g, '/');
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function fileKind(ext, isDirectory) {
  if (isDirectory) return 'Folder';
  const e = String(ext || '').toLowerCase();
  if (IMG_EXTS.has(e)) return 'Image';
  if (VIDEO_EXTS.has(e)) return 'Video';
  if (PDF_EXTS.has(e)) return 'PDF';
  if (DOC_EXTS.has(e)) return 'Document';
  if (TEXT_EXTS.has(e)) return 'Text';
  if (e) return e.toUpperCase();
  return 'File';
}

function entryFromStat(name, rel, stat, isDirectory) {
  const ext = isDirectory ? '' : path.extname(name).slice(1).toLowerCase();
  return {
    name,
    path: rel.replace(/\\/g, '/'),
    type: isDirectory ? 'directory' : 'file',
    extension: ext,
    kind: fileKind(ext, isDirectory),
    size: stat.size || 0,
    sizeLabel: isDirectory ? '—' : formatSize(stat.size || 0),
    updatedAtMs: stat.mtimeMs || 0,
    mimeType: isDirectory ? '' : (MIME_BY_EXT[ext] || 'application/octet-stream'),
    previewable: isDirectory
      ? false
      : IMG_EXTS.has(ext) || VIDEO_EXTS.has(ext) || PDF_EXTS.has(ext) || TEXT_EXTS.has(ext),
  };
}

function listDir(relPath = '') {
  const root = getRootPath();
  const abs = safePath(relPath, root);
  if (!abs) return { ok: false, error: 'Invalid path' };

  if (!fs.existsSync(abs)) {
    return {
      ok: true,
      rootPath: root,
      path: relPath.replace(/\\/g, '/'),
      absolutePath: abs,
      entries: [],
    };
  }

  const stat = fs.statSync(abs);
  if (!stat.isDirectory()) {
    return { ok: false, error: 'Not a directory' };
  }

  const entries = fs.readdirSync(abs, { withFileTypes: true }).map((entry) => {
    const full = path.join(abs, entry.name);
    const rel = relPath ? `${relPath.replace(/\\/g, '/')}/${entry.name}` : entry.name;
    let s = { size: 0, mtimeMs: 0 };
    try {
      s = fs.statSync(full);
    } catch {
      /* ignore */
    }
    return entryFromStat(entry.name, rel, s, entry.isDirectory());
  });

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  return {
    ok: true,
    rootPath: root,
    path: relPath.replace(/\\/g, '/'),
    absolutePath: abs,
    entries,
  };
}

function statEntry(relPath) {
  const root = getRootPath();
  const abs = safePath(relPath, root);
  if (!abs || !fs.existsSync(abs)) return { ok: false, error: 'Not found' };
  const s = fs.statSync(abs);
  const name = path.basename(abs);
  const rel = relFromAbs(abs, root);
  const entry = entryFromStat(name, rel, s, s.isDirectory());
  return {
    ok: true,
    rootPath: root,
    entry: {
      ...entry,
      absolutePath: abs,
      createdAtMs: s.birthtimeMs || s.ctimeMs,
    },
  };
}

function resolveGetPath(relPath) {
  const root = getRootPath();
  const abs = safePath(relPath, root);
  if (!abs || !fs.existsSync(abs)) return { ok: false, error: 'Not found' };
  const s = fs.statSync(abs);
  if (s.isDirectory()) return { ok: false, error: 'Cannot read directory' };
  const ext = path.extname(abs).slice(1).toLowerCase();
  return { ok: true, root, abs, stat: s, ext, relPath: relFromAbs(abs, root) };
}

function readFileMeta(relPath) {
  const resolved = resolveGetPath(relPath);
  if (!resolved.ok) return resolved;
  const { abs, stat, ext, relPath: rel } = resolved;
  const name = path.basename(abs);

  if (IMG_EXTS.has(ext)) {
    const buffer = fs.readFileSync(abs);
    return {
      ok: true,
      file: {
        name,
        path: rel,
        content: buffer.toString('base64'),
        isBase64: true,
        size: stat.size,
        updatedAtMs: stat.mtimeMs,
        extension: ext,
        kind: fileKind(ext, false),
        mimeType: MIME_BY_EXT[ext] || 'application/octet-stream',
      },
    };
  }

  if (VIDEO_EXTS.has(ext) || PDF_EXTS.has(ext) || DOC_EXTS.has(ext)) {
    return {
      ok: true,
      file: {
        name,
        path: rel,
        binary: true,
        size: stat.size,
        updatedAtMs: stat.mtimeMs,
        extension: ext,
        kind: fileKind(ext, false),
        mimeType: MIME_BY_EXT[ext] || 'application/octet-stream',
      },
    };
  }

  try {
    const content = fs.readFileSync(abs, 'utf8');
    return {
      ok: true,
      file: {
        name,
        path: rel,
        content,
        size: stat.size,
        updatedAtMs: stat.mtimeMs,
        extension: ext,
        kind: fileKind(ext, false),
        mimeType: 'text/plain',
      },
    };
  } catch {
    return {
      ok: true,
      file: {
        name,
        path: rel,
        binary: true,
        size: stat.size,
        updatedAtMs: stat.mtimeMs,
        extension: ext,
        kind: fileKind(ext, false),
        mimeType: 'application/octet-stream',
      },
    };
  }
}

function mkdir(relPath) {
  const root = getRootPath();
  const abs = safePath(relPath, root);
  if (!abs) return { ok: false, error: 'Invalid path' };
  if (fs.existsSync(abs)) return { ok: false, error: 'Already exists' };
  fs.mkdirSync(abs, { recursive: true });
  return { ok: true, path: relPath.replace(/\\/g, '/') };
}

function remove(relPath) {
  const root = getRootPath();
  const abs = safePath(relPath, root);
  if (!abs) return { ok: false, error: 'Invalid path' };
  if (abs === root) return { ok: false, error: 'Cannot delete library root' };
  if (!fs.existsSync(abs)) return { ok: false, error: 'Not found' };

  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    fs.rmSync(abs, { recursive: true, force: true });
  } else {
    fs.unlinkSync(abs);
  }
  return { ok: true };
}

function uniqueDestPath(dirAbs, baseName, ext) {
  let dest = path.join(dirAbs, `${baseName}${ext}`);
  if (!fs.existsSync(dest)) return dest;
  let i = 2;
  while (fs.existsSync(dest)) {
    dest = path.join(dirAbs, `${baseName} copy ${i}${ext}`);
    i += 1;
  }
  return dest;
}

function duplicate(relPath) {
  const root = getRootPath();
  const srcAbs = safePath(relPath, root);
  if (!srcAbs || !fs.existsSync(srcAbs)) return { ok: false, error: 'Not found' };
  const stat = fs.statSync(srcAbs);
  const dir = path.dirname(srcAbs);
  const ext = path.extname(srcAbs);
  const base = path.basename(srcAbs, ext);
  const destAbs = uniqueDestPath(dir, `${base} copy`, ext);

  if (stat.isDirectory()) {
    fs.cpSync(srcAbs, destAbs, { recursive: true });
  } else {
    fs.copyFileSync(srcAbs, destAbs);
  }
  return { ok: true, path: relFromAbs(destAbs, root) };
}

function move(fromPath, toPath) {
  const root = getRootPath();
  const srcAbs = safePath(fromPath, root);
  if (!srcAbs || !fs.existsSync(srcAbs)) return { ok: false, error: 'Source not found' };
  if (srcAbs === root) return { ok: false, error: 'Cannot move library root' };

  let destAbs = safePath(toPath, root);
  if (!destAbs) return { ok: false, error: 'Invalid destination' };

  if (fs.existsSync(destAbs) && fs.statSync(destAbs).isDirectory()) {
    destAbs = path.join(destAbs, path.basename(srcAbs));
  }

  if (destAbs.toLowerCase().startsWith(`${srcAbs.toLowerCase()}${path.sep}`)) {
    return { ok: false, error: 'Cannot move a folder into itself' };
  }
  if (fs.existsSync(destAbs)) return { ok: false, error: 'Destination already exists' };

  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.renameSync(srcAbs, destAbs);
  return { ok: true, from: fromPath, to: relFromAbs(destAbs, root) };
}

function paste({ mode, fromPath, toDir }) {
  const root = getRootPath();
  const srcAbs = safePath(fromPath, root);
  const dirAbs = safePath(toDir || '', root);
  if (!srcAbs || !fs.existsSync(srcAbs)) return { ok: false, error: 'Source not found' };
  if (!dirAbs || !fs.existsSync(dirAbs) || !fs.statSync(dirAbs).isDirectory()) {
    return { ok: false, error: 'Destination folder not found' };
  }

  const name = path.basename(srcAbs);
  const destAbs = path.join(dirAbs, name);
  if (mode === 'cut') {
    if (fs.existsSync(destAbs)) return { ok: false, error: 'Destination already exists' };
    fs.renameSync(srcAbs, destAbs);
    return { ok: true, mode, path: relFromAbs(destAbs, root) };
  }

  const ext = path.extname(name);
  const base = path.basename(name, ext);
  const copyAbs = uniqueDestPath(dirAbs, base, ext);
  const stat = fs.statSync(srcAbs);
  if (stat.isDirectory()) {
    fs.cpSync(srcAbs, copyAbs, { recursive: true });
  } else {
    fs.copyFileSync(srcAbs, copyAbs);
  }
  return { ok: true, mode: 'copy', path: relFromAbs(copyAbs, root) };
}

function writeUploadedFile(relDir, fileName, buffer) {
  const root = getRootPath();
  const parentRel = String(relDir || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const safeName = path.basename(String(fileName || '').trim());
  if (!safeName) return { ok: false, error: 'File name required' };

  const rel = parentRel ? `${parentRel}/${safeName}` : safeName;
  const abs = safePath(rel, root);
  if (!abs) return { ok: false, error: 'Invalid path' };

  const parentAbs = path.dirname(abs);
  store.ensureDir(parentAbs);

  const ext = path.extname(safeName);
  const base = path.basename(safeName, ext);
  const destAbs = uniqueDestPath(parentAbs, base, ext);
  fs.writeFileSync(destAbs, buffer);

  const stat = fs.statSync(destAbs);
  const relOut = relFromAbs(destAbs, root);
  const name = path.basename(destAbs);
  return {
    ok: true,
    path: relOut,
    name,
    size: stat.size,
    sizeLabel: formatSize(stat.size),
    updatedAtMs: stat.mtimeMs,
  };
}

function workspaceInfo() {
  const def = defaultRoot();
  const root = getRootPath();
  return {
    ok: true,
    rootPath: root,
    defaultRoot: def,
    isDefaultRoot: path.resolve(root).toLowerCase() === path.resolve(def).toLowerCase(),
    dataDir: store.getDataDir(),
    openclawHint: `Use absolute paths under ${root}.`,
  };
}

function walkLibrary(dirAbs, stats) {
  let entries;
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = path.join(dirAbs, entry.name);
    try {
      if (entry.isDirectory()) {
        stats.folderCount += 1;
        walkLibrary(full, stats);
      } else if (entry.isFile()) {
        stats.fileCount += 1;
        const s = fs.statSync(full);
        stats.totalBytes += s.size || 0;
      }
    } catch {
      /* skip unreadable entries */
    }
  }
}

function librarySummary() {
  const root = getRootPath();
  const stats = { fileCount: 0, folderCount: 0, totalBytes: 0 };
  if (fs.existsSync(root)) {
    walkLibrary(root, stats);
  }
  return {
    ok: true,
    rootPath: root,
    fileCount: stats.fileCount,
    folderCount: stats.folderCount,
    totalBytes: stats.totalBytes,
    totalSizeLabel: formatSize(stats.totalBytes),
  };
}

module.exports = {
  ensureDefaultMaterialsRoot,
  getRootPath,
  setRootPath,
  resetToDefaultRoot,
  defaultRoot,
  listDir,
  statEntry,
  resolveGetPath,
  readFileMeta,
  mkdir,
  remove,
  duplicate,
  move,
  paste,
  writeUploadedFile,
  workspaceInfo,
  librarySummary,
  MIME_BY_EXT,
  IMG_EXTS,
  VIDEO_EXTS,
  PDF_EXTS,
};
