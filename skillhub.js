#!/usr/bin/env node
'use strict';

/*
 * skillhub - maintain ONE global skill store shared by every AI agent harness
 *             on a Windows + WSL machine.
 *
 * Canonical store : <user profile>\.agents\skills              (Windows)
 *                   /mnt/c/<user>/.agents/skills               (same dir, seen from WSL)
 *
 * Every agent root (Windows: NTFS junction, Ubuntu: symlink) points at that
 * one store, so installing a skill once makes it available to all harnesses.
 *
 * Paths come from config.json next to this script. Placeholders are expanded
 * there, so the same file works on any machine:
 *   %VAR%   -> environment variable (e.g. %USERPROFILE%)
 *   $VAR    -> environment variable        ${VAR} -> environment variable
 *   ~       -> your home directory
 *
 * No npm dependencies. Node built-ins only (fs, path, os, child_process).
 * Requires Node >= 16.
 *
 * Commands:
 *   status            show canonical store + every target (no side effects)
 *   list              list skill names in the canonical store
 *   install <pkg>     npx -y skills add <pkg> -s '*' -g -y  then repair + status
 *   remove <name>     remove ONE skill folder from the canonical store
 *   repair            restore every target (merge unique skills, never delete)
 *   doctor            PASS/FAIL health checks
 *   install-launcher  install ~/.local/bin/skillhub inside WSL
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const SELF_DIR = __dirname;
const CONFIG_FILE = path.join(SELF_DIR, 'config.json');
const LINUX_HELPER_SRC = path.join(SELF_DIR, 'skillhub-linux.sh');
const LINUX_LAUNCHER_SRC = path.join(SELF_DIR, 'skillhub-linux-launcher.sh');

/* ------------------------------------------------------------------ */
/* config                                                              */
/* ------------------------------------------------------------------ */

function expandPath(p) {
  if (p === undefined || p === null) return p;
  let s = String(p);
  // %VAR% (Windows style)
  s = s.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, n) =>
    (process.env[n] !== undefined ? process.env[n] : m));
  // ${VAR} and $VAR (POSIX style)
  s = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, n) =>
    (process.env[n] !== undefined ? process.env[n] : m));
  s = s.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, n) =>
    (process.env[n] !== undefined ? process.env[n] : m));
  // ~ -> home
  if (s === '~') s = os.homedir();
  else if (s.startsWith('~/') || s.startsWith('~\\')) {
    s = path.join(os.homedir(), s.slice(2));
  }
  return s;
}

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '');
  const c = JSON.parse(raw);
  c.canonical = path.resolve(expandPath(c.canonical));
  c.canonicalParent = path.dirname(c.canonical);
  c.windowsTargets = (c.windowsTargets || []).map((p) => path.resolve(expandPath(p)));
  c.ubuntuTargets = (c.ubuntuTargets || []).map((p) => expandPath(p));
  for (const k of ['canonicalLinux', 'linuxHome', 'linuxBinDir', 'linuxLauncher', 'linuxHelper']) {
    if (c[k]) c[k] = expandPath(c[k]);
  }
  return c;
}

const cfg = loadConfig();

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

const C = {
  reset: '\u001b[0m', bold: '\u001b[1m', dim: '\u001b[2m',
  red: '\u001b[31m', green: '\u001b[32m', yellow: '\u001b[33m', cyan: '\u001b[36m'
};
const useColor = !!process.stdout.isTTY && process.env.NO_COLOR !== '1';
function col(s, c) { return useColor ? c + s + C.reset : s; }
function pad(s, n) { s = String(s); return s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length); }
function padL(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }

function normKey(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
function safeRealpath(p) {
  try { return fs.realpathSync(p); } catch (e) { return null; }
}
function safeLstat(p) {
  try { return fs.lstatSync(p); } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    return null;
  }
}
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/* ------------------------------------------------------------------ */
/* skill discovery                                                     */
/* ------------------------------------------------------------------ */

/** Names of the folders inside `dir` that contain a SKILL.md (= "skills"). */
function skillFolderNames(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    try {
      if (fs.statSync(path.join(dir, e.name, 'SKILL.md')).isFile()) out.push(e.name);
    } catch (e) { /* not a skill folder */ }
  }
  return out.sort();
}

