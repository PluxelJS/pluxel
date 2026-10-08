import { rolldown } from 'rolldown'
import { createPluginSemanticsPlugin, configSourcePlugin } from '@pluxel/rolldown/plugins'
import { PLUGIN_LOWERING_ABI_VERSION } from '@pluxel/core/toolchain'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, writeFile, mkdtemp, rm, copyFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'

const root = resolve(import.meta.dirname, '..')
const destination = resolve(root, 'release')
const runtime = resolve(destination, 'runtime')
const archives = resolve(destination, 'packages')
await mkdir(runtime, { recursive: true })
await mkdir(archives, { recursive: true })
const shared = new Map()
for (const version of ['1.0.0', '2.0.0']) {
	const semantics = createPluginSemanticsPlugin({ root })
	const build = await rolldown({
		input: {
			embedded: resolve(root, 'src/execution/production.ts'),
			'packages/demo/plugins': resolve(root, 'src/plugins/index.ts'),
		},
		plugins: [
			{
				name: 'demo-release-version',
				transform(code, id) {
					if (id === resolve(root, 'src/plugins/calculator-label.ts'))
						return code.replace('计算 ${expression}', `计算 v${version} \${expression}`)
				},
			},
			semantics.plugin,
			configSourcePlugin(),
		],
		resolve: { conditionNames: ['@pluxel/source', 'import', 'default'] },
		external: (id) =>
			id.startsWith('node:') || id === 'launcher:bridge' || id === 'launcher:selection',
	})
	try {
		const { output } = await build.generate({
			format: 'esm',
			paths: { 'launcher:selection': './selection.mjs' },
			entryFileNames: '[name].mjs',
			chunkFileNames: 'shared/[name]-[hash].mjs',
		})
		const files = new Set(output.map((item) => item.fileName))
		const allowed = new Set([
			'launcher:bridge',
			'./selection.mjs',
			'node:crypto',
			'node:fs',
			'node:path',
			'node:url',
			'node:module',
			'node:fs/promises',
		])
		for (const item of output) {
			if (item.type !== 'chunk') throw new Error(`Unexpected release asset ${item.fileName}`)
			for (const dependency of [...item.imports, ...item.dynamicImports])
				if (!files.has(dependency) && !allowed.has(dependency))
					throw new Error(`Unverified release import: ${dependency}`)
		}
		const definitions = semantics
			.definitions()
			.filter(
				(item) =>
					item.kind === 'plugin' &&
					item.definition.entry.kind === 'package-subpath' &&
					item.definition.entry.packageName === '@embedded-launcher/app' &&
					item.definition.entry.subpath === './plugins',
			)
		const exports = definitions.map((item) => item.definition.exportName).sort()
		if (exports.length === 0 || new Set(exports).size !== exports.length)
			throw new Error('Release requires unique canonical lowered Plugin exports')
		const staging = await mkdtemp(resolve(tmpdir(), 'launcher-package-'))
		try {
			const checksums = {}
			for (const item of output) {
				if (item.fileName.startsWith('packages/demo/')) {
					const name = item.fileName.slice('packages/demo/'.length)
					await mkdir(dirname(resolve(staging, name)), { recursive: true })
					await writeFile(resolve(staging, name), item.code)
					checksums[name] = createHash('sha256').update(item.code).digest('hex')
				} else {
					const previous = shared.get(item.fileName)
					if (previous !== undefined && previous !== item.code)
						throw new Error(`Stable runtime file changed across demo versions: ${item.fileName}`)
					shared.set(item.fileName, item.code)
					await mkdir(dirname(resolve(runtime, item.fileName)), { recursive: true })
					await writeFile(resolve(runtime, item.fileName), item.code)
				}
			}
			const manifest = {
				format: 1,
				name: '@embedded-launcher/app',
				version,
				entry: 'plugins.mjs',
				exports,
				loweringAbi: PLUGIN_LOWERING_ABI_VERSION,
				sdkVersion: '1',
				requires: {},
				files: checksums,
			}
			await writeFile(resolve(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
			const archive = resolve(archives, `demo-${version}.zip`)
			await rm(archive, { force: true })
			const result = spawnSync(
				'zip',
				['-q', '-X', archive, 'manifest.json', ...Object.keys(checksums)],
				{ cwd: staging, encoding: 'utf8' },
			)
			if (result.error || result.status !== 0)
				throw new Error(`zip build failed: ${result.error?.message ?? result.stderr}`)
			console.log(
				JSON.stringify({ archive, version, exports, loweringAbi: PLUGIN_LOWERING_ABI_VERSION }),
			)
		} finally {
			await rm(staging, { recursive: true, force: true })
		}
	} finally {
		await build.close()
	}
}
await copyFile(resolve(archives, 'demo-1.0.0.zip'), resolve(runtime, 'seed.zip'))
await writeFile(
	resolve(runtime, 'runtime.json'),
	JSON.stringify(
		{
			format: 1,
			sdkVersion: '1',
			loweringAbi: PLUGIN_LOWERING_ABI_VERSION,
			files: Object.fromEntries(
				[...shared].map(([name, code]) => [name, createHash('sha256').update(code).digest('hex')]),
			),
		},
		null,
		2,
	) + '\n',
)
