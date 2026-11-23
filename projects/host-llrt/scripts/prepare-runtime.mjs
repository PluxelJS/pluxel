import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'

const vendor = path.resolve('native/vendor')
const llrt = path.join(vendor, 'llrt')
const revision = '0a10758f31eec3e5421a6b8ff1f459df1f4354c4'
if (!existsSync(llrt)) {
	mkdirSync(vendor, { recursive: true })
	execFileSync(
		'git',
		[
			'clone',
			'--depth',
			'1',
			'--branch',
			'v0.9.0-beta',
			'https://github.com/awslabs/llrt.git',
			llrt,
		],
		{ stdio: 'inherit' },
	)
}
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: llrt, encoding: 'utf8' }).trim()
if (head !== revision) throw new Error(`Expected LLRT ${revision}, found ${head}`)

// llrt_core's build.rs compiles these upstream JS builtins to QuickJS bytecode.
const source = path.join(llrt, 'llrt_core/src/modules/js')
await build({
	entryPoints: {
		stream: path.join(source, 'stream.ts'),
		'stream/promises': path.join(source, 'stream/promises.ts'),
	},
	outdir: path.join(llrt, 'bundle/js'),
	bundle: true,
	format: 'esm',
	platform: 'browser',
	target: 'es2022',
	keepNames: true,
	alias: { 'readable-stream': 'llrt-readable-stream' },
	external: ['node:*', 'events', 'buffer', 'util', 'stream', 'string_decoder', 'process'],
	plugins: [
		{
			name: 'llrt-process',
			setup(builder) {
				builder.onResolve({ filter: /^process\/$/ }, () => ({ path: 'process', external: true }))
			},
		},
	],
})
