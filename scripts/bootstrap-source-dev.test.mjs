import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const script = fileURLToPath(new URL('./bootstrap-source-dev.sh', import.meta.url))

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), 'pluxel bootstrap '))
	t.after(() => rmSync(root, { recursive: true, force: true }))
	const bin = join(root, 'bin')
	const log = join(root, 'calls.jsonl')
	mkdirSync(bin)
	const prelude = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const record = (command) => fs.appendFileSync(process.env.BOOTSTRAP_TEST_LOG, JSON.stringify({ command, args, cwd: process.cwd() }) + '\\n');
`
	const cli = `${prelude}
record('cli');
if (process.env.BOOTSTRAP_TEST_FAIL_INSTALL && args[1] === 'install') process.exit(1);
`
	writeFileSync(
		join(bin, 'git'),
		`${prelude}
record('git');
if (args[0] === 'clone') {
  const destination = args.at(-1);
  fs.mkdirSync(path.join(destination, '.git'), { recursive: true });
  fs.writeFileSync(path.join(destination, 'pluxel.sources.jsonc'), '{}');
  if (path.basename(destination) === 'pluxel') {
    fs.mkdirSync(path.join(destination, 'packages/cli/bin'), { recursive: true });
    fs.writeFileSync(path.join(destination, 'packages/cli/bin/pluxel.mjs'), ${JSON.stringify(cli.replace("const fs = require('node:fs');", "import fs from 'node:fs';").replace("const path = require('node:path');", "import path from 'node:path';"))});
  }
} else if (args[2] === 'rev-parse') {
  if (!fs.existsSync(path.join(args[1], '.git'))) process.exit(1);
  process.stdout.write(fs.realpathSync(args[1]));
} else if (args[2] === 'submodule') {
  if (process.env.BOOTSTRAP_TEST_MISSING_SUBMODULE) process.stdout.write('-abc vendor/example');
} else process.exit(2);
`,
		{ mode: 0o755 },
	)
	writeFileSync(
		join(bin, 'pnpm'),
		`${prelude}
record('pnpm');
if (args[0] === '--version') process.stdout.write('11.25.0');
`,
		{ mode: 0o755 },
	)
	writeFileSync(join(bin, 'corepack'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
	const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, BOOTSTRAP_TEST_LOG: log }
	return {
		root,
		run(args = [], extraEnv = {}) {
			return spawnSync('bash', [script, '--dir', root, ...args], {
				env: { ...env, ...extraEnv },
				encoding: 'utf8',
			})
		},
		calls() {
			return readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
		},
	}
}

test('fresh preparation and repeat preserve checkouts, quote paths and use the source CLI', (t) => {
	const f = fixture(t)
	const app = join(f.root, 'my app')
	const first = f.run(['--app-dir', app, '--app-repo', 'https://example.com/app.git'])
	assert.equal(first.status, 0, first.stderr)
	const calls = f.calls()
	assert.equal(calls.filter((c) => c.command === 'git' && c.args[0] === 'clone').length, 3)
	assert.deepEqual(
		calls.filter((c) => c.command === 'cli').map((c) => [c.args[1], c.cwd]),
		[
			['register', app],
			['list', app],
			['install', app],
			['doctor', app],
		],
	)
	const register = calls.find((c) => c.command === 'cli')
	assert.equal(register.args[2], join(f.root, 'pluxel/local-projects/chatbot'))
	assert.ok(
		calls.findIndex((c) => c.command === 'pnpm' && c.args.includes('build')) <
			calls.indexOf(register),
	)
	assert.ok(!calls.some((c) => c.command === 'pnpm' && c.args[0] === 'dev'))
	const marker = join(app, 'keep.txt')
	writeFileSync(marker, 'local changes')
	const second = f.run(['--app-dir', app, '--start'])
	assert.equal(second.status, 0, second.stderr)
	assert.equal(f.calls().filter((c) => c.command === 'git' && c.args[0] === 'clone').length, 3)
	assert.equal(readFileSync(marker, 'utf8'), 'local changes')
	assert.deepEqual(f.calls().at(-1), { command: 'pnpm', args: ['dev'], cwd: app })
})

test('failed source installation stops before doctor and app startup', (t) => {
	const f = fixture(t)
	const result = f.run(['--start'], { BOOTSTRAP_TEST_FAIL_INSTALL: '1' })
	assert.notEqual(result.status, 0)
	assert.ok(!f.calls().some((c) => c.args.includes('doctor') || c.args[0] === 'dev'))
})

test('missing submodules stop with an initialization command instead of switching them', (t) => {
	const f = fixture(t)
	const result = f.run([], { BOOTSTRAP_TEST_MISSING_SUBMODULE: '1' })
	assert.notEqual(result.status, 0)
	assert.match(result.stderr, /submodule update --init --recursive/)
	assert.ok(!f.calls().some((c) => c.command === 'cli' || c.args.includes('update')))
})
