import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createRequire } from 'node:module'
const project = fileURLToPath(new URL('../', import.meta.url))
const vendor = path.join(project, 'native/vendor/llrt')
const revision = '0a10758f31eec3e5421a6b8ff1f459df1f4354c4'
const run = (cmd, args, cwd = project) => execFileSync(cmd, args, { cwd, stdio: 'inherit' })
if (!existsSync(path.join(vendor, '.git'))) {
	mkdirSync(path.dirname(vendor), { recursive: true })
	run('git', [
		'clone',
		'--depth',
		'1',
		'--branch',
		'v0.9.0-beta',
		'https://github.com/awslabs/llrt.git',
		vendor,
	])
}
const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: vendor, encoding: 'utf8' }).trim()
if (actual !== revision) throw new Error(`Expected LLRT ${revision}, got ${actual}`)
const patch = path.join(project, 'patches/llrt-embedded.patch')
try {
	execFileSync('git', ['apply', '--reverse', '--check', patch], { cwd: vendor, stdio: 'pipe' })
} catch {
	run('git', ['apply', '--check', patch], vendor)
	run('git', ['apply', patch], vendor)
}
// Runtime JS comes from the locked upstream source; these are its only non-test
// JS standard-library entrypoints. AWS SDK and upstream test runner are excluded.
const require = createRequire(path.join(project, 'package.json'))
const { build } = require('esbuild')
await build({
	entryPoints: {
		stream: path.join(vendor, 'llrt_core/src/modules/js/stream.ts'),
		'stream/promises': path.join(vendor, 'llrt_core/src/modules/js/stream/promises.ts'),
	},
	outdir: path.join(vendor, 'bundle/js'),
	bundle: true,
	format: 'esm',
	platform: 'browser',
	target: 'es2023',
	keepNames: true,
	nodePaths: [path.join(project, 'node_modules')],
	external: ['node:*', 'events', 'buffer', 'util', 'stream', 'string_decoder', 'process'],
	plugins: [
		{
			name: 'upstream-process',
			setup(context) {
				context.onResolve({ filter: /^process\/$/ }, () => ({ path: 'process', external: true }))
			},
		},
	],
})
console.log(`Prepared LLRT ${revision} with reviewed embedded patch and upstream stream bundle`)
