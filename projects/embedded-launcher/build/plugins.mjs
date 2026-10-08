import { rolldown } from 'rolldown'
import { createPluginSemanticsPlugin, configSourcePlugin } from '@pluxel/rolldown/plugins'
import { resolve, dirname } from 'node:path'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { PLUGIN_LOWERING_ABI_VERSION } from '@pluxel/core/toolchain'
const root = resolve(import.meta.dirname, '..')
const require = createRequire(resolve(root, 'package.json'))
async function installedVersion(name) {
	let directory = dirname(require.resolve(name))
	while (directory !== dirname(directory)) {
		try {
			const manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'))
			if (manifest.name === name) return manifest.version
		} catch (error) {
			if (error.code !== 'ENOENT') throw error
		}
		directory = dirname(directory)
	}
	throw new Error(`Could not identify installed package ${name}`)
}
const packageNames = [
	'@pluxel/core',
	'@pluxel/host',
	'@pluxel/commands',
	'@pluxel/services',
	'valibot',
	'mathjs',
	'zod',
	'yaml',
	'semver',
	'jose',
	'wretch',
	'axios',
	'@noble/ciphers',
	'@noble/hashes',
]
const versions = Object.fromEntries(
	await Promise.all(packageNames.map(async (name) => [name, await installedVersion(name)])),
)
const sdk = await rolldown({
	input: resolve(root, 'sdk/src/index.ts'),
	external: /^@pluxel\//,
	resolve: { conditionNames: ['@pluxel/source', 'import', 'default'] },
})
await sdk.write({ file: resolve(root, 'sdk/dist/index.mjs'), format: 'esm' })
await sdk.close()
if (process.argv.includes('--sdk-only')) process.exit(0)
const semantics = createPluginSemanticsPlugin({ root })
const build = await rolldown({
	input: {
		embedded: resolve(root, 'src/execution/embedded.ts'),
		lifecycle: resolve(root, 'tests/fixtures/embedded-lifecycle.ts'),
	},
	plugins: [semantics.plugin, configSourcePlugin()],
	resolve: { conditionNames: ['@pluxel/source', 'import', 'default'] },
	external: (id) => id.startsWith('node:') || id === 'launcher:bridge',
})
const output = await build.write({
	dir: resolve(root, 'dist'),
	entryFileNames: '[name].mjs',
	format: 'esm',
	sourcemap: true,
})
const files = new Set(output.output.map((item) => item.fileName))
const residual = [
	...new Set(
		output.output.flatMap((item) =>
			item.type === 'chunk' ? item.imports.concat(item.dynamicImports) : [],
		),
	),
].filter((name) => !files.has(name))
const allowed = new Set([
	'launcher:bridge',
	'node:crypto',
	'node:fs',
	'node:path',
	'node:url',
	'node:module',
	'node:fs/promises',
])
for (const name of residual)
	if (!allowed.has(name)) throw new Error(`Unverified residual import: ${name}`)
await mkdir(resolve(root, 'dist'), { recursive: true })
await writeFile(
	resolve(root, 'dist/closure.json'),
	JSON.stringify(
		{
			loweringAbi: PLUGIN_LOWERING_ABI_VERSION,
			conditions: ['@pluxel/source', 'import', 'default'],
			packageVersions: versions,
			residualImports: residual,
			globalsAuditScope:
				'Named globals used by the built application/Core/Host/Commands closure; not a completeness claim for arbitrary packages. Standard ECMAScript intrinsics are omitted.',
			requiredGlobals: [
				'TextEncoder',
				'URL',
				'console',
				'performance.now',
				'process',
				'AbortController',
				'AbortSignal.any',
				'structuredClone',
				'setTimeout',
				'clearTimeout',
				'Symbol.dispose',
				'Symbol.asyncDispose',
			],
		},
		null,
		2,
	) + '\n',
)
await build.close()
console.log(JSON.stringify({ residualImports: residual }))
const compatibility = await rolldown({
	input: resolve(root, 'tests/compatibility/portable.ts'),
	platform: 'browser',
	resolve: { conditionNames: ['browser', 'import', 'default'] },
})
const compatibleOutput = await compatibility.write({
	file: resolve(root, 'dist/compatibility.mjs'),
	format: 'esm',
})
for (const item of compatibleOutput.output) {
	if (item.type === 'chunk' && (item.imports.length > 0 || item.dynamicImports.length > 0))
		throw new Error(
			`Compatibility probe has residual imports: ${[...item.imports, ...item.dynamicImports]}`,
		)
}
await compatibility.close()

await writeFile(
	resolve(root, 'dist/compatibility-closure.json'),
	JSON.stringify(
		{
			conditions: ['browser', 'import', 'default'],
			platform: 'browser',
			packageVersions: versions,
			residualImports: [],
		},
		null,
		2,
	) + '\n',
)
