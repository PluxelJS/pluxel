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
import { mapConcurrent, SKIP, toArray, reduce } from '@pluxel/async/iter';
import { limit, keyedLimit } from '@pluxel/async/limit';
import { retry } from '@pluxel/async/retry';
import { singleflight } from '@pluxel/async/singleflight';
import { sleep, until, waitFor } from '@pluxel/async/wait';
const g = grfn<number>();
const run = g.compile(g.task({ input: g.input }, ({ input }) => input + 1));
const value: number = await run(2);
const values: number[] = await toArray(mapConcurrent([1, 2, 3], n => n === 2 ? SKIP : n * 2, { concurrency: 2 }));
if (value !== 3 || values.join(',') !== '2,6') throw new Error('Unexpected package result');
const total: number = await reduce(values, (sum, item) => sum + item, 0);
const limiter = limit({ concurrency: 2 });
const keyed = keyedLimit<string>({ concurrency: 1 });
const shared = singleflight((key: string) => limiter.run(() => key.length));
try {
  const lengths: number[] = await Promise.all([shared.run('abc'), shared.run('abc')]);
  const result: number = await retry(() => keyed.run('key', () => lengths[0]!), {
    attempts: 2, shouldRetry: () => false,
  });
  await sleep(0);
  await until(() => true, { intervalMs: 0 });
  if (await waitFor(Promise.resolve(result)) !== 3 || total !== 8) throw new Error('Unexpected primitive result');
} finally {
  await shared.close();
  await Promise.all([limiter.close(), keyed.close()]);
}

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