/** Names of every directory inside `dir` (skills or not). */
function allFolderNames(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name).sort();
  } catch (e) { return []; }
}

/* ================================================================== */
/* LINK / JUNCTION DETECTION  -  ONE DOCUMENTED METHOD                 */
/* ================================================================== */
/*
 * An entry is a LINK (junction or symlink) iff the operating system resolves
 * it to a DIFFERENT physical path than the entry's own path:
 *
 *     isLink(p)  <=>  fs.realpathSync(p) !== fs.realpathSync(path.resolve(p))
 *
 * Why this and not fs.lstatSync(p).isSymbolicLink()?
 *   On Windows that call is version dependent for JUNCTIONS: libuv (Node < 22)
 *   reports a junction (IO_REPARSE_TAG_MOUNT_POINT) as a plain directory
 *   -> isSymbolicLink() === false, while newer libuv reports it as a symlink
 *   -> isSymbolicLink() === true (verified on this machine, Node v23.6.1).
 *   The realpath comparison is identical on every Node >= 16 AND it also
 *   tells us *where* the link points, which the repair logic needs.
 *
 * Fallback: if realpath throws (dangling link whose target is gone) the entry
 * is still a link when fs.readlinkSync(p) succeeds.
 *
 * The "junction vs symlink" label used in the status table is cosmetic and is
 * taken from the OS reparse tag (`fsutil reparsepoint query`): a junction
 * reports "Mount Point", a symlink reports "Name Surrogate" only.
 * It never influences repair, which only needs "link that resolves to the
 * canonical store" vs "real directory".
 */
function isLinkPath(p) {
  const rp = safeRealpath(p);
  if (rp !== null && normKey(rp) !== normKey(path.resolve(p))) return true;
  try { fs.readlinkSync(p); return true; } catch (e) { /* not a link */ }
  return false;
}

/** 'junction' | 'symlink' | null (null = unknown / not a reparse point) */
function reparseKind(p) {
  const r = spawnSync('fsutil', ['reparsepoint', 'query', p], {
    encoding: 'utf8', windowsHide: true
  });
  if (r.error || r.status !== 0 || !r.stdout) return null;
  const out = r.stdout.toLowerCase();
  if (out.indexOf('mount point') !== -1) return 'junction';
  if (out.indexOf('name surrogate') !== -1) return 'symlink';
  return null;
}

/**
 * Classify one target path.
 * kind: 'junction' | 'symlink' | 'dir' | 'missing'
 */
function classify(p, canonicalReal) {
  const lst = safeLstat(p);
  if (!lst) {
    return {
      path: p, kind: 'missing', exists: false, isLink: false,
      realpath: null, resolves: false, skills: 0, skillNames: [],
      detail: 'missing'
    };
  }
  const isLink = isLinkPath(p);
  const rp = safeRealpath(p);
  let kind;
  if (!isLink) {
    kind = 'dir';
  } else {
    const tag = reparseKind(p);
    kind = tag || (lst.isSymbolicLink() ? 'symlink' : 'junction');
  }
  const resolves = rp !== null && normKey(rp) === normKey(canonicalReal);
  const names = skillFolderNames(p);
  let detail = '';
  if (kind === 'dir') detail = 'plain directory - should be a link to the canonical store';
  else if (kind === 'missing') detail = 'missing';
  else if (!rp) detail = 'dangling link - target does not exist';
  else if (!resolves) detail = 'points to ' + rp + ' (not the canonical store)';
  else detail = '-> ' + rp;
  return {
    path: p, kind, exists: true, isLink, realpath: rp, resolves,
    skills: names.length, skillNames: names, detail
  };
}

/* ------------------------------------------------------------------ */
/* recursive copy (no fs.cpSync: keeps Node 16 compatibility)         */
/* ------------------------------------------------------------------ */

function copyTree(src, dst) {
  const st = fs.lstatSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      copyTree(path.join(src, e.name), path.join(dst, e.name));
    }
  } else if (st.isSymbolicLink()) {
    try { fs.unlinkSync(dst); } catch (e) { /* not there */ }
    fs.symlinkSync(fs.readlinkSync(src), dst);
  } else {
    // never clobber an existing file: the canonical copy wins
    if (fs.existsSync(dst)) return;
    fs.copyFileSync(src, dst);
  }
}

