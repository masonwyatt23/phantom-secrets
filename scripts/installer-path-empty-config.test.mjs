import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

// An existing but zero-byte shell configuration is a distinct branch from an
// absent one: the installer snapshots it with cp -p, finds no marker, and
// appends to a copy. A successful update must leave a PATH entry a shell can
// actually use, and neither the snapshot nor the candidate may remain.
const copies = {
  'scripts/install.sh': resolve(import.meta.dirname, 'install.sh'),
  'apps/web/public/install.sh': resolve(import.meta.dirname, '..', 'apps', 'web', 'public', 'install.sh'),
};

// Same extraction as installer-path-snapshot-cleanup.test.mjs.
function extractFunction(source, name, file) {
  const start = source.indexOf(`${name}()`);
  assert.ok(start >= 0, `${file}: locate ${name}`);
  const lineEnd = source.indexOf('\n', start);
  if (source.slice(start, lineEnd).trimEnd().endsWith('}')) return source.slice(start, lineEnd + 1);
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, `${file}: locate end of ${name}`);
  return source.slice(start, end + '\n}\n'.length);
}

for (const [file, path] of Object.entries(copies)) {
  const source = readFileSync(path, 'utf8');
  const harness = ['set -euo pipefail', 'umask 077',
    ...['say', 'file_identity', 'file_link_count', 'add_to_user_path']
      .map((name) => extractFunction(source, name, file)),
    'add_to_user_path "$1"',
  ].join('\n');

  test(`${file} writes a valid PATH entry into an empty shell configuration and leaves no temporary files`, (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'phantom-path-empty-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, 'home');
    const bin = join(root, 'bin');
    const rc = join(home, '.bashrc');
    mkdirSync(home);
    mkdirSync(bin);
    writeFileSync(rc, '', { mode: 0o600 });
    assert.equal(statSync(rc).size, 0, 'fixture startup file is empty');

    const env = { HOME: home, SHELL: '/bin/bash', PATH: '/usr/bin:/bin' };
    const result = spawnSync('/bin/bash', ['-c', harness, 'path-test', bin], { encoding: 'utf8', timeout: 30000, env });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /added .* to PATH/);

    assert.equal(readFileSync(rc, 'utf8'), `\n# phantom-secrets PATH\nexport PATH="${bin}:$PATH"\n`);
    assert.equal(statSync(rc).mode & 0o777, 0o600, 'startup file keeps its private mode');
    assert.deepEqual(readdirSync(home), ['.bashrc'], 'no snapshot or candidate remains');

    // The entry must work: a fresh shell sourcing the file finds bin first.
    const sourced = spawnSync('/bin/bash', ['-c', '. "$HOME/.bashrc"; printf %s "$PATH"'], { encoding: 'utf8', env });
    assert.equal(sourced.status, 0, sourced.stderr);
    assert.equal(sourced.stdout.split(':')[0], bin);
  });
}
