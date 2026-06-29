// Run the project's test suite as part of the IT dev pipeline.
// The checker/tester (IT Reviewer "B") uses this to actually execute tests
// against the writer's diff before the change is allowed to commit.

const fs = require('fs');
const path = require('path');
const { runCli } = require('./cli-runner');

// Decide what command to run. An explicit `dev.testCommand` setting wins;
// otherwise auto-detect from the project layout. Returns null when nothing
// testable is found (pipeline then simply skips the test gate).
function detectTestCommand(projectRoot, configured) {
  if (configured && String(configured).trim()) {
    return { command: String(configured).trim(), source: 'configured' };
  }

  const pkgPath = path.join(projectRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const testScript = pkg.scripts && pkg.scripts.test;
      // Ignore the npm placeholder ("Error: no test specified").
      if (testScript && !/no test specified/i.test(testScript)) {
        return { command: 'npm test', source: 'package.json' };
      }
    } catch {
      /* malformed package.json — fall through */
    }
  }

  const pyMarkers = ['pytest.ini', 'tox.ini', 'setup.cfg', 'pyproject.toml'];
  if (pyMarkers.some((f) => fs.existsSync(path.join(projectRoot, f)))) {
    return { command: 'pytest -q', source: 'python' };
  }

  return null;
}

function splitCommand(commandStr) {
  const parts = String(commandStr).trim().split(/\s+/);
  return { cmd: parts[0], args: parts.slice(1) };
}

// Returns:
//   { ran:false, ok:true }                      → no tests to run (skipped)
//   { ran:true,  ok:true,  command, output }     → tests passed
//   { ran:true,  ok:false, command, output }     → tests failed (or timed out)
async function runTests({ projectRoot, configuredCommand, onLog = () => {}, timeoutMs = 300000 }) {
  const detected = detectTestCommand(projectRoot, configuredCommand);
  if (!detected) {
    onLog('tests: no test command detected — skipping test gate');
    return { ran: false, ok: true, command: null, output: '', reason: 'no-tests' };
  }

  const { cmd, args } = splitCommand(detected.command);
  onLog(`tests: running \`${detected.command}\` (${detected.source})`);
  const res = await runCli(cmd, args, { cwd: projectRoot, timeoutMs });
  const output = `${res.stdout || ''}\n${res.stderr || ''}`.trim();

  return {
    ran: true,
    ok: res.ok,
    timedOut: !!res.timedOut,
    command: detected.command,
    source: detected.source,
    output,
  };
}

module.exports = { runTests, detectTestCommand };