/* ------------------------------------------------------------------ */
/* WSL delegation                                                      */
/* ------------------------------------------------------------------ */

/**
 * Run a subcommand of the Linux helper inside the WSL distro.
 * Command shape (as documented):
 *   wsl.exe -d <distro> -- bash /mnt/c/Users/ADMIN/.skillhub/skillhub-linux.sh <subcommand>
 */
function runLinux(subcommand) {
  const r = spawnSync('wsl.exe', ['-d', cfg.distro, '--', 'bash', cfg.linuxHelper, subcommand], {
    encoding: 'utf8', windowsHide: true
  });
  return {
    ok: !r.error && r.status === 0,
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error ? r.error.message : ''
  };
}

/** Parse the TSV the linux helper prints. */
function parseLinuxTsv(stdout) {
  const rows = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    rows.push(line.split('\t'));
  }
  return rows;
}

/* ================================================================== */
/* command: status                                                     */
/* ================================================================== */

function cmdStatus() {
  const canonReal = safeRealpath(cfg.canonical) || cfg.canonical;
  const canonSkills = skillFolderNames(cfg.canonical);
  const canonAll = allFolderNames(cfg.canonical);

  console.log('skillhub status');
  console.log('');
  console.log('canonical store : ' + cfg.canonical);
  console.log('  skills        : ' + canonSkills.length + '  (folders containing SKILL.md)');
  console.log('  all folders   : ' + canonAll.length);
  console.log('  lock file     : ' + cfg.lockFile +
    '  [' + (fs.existsSync(cfg.lockFile) ? 'present' : 'MISSING') + ']');
  console.log('');
  console.log('WINDOWS TARGETS');
  console.log('  ' + pad('STATUS', 8) + pad('KIND', 9) + padL('SKILLS', 7) + '  PATH');
  let winBad = 0;
  for (const t of cfg.windowsTargets) {
    const c = classify(t, canonReal);
    if (!c.resolves) winBad++;
    console.log('  ' + pad(c.resolves ? 'OK' : 'BROKEN', 8) +
      pad(c.kind, 9) + padL(String(c.skills), 7) + '  ' + t +
      (c.resolves ? '' : '   <- ' + c.detail));
  }

  console.log('');
  console.log('UBUNTU TARGETS (' + cfg.distro + ')');
  console.log('  ' + pad('STATUS', 8) + pad('KIND', 9) + padL('SKILLS', 7) + '  PATH');
  let linBad = 0;
  const lin = runLinux('status');
  if (!lin.ok && !lin.stdout) {
    console.log('  ' + pad('UNKNOWN', 8) + pad('-', 9) + padL('-', 7) +
      '  (cannot reach WSL: ' + (lin.error || 'exit ' + lin.status) + ')');
    linBad = cfg.ubuntuTargets.length;
  } else {
    const rows = parseLinuxTsv(lin.stdout);
    let seen = 0;
    for (const row of rows) {
      if (row[0] !== 'TARGET') continue;
      const [, p, kind, state, skills, detail] = row;
      seen++;
      if (state !== 'OK') linBad++;
      console.log('  ' + pad(state, 8) + pad(kind, 9) + padL(skills, 7) + '  ' + p +
        (state === 'OK' ? '' : '   <- ' + (detail || '')));
    }
    if (seen !== cfg.ubuntuTargets.length) {
      linBad += (cfg.ubuntuTargets.length - seen);
      console.log('  ' + pad('MISSING', 8) + pad('-', 9) + padL('-', 7) +
        '  (' + (cfg.ubuntuTargets.length - seen) + ' target(s) not reported by the linux helper)');
    }
  }

  console.log('');
  console.log('summary: ' + (cfg.windowsTargets.length - winBad) + '/' + cfg.windowsTargets.length +
    ' windows targets OK, ' + (cfg.ubuntuTargets.length - linBad) + '/' + cfg.ubuntuTargets.length +
    ' ubuntu targets OK, canonical store holds ' + canonSkills.length + ' skills');
  const bad = winBad + linBad;
  if (bad > 0) {
    console.log(col('action needed: run "skillhub repair"', C.yellow));
    process.exitCode = 1;
  }
}

