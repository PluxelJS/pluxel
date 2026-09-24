import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const coreRoot = resolve(import.meta.dirname, '..')
const root = mkdtempSync(join(tmpdir(), 'pluxel-result-installed-'))
const app = join(root, 'app')

function run(command, args, cwd) {
	return execFileSync(command, args, {
		cwd,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'inherit'],
	})
}

function put(path, content) {
	const file = join(root, path)
	mkdirSync(dirname(file), { recursive: true })
	writeFileSync(file, content)
}

function packPlugin(name, source, declarations) {
	const directory = join(root, name)
	put(
		`${name}/package.json`,
		JSON.stringify(
			{
				name: `@fixture/${name}`,
				version: '1.0.0',
				type: 'module',
				exports: { '.': { types: './index.d.mts', default: './index.mjs' } },
				peerDependencies: { '@pluxel/core': '>=1.0.0' },
			},
			null,
			2,
		),
	)
	put(`${name}/index.mjs`, source)
	put(`${name}/index.d.mts`, declarations)
	const output = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', root], directory))
	return join(root, output[0].filename)
}

try {
	run('pnpm', ['run', 'build'], coreRoot)
	const corePack = JSON.parse(run('pnpm', ['pack', '--json', '--pack-destination', root], coreRoot))
	const producer = packPlugin(
		'result-producer',
		`
import { Result, TaggedError } from '@pluxel/core/result'
export class Rejected extends TaggedError('Rejected') {}
export const producerResult = Result
export function produce(input) {
	return input > 0 ? Result.ok(input) : Result.err(new Rejected({ message: 'positive required' }))
}
`,
		`
import type { Result } from '@pluxel/core/result'
export { Result as producerResult } from '@pluxel/core/result'
export declare class Rejected extends Error { readonly _tag: 'Rejected' }
export declare function produce(input: number): Result<number, Rejected>
`,
	)
	const consumer = packPlugin(
		'result-consumer',
		`
import { Result } from '@pluxel/core/result'
import { produce, producerResult } from '@fixture/result-producer'
export const consumerResult = Result
export function consume(input) { return produce(input).map(value => value + 1) }
export function sameResult() { return producerResult === Result }
`,
		`
import type { Result } from '@pluxel/core/result'
import type { Rejected } from '@fixture/result-producer'
export { Result as consumerResult } from '@pluxel/core/result'
export declare function consume(input: number): Result<number, Rejected>
export declare function sameResult(): boolean
`,
	)
	put(
		'app/package.json',
		JSON.stringify({ name: 'result-install-probe', private: true, type: 'module' }),
	)
	run(
		'npm',
		[
			'install',
			'--ignore-scripts',
			'--no-audit',
			'--no-fund',
			'--package-lock=false',
			corePack.filename,
			producer,
			consumer,
		],
		app,
	)
	put(
		'app/probe.mjs',
		`
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { Result } from '@pluxel/core/result'
import { produce, producerResult } from '@fixture/result-producer'
import { consume, consumerResult, sameResult } from '@fixture/result-consumer'
const require = createRequire(import.meta.url)
assert.equal(Result, producerResult)
assert.equal(Result, consumerResult)
assert.equal(Result, require('@pluxel/core/result').Result)
assert.equal(sameResult(), true)
assert.equal(produce(2).map(value => value + 1).unwrap(), 3)
assert.equal(consume(2).unwrap(), 3)
assert.equal(Result.isError(consume(0)), true)
`,
	)
	run(process.execPath, ['probe.mjs'], app)
	run(
		process.execPath,
		[
			'-e',
			`require('@pluxel/core'); if (Object.keys(require.cache).some(path => path.includes('better-result'))) process.exit(1)`,
		],
		app,
	)
	run(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			`import { registerHooks } from 'node:module'; let loaded = false; const hooks = registerHooks({ load(url, context, next) { if (url.includes('better-result')) loaded = true; return next(url, context) } }); await import('@pluxel/core'); hooks.deregister(); if (loaded) process.exit(1)`,
		],
		app,
	)
	put(
		'app/consumer-check.mts',
		`
import { Result, TaggedError, type Result as SharedResult } from '@pluxel/core/result'
import { produce } from '@fixture/result-producer'
import { consume } from '@fixture/result-consumer'
class Missing extends TaggedError('Missing')<{ message: string }> {}
const produced: SharedResult<number, Error> = produce(1)
const consumed: SharedResult<number, Error> = consume(1)
const failed: SharedResult<number, Missing> = Result.err(new Missing({ message: 'missing' }))
void failed
if (Result.isOk(produced) && Result.isOk(consumed)) {
	const value: number = produced.value + consumed.value
	void value
}
`,
	)
	put(
		'app/consumer-check.cts',
		`
import { Result, type Result as SharedResult } from '@pluxel/core/result'
const result: SharedResult<number, never> = Result.ok(1)
void result
`,
	)
	const typescript = resolve(coreRoot, '../../node_modules/typescript/bin/tsc')
	run(
		process.execPath,
		[
			typescript,
			'--noEmit',
			'--strict',
			'--target',
			'ES2023',
			'--module',
			'NodeNext',
			'--moduleResolution',
			'NodeNext',
			'consumer-check.mts',
			'consumer-check.cts',
		],
		app,
	)
	const installed = JSON.parse(
		readFileSync(join(app, 'node_modules/@pluxel/core/package.json'), 'utf8'),
	)
	assert.equal(installed.dependencies['better-result'], '3.0.1')
	console.log('Installed Result ESM/CJS, types and cross-package identity passed')
} finally {
	rmSync(root, { recursive: true, force: true })
}
