// Smoke-test real build outputs and declarations without access to src/.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const exports = pkg.publishConfig?.exports
assert(exports, 'Build first to generate publishConfig.exports')
assert(!JSON.stringify(exports).includes('./src/'), 'Published exports must not require source')
assert(!JSON.stringify(exports).includes('@pluxel/source'), 'Published exports must omit source')
const directory = mkdtempSync(join(tmpdir(), 'pluxel-consumer-'))
try {
	const installed = join(directory, 'node_modules', ...pkg.name.split('/'))
	cpSync(join(root, 'dist'), join(installed, 'dist'), { recursive: true })
	writeFileSync(
		join(installed, 'package.json'),
		JSON.stringify({
			name: pkg.name,
			version: pkg.version,
			type: 'module',
			exports,
		}),
	)
	writeFileSync(
		join(directory, 'consumer.mts'),
		`
import { grfn } from '@pluxel/async/grfn';
import { mapConcurrent, SKIP, toArray } from '@pluxel/async/iter';
const g = grfn<number>();
const run = g.compile(g.task({ input: g.input }, ({ input }) => input + 1));
const value: number = await run(2);
const values: number[] = await toArray(mapConcurrent([1, 2, 3], n => n === 2 ? SKIP : n * 2, { concurrency: 2 }));
if (value !== 3 || values.join(',') !== '2,6') throw new Error('Unexpected package result');
`,
	)
	const options = { cwd: directory, stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '' } }
	// Compile only the consumer; the library must come from tsdown's existing dist/.
	const typescriptManifestUrl = import.meta.resolve('typescript/package.json')
	const typescriptManifest = JSON.parse(readFileSync(fileURLToPath(typescriptManifestUrl), 'utf8'))
	const tsc = fileURLToPath(new URL(typescriptManifest.bin.tsc, typescriptManifestUrl))
	execFileSync(
		process.execPath,
		[
			tsc,
			'--strict',
			'--target',
			'ES2022',
			'--module',
			'NodeNext',
			'--moduleResolution',
			'NodeNext',
			'--outDir',
			'build',
			'consumer.mts',
		],
		options,
	)
	execFileSync(process.execPath, ['--unhandled-rejections=strict', 'build/consumer.mjs'], options)
	console.log('Source-free package import and declarations passed')
} finally {
	rmSync(directory, { recursive: true, force: true })
}