/* ================================================================== */
/* command: list                                                       */
/* ================================================================== */

function cmdList() {
  const names = skillFolderNames(cfg.canonical);
  for (const n of names) console.log(n);
}

/* ================================================================== */
/* command: install                                                    */
/* ================================================================== */

function cmdInstall(pkg) {
  if (!pkg) {
    console.error('usage: skillhub install <owner/repo[@skill]>');
    process.exitCode = 2;
    return;
  }
  // "<owner/repo>@<skill>" -> install that one skill only.
  // "@scope/pkg" is an npm scope, not a skill qualifier.
  const at = pkg.indexOf('@');
  const hasSkillQualifier = at > 0 && pkg.indexOf('@', at + 1) === -1;
  const target = hasSkillQualifier ? pkg : pkg;
  const skillSel = hasSkillQualifier ? '' : '-s "*"';
  const cmd = 'npx -y skills add ' + target + ' ' + skillSel + ' -g -y'.replace(/\s+/g, ' ').trim();

  console.log('$ ' + cmd + '   (cwd: ' + cfg.canonicalParent + ')');
  const r = spawnSync(cmd, {
    cwd: cfg.canonicalParent,
    shell: true,
    stdio: 'inherit',
    windowsHide: true
  });
  if (r.error) {
    console.error(col('install failed: ' + r.error.message, C.red));
    process.exitCode = 1;
    return;
  }
  if (r.status !== 0) {
    console.error(col('install failed with exit code ' + r.status, C.red));
    process.exitCode = r.status || 1;
    return;
  }
  console.log('');
  console.log('install finished - repairing targets (a skills install can replace a junction with a real dir)');
  console.log('');
  cmdRepair({ quiet: true });
  console.log('');
  cmdStatus();
}

/* ================================================================== */
/* command: remove                                                     */
/* ================================================================== */

