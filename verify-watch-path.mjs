// Verifies that `node --watch-path` works on the current platform.
//
// The Node.js docs used to say --watch-path is only supported on macOS and
// Windows and throws ERR_FEATURE_UNAVAILABLE_ON_PLATFORM elsewhere. This
// script checks that, on this platform, --watch-path:
//   1. starts without throwing,
//   2. restarts when an existing file in a nested subdirectory changes,
//   3. restarts when a file is added in a subdirectory created after startup.

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TIMEOUT = 15_000;

const dir = mkdtempSync(join(tmpdir(), 'watch-path-'));
mkdirSync(join(dir, 'src', 'nested'), { recursive: true });
writeFileSync(join(dir, 'src', 'nested', 'file.txt'), 'initial\n');
writeFileSync(join(dir, 'index.js'), "console.log('index.js ran');\n");

// --watch-preserve-output stops watch mode from clearing the console on
// restart, so the full log is kept for the report.
const args = ['--watch-path=./src', '--watch-preserve-output', 'index.js'];
const child = spawn(process.execPath, args, {
  cwd: dir,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
child.stdout.on('data', (d) => { output += d; });
child.stderr.on('data', (d) => { output += d; });

// Resolves once `pattern` appears in the output after offset `from`.
function waitFor(pattern, from, label) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const rest = output.slice(from);
      const match = rest.match(pattern);
      if (match) {
        clearInterval(timer);
        resolve(from + match.index + match[0].length);
      } else if (output.includes('ERR_FEATURE_UNAVAILABLE_ON_PLATFORM')) {
        clearInterval(timer);
        reject(new Error(`--watch-path threw ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`));
      } else if (Date.now() - started > TIMEOUT) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for: ${label}`));
      }
    }, 50);
  });
}

const results = [];
function pass(name) {
  results.push(name);
  console.log(`PASS: ${name}`);
}

try {
  let pos = await waitFor(/Completed running/, 0, 'initial run');
  pass('--watch-path starts without throwing');

  // Give the watchers a moment to be fully set up.
  await new Promise((r) => setTimeout(r, 1000));
  writeFileSync(join(dir, 'src', 'nested', 'file.txt'), 'changed\n');
  // Older versions print only "Restarting", newer ones also print
  // "Change detected in <file>", so only "Restarting" is required.
  pos = await waitFor(/Restarting/, pos,
                      'restart after editing src/nested/file.txt');
  pos = await waitFor(/Completed running/, pos, 'second run');
  pass('restarts when a file in a nested subdirectory changes');

  await new Promise((r) => setTimeout(r, 1000));
  mkdirSync(join(dir, 'src', 'added', 'deeper'), { recursive: true });
  writeFileSync(join(dir, 'src', 'added', 'deeper', 'new.txt'), 'new\n');
  pos = await waitFor(/Restarting/, pos,
                      'restart after creating src/added/deeper/new.txt');
  pass('restarts when a file is added in a newly created subdirectory');
} catch (err) {
  console.error(`FAIL: ${err.message}`);
  process.exitCode = 1;
} finally {
  child.kill();
  console.log('\n----- watch mode output -----');
  console.log(output.trim());

  if (process.env.GITHUB_STEP_SUMMARY) {
    const status = process.exitCode ? '❌ Failed' : '✅ Passed';
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
      `### ${status}: Node.js ${process.version} on ${process.platform}-${process.arch}`,
      '',
      ...results.map((r) => `- ✅ ${r}`),
      '',
      '<details><summary>Watch mode output</summary>',
      '',
      '```',
      output.trim(),
      '```',
      '',
      '</details>',
      '',
    ].join('\n'));
  }
}
