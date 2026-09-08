import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { it, onTestFinished } from 'vitest'

async function fixture(failure) {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-verify-'))
	onTestFinished(() => rm(root, { recursive: true, force: true }))
	await mkdir(join(root, 'scripts'))
	await mkdir(join(root, 'bin'))
	await copyFile(new URL('./verify.mjs', import.meta.url), join(root, 'scripts/verify.mjs'))
	await writeFile(
		join(root, 'bin/pnpm'),
		`#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(process.env.VERIFY_LOG, JSON.stringify({ args, cwd: process.cwd() }) + '\\n')
if (args.includes(process.env.VERIFY_FAIL)) process.exit(7)
`,
		{ mode: 0o755 },
	)
	return async (args = []) => {
		const result = spawnSync(process.execPath, [join(root, 'scripts/verify.mjs'), ...args], {
			cwd: tmpdir(),
			encoding: 'utf8',
			env: {
				...process.env,
				PATH: `${join(root, 'bin')}${delimiter}${process.env.PATH}`,
				VERIFY_LOG: join(root, 'calls.jsonl'),
				VERIFY_FAIL: failure ?? '',
			},
		})
		const log = await readFile(join(root, 'calls.jsonl'), 'utf8')
		const calls = log.trim().split('\n').map(JSON.parse)
		assert.ok(calls.every((call) => call.cwd === root))
		return { ...result, calls: calls.map((call) => call.args) }
	}
}

it('runs all gates around Turbo and preserves filter arguments as a single argument', async () => {
	const run = await fixture()
	const result = await run(['--concurrency=2', '--summarize', '--filter=...[origin/main]'])
	assert.equal(result.status, 0, result.stderr)
	assert.deepEqual(result.calls, [
		['run', 'governance:check'],
		['run', 'lint'],
		['run', 'format:check'],
		[
			'exec',
			'turbo',
			'run',
			'typecheck',
			'build',
			'test',
			'--concurrency=2',
			'--summarize',
			'--filter=...[origin/main]',
		],
		['run', 'source-declarations:check'],
	])
})

it('stops before package tasks when a repository gate fails', async () => {
	const run = await fixture('lint')
	const result = await run()
	assert.equal(result.status, 7)
	assert.deepEqual(result.calls, [
		['run', 'governance:check'],
		['run', 'lint'],
	])
})

it('fails verification when successful package tasks leave source declaration pollution', async () => {
	const run = await fixture('source-declarations:check')
	const result = await run()
	assert.equal(result.status, 7)
	assert.ok(result.calls.some((args) => args.includes('turbo')))
	assert.deepEqual(result.calls.at(-1), ['run', 'source-declarations:check'])
})