function cmdRemove(name) {
  if (!name) {
    console.error('usage: skillhub remove <skill-folder-name>');
    process.exitCode = 2;
    return;
  }
  const dir = path.resolve(cfg.canonical, name);
  if (!isInside(cfg.canonical, dir)) {
    console.error(col('refusing: ' + name + ' is outside the canonical store', C.red));
    process.exitCode = 2;
    return;
  }
  const lst = safeLstat(dir);
  if (!lst) {
    console.error(col('no such skill folder in the canonical store: ' + name, C.red));
    process.exitCode = 1;
    return;
  }
  if (!lst.isDirectory()) {
    console.error(col('refusing to remove ' + name + ': not a directory', C.red));
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) {
    console.error(col('refusing to remove ' + name + ': it has no SKILL.md (not a skill folder)', C.red));
    process.exitCode = 1;
    return;
  }
  if (lst.isSymbolicLink()) {
    fs.unlinkSync(dir);
  } else {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('removed skill folder : ' + dir);
  console.log('every agent harness that points at the canonical store has lost this skill immediately.');
}

/* ================================================================== */
/* command: repair                                                     */
/* ================================================================== */

function createJunction(link, target) {
  // NOTE: cmd.exe is used with shell:true on purpose.  Passing the quotes as
  // separate argv entries makes node re-escape them and mklink then receives
  // literal \" characters -> "The filename, directory name, or volume label
  // syntax is incorrect".  With shell:true node runs
  //   cmd.exe /d /s /c "<command>"
  // and /s strips only the outer quotes, so the inner ones survive as
  // ordinary argument quoting.
  const r = spawnSync('mklink /J "' + link + '" "' + target + '"', {
    shell: true,
    encoding: 'utf8',
    windowsHide: true
  });
  if (r.error || r.status !== 0) {
    return { ok: false, message: (r.stderr || r.stdout || r.error || '').toString().trim() };
  }
  return { ok: true, message: (r.stdout || '').toString().trim() };
}

/**
 * Replace a plain directory with a junction to the canonical store.
 * Unique skill folders must already have been copied into the canonical store
 * by the caller - this function never deletes skill content: the directory is
 * MOVED ASIDE first and only discarded when every skill folder it holds is
 * present in the canonical store.
 */
function replacePlainDirWithJunction(dir, canonical) {
  const parent = path.dirname(dir);
  const base = path.basename(dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(parent, '.' + base + '.skillhub-backup-' + stamp);

  // 1. move aside (never deletes anything)
  try {
    fs.renameSync(dir, backup);
  } catch (e) {
    // could not move it aside -> last resort: recursive delete of a REAL dir
    // (safe here: isLink() was false, so this is a genuine directory)
    const rm = spawnSync('rmdir /s /q "' + dir + '"', {
      shell: true,
      encoding: 'utf8',
      windowsHide: true
    });
    if (rm.error || rm.status !== 0) {
      return { ok: false, message: 'could not move directory aside: ' + e.message };
    }
    const j = createJunction(dir, canonical);
    return j.ok
      ? { ok: true, message: 'directory removed and replaced by junction', backup: null }
      : { ok: false, message: j.message };
  }

  // 2. create the junction
  const j = createJunction(dir, canonical);
  if (!j.ok) {
    // restore the original directory
    try { fs.renameSync(backup, dir); } catch (e) { /* leave the backup in place */ }
    return { ok: false, message: 'could not create junction: ' + j.message };
  }

  // 3. discard the backup only when everything it holds is already in the store
  const backupSkills = skillFolderNames(backup);
  const canonSkills = skillFolderNames(canonical);
  const canonSet = new Set(canonSkills);
  const missing = backupSkills.filter((n) => !canonSet.has(n));
  const leftovers = allFolderNames(backup).filter((n) => backupSkills.indexOf(n) === -1);
  if (missing.length === 0) {
    fs.rmSync(backup, { recursive: true, force: true });
    return { ok: true, message: 'plain directory replaced by junction', backup: null, leftovers: leftovers };
  }
  return {
    ok: true,
    message: 'plain directory replaced by junction',
    backup: backup,
    leftovers: leftovers,
    missing: missing
  };
}

function cmdRepair(opts) {
  opts = opts || {};
  const quiet = !!opts.quiet;
  const say = (s) => { if (!quiet) console.log(s); };

  const canonReal = safeRealpath(cfg.canonical) || cfg.canonical;
  const canonNames = new Set(skillFolderNames(cfg.canonical));
  let changes = 0;

  if (!quiet) console.log('skillhub repair');
  if (!quiet) console.log('');

  /* ---- Windows targets ---- */
  if (!quiet) console.log('windows targets');
  for (const t of cfg.windowsTargets) {
    const c = classify(t, canonReal);
    if (c.kind === 'missing') {
      const j = createJunction(t, cfg.canonical);
      if (j.ok) {
        changes++;
        say('  fixed    ' + t + '  (missing -> junction)');
      } else {
        say(col('  ERROR    ' + t + '  could not create junction: ' + j.message, C.red));
      }
      continue;
    }
    if (c.isLink) {
      if (c.resolves) {
        say('  ok       ' + t + '  (' + c.kind + ' -> canonical store)');
      } else {
        say(col('  warn     ' + t + '  (' + c.detail + ') - left untouched', C.yellow));
      }
      continue;
    }
    // plain directory
    const unique = c.skillNames.filter((n) => !canonNames.has(n));
    const sameName = c.skillNames.filter((n) => canonNames.has(n));
    for (const n of unique) {
      copyTree(path.join(t, n), path.join(cfg.canonical, n));
      canonNames.add(n);
      changes++;
      say('  copied   ' + n + '  (unique skill folder from ' + t + ' -> canonical store)');
    }
    if (sameName.length) {
      say('  note     ' + t + '  (' + sameName.length + ' skill folders already exist in the canonical store, canonical copy kept)');
    }
    const r = replacePlainDirWithJunction(t, cfg.canonical);
    if (r.ok) {
      changes++;
      say('  fixed    ' + t + '  (plain directory -> junction)');
      if (r.backup) {
        say(col('  note     backup kept (contains skills not in the canonical store): ' + r.backup, C.yellow));
      }
      if (r.leftovers && r.leftovers.length) {
        say(col('  note     non-skill folders were kept in the backup: ' + r.leftovers.join(', '), C.yellow));
      }
    } else {
      say(col('  ERROR    ' + t + '  ' + r.message, C.red));
    }
  }

  /* ---- Ubuntu targets (delegated) ---- */
  if (!quiet) console.log('');
  if (!quiet) console.log('ubuntu targets (' + cfg.distro + ')');
  const lin = runLinux('repair');
  if (lin.error || (!lin.ok && !lin.stdout)) {
    say(col('  ERROR    cannot reach WSL: ' + (lin.error || ('exit ' + lin.status)), C.red));
  } else {
    for (const line of lin.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const row = line.split('\t');
      const action = row[2] || '';
      if (action === 'copied' || action === 'fixed') changes++;
      const marker = action === 'error' ? col('  ERROR  ', C.red)
        : (action === 'warn' ? col('  warn   ', C.yellow)
          : (action === 'copied' ? col('  copied ', C.cyan) : '  ' + pad(action, 8)));
      say(marker + ' ' + row[1] + '  ' + (row[3] || ''));
    }
    if (lin.stderr.trim()) {
      for (const l of lin.stderr.split(/\r?\n/)) if (l.trim()) say(col('  ' + l.trim(), C.yellow));
    }
    if (!lin.ok) {
      say(col('  ERROR    the linux helper exited with code ' + lin.status, C.red));
    }
  }

  if (!quiet) {
    console.log('');
    console.log(changes === 0
      ? 'repair finished: no changes needed (everything already correct)'
      : 'repair finished: ' + changes + ' change(s) applied');
  }
  return changes;
}

/* ================================================================== */
/* command: doctor                                                     */
/* ================================================================== */

function cmdDoctor() {
  const results = [];
  const canonReal = safeRealpath(cfg.canonical) || cfg.canonical;

  // 1. canonical store readable
  let ok1 = false, d1 = '';
  try {
    const names = skillFolderNames(cfg.canonical);
    fs.accessSync(cfg.canonical, fs.constants.R_OK);
    ok1 = names.length > 0;
    d1 = cfg.canonical + ' is readable and holds ' + names.length + ' skills';
  } catch (e) {
    d1 = 'cannot read ' + cfg.canonical + ': ' + e.message;
  }
  results.push(['canonical store readable', ok1, d1]);

  // 2. windows lock file
  const ok2 = fs.existsSync(cfg.lockFile);
  results.push(['windows lock file present', ok2, cfg.lockFile + (ok2 ? '' : ' (MISSING)')]);

  // 3. ubuntu launcher present and executable
  const lchk = spawnSync('wsl.exe', ['-d', cfg.distro, '--', 'test', '-x', cfg.linuxLauncher], {
    windowsHide: true
  });
  const ok3 = !lchk.error && lchk.status === 0;
  results.push(['ubuntu launcher installed', ok3,
    cfg.linuxLauncher + ' on ' + cfg.distro + (ok3 ? '' : ' (missing or not executable)')]);

  // 4. every windows target resolves to the canonical store
  const badWin = [];
  for (const t of cfg.windowsTargets) {
    const c = classify(t, canonReal);
    if (!c.resolves) badWin.push(t + ' (' + c.kind + ')');
  }
  results.push(['all ' + cfg.windowsTargets.length + ' windows targets resolve to the canonical store',
    badWin.length === 0,
    badWin.length === 0 ? 'every target is a link to ' + cfg.canonical
      : 'BROKEN: ' + badWin.join(', ')]);

  // 5. every ubuntu target resolves to the canonical store
  const vchk = runLinux('verify');
  const vrows = parseLinuxTsv(vchk.stdout).filter((r) => r[0] === 'VERIFY');
  const badLin = vrows.filter((r) => r[2] !== 'OK').map((r) => r[1]);
  const ok5 = vchk.ok && badLin.length === 0 && vrows.length === cfg.ubuntuTargets.length;
  results.push(['all ' + cfg.ubuntuTargets.length + ' ubuntu targets resolve to the canonical store',
    ok5,
    ok5 ? 'every target is a symlink to ' + cfg.canonicalLinux
      : 'BROKEN: ' + (badLin.length ? badLin.join(', ') : 'the linux helper could not be reached')]);

  // 6. ubuntu target count matches the canonical count
  const st = runLinux('status');
  const srows = parseLinuxTsv(st.stdout);
  const cRow = srows.find((r) => r[0] === 'CANONICAL');
  const linCount = cRow ? Number(cRow[2]) : NaN;
  const winCount = skillFolderNames(cfg.canonical).length;
  const ok6 = cRow && linCount === winCount;
  results.push(['windows and WSL see the same skill count', ok6,
    'windows: ' + winCount + ', wsl: ' + (cRow ? linCount : '?')]);

  console.log('skillhub doctor');
  console.log('');
  let failed = 0;
  for (const [name, ok, detail] of results) {
    if (!ok) failed++;
    console.log('  ' + (ok ? col('PASS', C.green) : col('FAIL', C.red)) + '  ' +
      pad(name, 58) + ' ' + detail);
  }
  console.log('');
  console.log(failed === 0
    ? col('overall: PASS (' + results.length + '/' + results.length + ' checks)', C.green)
    : col('overall: FAIL (' + failed + ' of ' + results.length + ' checks failed)', C.red));
  if (failed > 0) process.exitCode = 1;
}

/* ================================================================== */
/* command: install-launcher                                           */
/* ================================================================== */

function cmdInstallLauncher() {
  if (!fs.existsSync(LINUX_LAUNCHER_SRC)) {
    console.error(col('missing source file: ' + LINUX_LAUNCHER_SRC, C.red));
    process.exitCode = 1;
    return;
  }
  const script = 'cp "' + cfg.linuxHelper.replace(/\/skillhub-linux\.sh$/, '/skillhub-linux-launcher.sh') +
    '" "' + cfg.linuxLauncher + '" && chmod +x "' + cfg.linuxLauncher + '" && ls -l "' + cfg.linuxLauncher + '"';
  const r = spawnSync('wsl.exe', ['-d', cfg.distro, '--', 'bash', '-c', script], {
    encoding: 'utf8', windowsHide: true
  });
  if (r.error || r.status !== 0) {
    console.error(col('could not install the ubuntu launcher: ' +
      (r.error ? r.error.message : (r.stderr || '').trim()), C.red));
    process.exitCode = 1;
    return;
  }
  console.log((r.stdout || '').trim());
  console.log('installed ' + cfg.linuxLauncher + ' on ' + cfg.distro);
}

/* ================================================================== */
/* usage                                                               */
/* ================================================================== */

function usage() {
  console.log([
    'skillhub - one global skill store for every AI agent harness',
    '',
    'usage: skillhub <command> [args]',
    '',
    '  status             show the canonical store and every target (read only)',
    '  list               list the skill names in the canonical store',
    '  install <pkg>      npx -y skills add <pkg> -s "*" -g -y, then repair + status',
    '                    <pkg> may be <owner/repo> or <owner/repo>@<skill>',
    '  remove <name>      remove one skill folder from the canonical store',
    '  repair             restore every target (merges unique skills, never deletes)',
    '  doctor             PASS/FAIL health checks',
    '  install-launcher   install ~/.local/bin/skillhub inside WSL',
    '',
    'canonical store: ' + cfg.canonical
  ].join('\n'));
}

/* ================================================================== */
/* main                                                                */
/* ================================================================== */

function main(argv) {
  const cmd = (argv[0] || 'status').toLowerCase();
  switch (cmd) {
    case 'status': cmdStatus(); break;
    case 'list': cmdList(); break;
    case 'install': cmdInstall(argv[1]); break;
    case 'remove': case 'uninstall': cmdRemove(argv[1]); break;
    case 'repair': cmdRepair(); break;
    case 'doctor': cmdDoctor(); break;
    case 'install-launcher': cmdInstallLauncher(); break;
    case 'help': case '--help': case '-h': usage(); break;
    default:
      console.error('unknown command: ' + cmd);
      usage();
      process.exitCode = 2;
  }
}

main(process.argv.slice(2));
