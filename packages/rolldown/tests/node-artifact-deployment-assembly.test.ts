import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { cp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { Worker } from 'node:worker_threads'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { rolldown, type Plugin } from 'rolldown'
import { describe, expect, it } from 'vitest'

import { createStaticApplicationConfig } from '../src/cli/static-application.ts'
import { resolveNodeModuleArtifactKey } from '../src/plugin-artifact/declaration.ts'
import { assembleNodeModuleDeploymentArtifacts } from '../src/plugin-artifact/deployment-assembly.ts'

const sourceKey = 'node-1111111111111111'
const builtKey = 'node-2222222222222222'
const sharedKey = 'node-3333333333333333'
const unusedKey = 'node-4444444444444444'

describe('static Node artifact deployment assembly', () => {
	it('selects referenced artifacts and deduplicates identical packaged keys', async () => {
		await using fixture = await createDiskFixture({
			application: {
				artifacts: { node: { [sourceKey + '.mjs']: 'export const source = true\n' } },
			},
			dependencyA: {
				[builtKey + '.mjs']: 'export const built = true\n',
				[sharedKey + '.mjs']: 'export const shared = true\n',
				[unusedKey + '.mjs']: 'unused stale output A\n',
			},
			dependencyB: {
				[sharedKey + '.mjs']: 'export const shared = true\n',
				[unusedKey + '.mjs']: 'unused stale output B\n',
			},
		})
		const destinationRoot = fixture.getPath('application/artifacts/node')

		await assembleNodeModuleDeploymentArtifacts({
			destinationRoot,
			sourceArtifactKeys: [sourceKey],
			dependencies: [
				{ root: fixture.getPath('dependencyA'), artifactKeys: [builtKey, sharedKey] },
				{ root: fixture.getPath('dependencyB'), artifactKeys: [sharedKey] },
				{ root: fixture.getPath('missing'), artifactKeys: [] },
			],
			requiredArtifactKeys: [sourceKey, builtKey, sharedKey],
		})

		const destinationFiles = await readdir(destinationRoot)
		expect(destinationFiles.sort()).toEqual([
			sourceKey + '.mjs',
			builtKey + '.mjs',
			sharedKey + '.mjs',
		])
		await expect(readFile(destinationRoot + '/' + builtKey + '.mjs', 'utf8')).resolves.toContain(
			'built',
		)
	})

	it.each([true, false])(
		'rejects a selected packaged collision with existing output (source facts: %s)',
		async (hasSourceFacts) => {
			await using fixture = await createDiskFixture({
				application: { [sourceKey + '.mjs']: 'export const owner = "application"\n' },
				dependency: { [sourceKey + '.mjs']: 'export const owner = "dependency"\n' },
			})

			await expect(
				assembleNodeModuleDeploymentArtifacts({
					destinationRoot: fixture.getPath('application'),
					sourceArtifactKeys: hasSourceFacts ? [sourceKey] : [],
					dependencies: [{ root: fixture.getPath('dependency'), artifactKeys: [sourceKey] }],
					requiredArtifactKeys: [sourceKey],
				}),
			).rejects.toThrow('Node artifact content collision for ' + sourceKey)
		},
	)

	it('rejects conflicting bytes from two selected packaged owners', async () => {
		await using fixture = await createDiskFixture({
			application: {},
			dependencyA: { [builtKey + '.mjs']: 'export const version = 1\n' },
			dependencyB: { [builtKey + '.mjs']: 'export const version = 2\n' },
		})

		await expect(
			assembleNodeModuleDeploymentArtifacts({
				destinationRoot: fixture.getPath('application'),
				sourceArtifactKeys: [],
				dependencies: [
					{ root: fixture.getPath('dependencyA'), artifactKeys: [builtKey] },
					{ root: fixture.getPath('dependencyB'), artifactKeys: [builtKey] },
				],
				requiredArtifactKeys: [builtKey],
			}),
		).rejects.toThrow('Node artifact content collision for ' + builtKey)
	})

	it('requires source facts even when a matching destination file exists', async () => {
		await using fixture = await createDiskFixture({
			application: { [sourceKey + '.mjs']: 'export const source = true\n' },
		})

		await expect(
			assembleNodeModuleDeploymentArtifacts({
				destinationRoot: fixture.getPath('application'),
				sourceArtifactKeys: [],
				dependencies: [],
				requiredArtifactKeys: [sourceKey],
			}),
		).rejects.toThrow('Required Node artifact was not found')
	})

	it('does not replace missing current source output with a packaged copy', async () => {
		await using fixture = await createDiskFixture({
			application: {},
			dependency: { [sourceKey + '.mjs']: 'export const stale = true\n' },
		})

		await expect(
			assembleNodeModuleDeploymentArtifacts({
				destinationRoot: fixture.getPath('application'),
				sourceArtifactKeys: [sourceKey],
				dependencies: [{ root: fixture.getPath('dependency'), artifactKeys: [sourceKey] }],
				requiredArtifactKeys: [sourceKey],
			}),
		).rejects.toThrow('Required Node artifact was not found in ' + fixture.getPath('application'))
	})

	it('does not substitute local source output for a missing selected packaged artifact', async () => {
		await using fixture = await createDiskFixture({
			application: { [sourceKey + '.mjs']: 'export const source = true\n' },
		})

		await expect(
			assembleNodeModuleDeploymentArtifacts({
				destinationRoot: fixture.getPath('application'),
				sourceArtifactKeys: [sourceKey],
				dependencies: [{ root: fixture.getPath('missing'), artifactKeys: [sourceKey] }],
				requiredArtifactKeys: [sourceKey],
			}),
		).rejects.toThrow('Required Node artifact was not found in ' + fixture.getPath('missing'))
	})

	it.each(['mixed', 'collision', 'unused-source', 'query', 'query-alias'] as const)(
		'uses real Node lowering and rendered references for same-package %s inputs',
		async (mode) => {
			await using fixture = await createDiskFixture({
				'package.json': JSON.stringify({ name: 'application', type: 'module' }),
				src: {
					'app.ts':
						"import { defineHostApplication } from '@pluxel/host'\n" +
						"export default defineHostApplication(() => ({ name: 'node-artifact-fixture', plugins: [] }))\n",
				},
				mixed: {
					'package.json': JSON.stringify({ name: 'mixed-worker-package', version: '1.0.0' }),
					src: {
						'source.ts':
							"import { defineNodeModule } from '@pluxel/services/node'\n" +
							"export const source = defineNodeModule(import.meta.url, './source-worker.ts')\n" +
							"export const unused = /* @__PURE__ */ defineNodeModule(import.meta.url, './unused-worker.ts')\n",
						'source-worker.ts': 'export const answer = 42\n',
					},
					dist: { artifacts: { node: {} } },
				},
			})
			const root = fixture.getPath('')
			const sourceModule = fixture.getPath('mixed/src/source.ts')
			const bundledSourceModule =
				mode === 'query' ? sourceModule + '?node-artifact-test' : sourceModule
			const unusedQueryModule = sourceModule + '?unused-node-artifact'
			const generatedKey = resolveNodeModuleArtifactKey(root, sourceModule, './source-worker.ts')
			const unusedSourceKey = resolveNodeModuleArtifactKey(root, sourceModule, './unused-worker.ts')
			const selectedBuiltKey =
				mode === 'collision' ? generatedKey : mode === 'unused-source' ? unusedSourceKey : builtKey
			const nodeRoot = fixture.getPath('mixed/dist/artifacts/node')
			await writeFile(nodeRoot + '/' + generatedKey + '.mjs', 'export const stale = true\n')
			await writeFile(nodeRoot + '/' + selectedBuiltKey + '.mjs', 'export const packaged = true\n')
			await writeFile(nodeRoot + '/' + unusedKey + '.mjs', 'unused old packaged artifact\n')
			await writeFile(
				fixture.getPath('mixed/dist/built.mjs'),
				"import { defineNodeModule } from '@pluxel/services/node'\n" +
					'export const built = defineNodeModule(import.meta.url, "./built-worker.ts", ' +
					JSON.stringify(selectedBuiltKey) +
					')\n' +
					'export const unused = /* @__PURE__ */ defineNodeModule(import.meta.url, "./unused.ts", ' +
					JSON.stringify(unusedKey) +
					')\n',
			)
			const config = createStaticApplicationConfig({
				cwd: root,
				entry: './src/app.ts',
				variant: 'headless',
				launcher: 'host',
				lint: false,
			})
			const configuredPlugins = config.plugins as Plugin[]
			const compilerPlugins = [
				'pluxel-static-application-declaration',
				'pluxel-plugin-artifact-build',
				'pluxel-static-application-assembly',
			].map((name) => {
				const plugin = configuredPlugins.find((candidate) => candidate?.name === name)
				if (!plugin) throw new Error('Missing compiler plugin: ' + name)
				return plugin
			})
			const bootstrap = '\0pluxel:static-application-bootstrap'
			const api = '\0fixture:node-api'
			const bundle = await rolldown({
				input: bootstrap,
				plugins: [
					{
						name: 'fixture:node-entry',
						resolveId(id) {
							if (id === bootstrap) return bootstrap
							if (id === '@pluxel/services/node') return api
							if (id === bundledSourceModule) return bundledSourceModule
							if (id === unusedQueryModule) return unusedQueryModule
							return null
						},
						async load(id) {
							if (id === bootstrap) {
								return (
									(mode === 'query-alias'
										? 'import ' + JSON.stringify(unusedQueryModule) + '; '
										: '') +
									'export { source } from ' +
									JSON.stringify(bundledSourceModule) +
									'; export { built } from ' +
									JSON.stringify(fixture.getPath('mixed/dist/built.mjs'))
								)
							}
							if (id === api) {
								return 'export function defineNodeModule(base, entry, key) { return Object.freeze({ base, entry, key }) }'
							}
							if (id === unusedQueryModule) {
								// Both IDs lower the same declaration. Transform the unused alias last.
								await this.load({ id: sourceModule })
								const code = await readFile(sourceModule, 'utf8')
								return code.replace(
									'source = defineNodeModule',
									'source = /* @__PURE__ */ defineNodeModule',
								)
							}
							if (id === bundledSourceModule && id !== sourceModule) {
								return readFile(sourceModule, 'utf8')
							}
							return null
						},
					},
					...compilerPlugins,
				],
			})
			try {
				const write = bundle.write({
					dir: fixture.getPath('dist'),
					format: 'esm',
					entryFileNames: 'app.mjs',
				})
				const outputRoot = fixture.getPath('dist/artifacts/node')
				const failure: unknown = await write.then(
					(): null => null,
					(error: unknown) => error,
				)
				const collisionMessage =
					'[static-application] Node artifact content collision for ' +
					generatedKey +
					'.mjs: ' +
					nodeRoot +
					'/' +
					generatedKey +
					'.mjs conflicts with ' +
					outputRoot +
					'/' +
					generatedKey +
					'.mjs'
				const collisionFailure = expect.stringContaining(collisionMessage)
				expect(failure instanceof Error ? failure.message : failure).toEqual(
					mode === 'collision' ? collisionFailure : null,
				)
				if (mode === 'collision') return
				const outputFiles = await readdir(outputRoot)
				expect(outputFiles.filter((name) => name.endsWith('.mjs')).sort()).toEqual(
					[generatedKey + '.mjs', selectedBuiltKey + '.mjs'].sort(),
				)
				await expect(readFile(outputRoot + '/' + generatedKey + '.mjs', 'utf8')).resolves.toContain(
					'42',
				)
				await expect(
					readFile(outputRoot + '/' + selectedBuiltKey + '.mjs', 'utf8'),
				).resolves.toContain('packaged')
				const deployment = JSON.parse(
					await readFile(fixture.getPath('dist/pluxel-deployment.json'), 'utf8'),
				) as { capabilities: { nodeModules: { artifacts: Array<{ key: string }> } } }
				expect(deployment.capabilities.nodeModules.artifacts.map(({ key }) => key).sort()).toEqual(
					[generatedKey, selectedBuiltKey].sort(),
				)
			} finally {
				await bundle.close()
			}
		},
	)

	it('traces conditional native require closures and runs the worker after relocation', async () => {
		await using fixture = await createDiskFixture({
			'package.json': JSON.stringify({
				name: 'native-worker-application',
				type: 'module',
				dependencies: { 'fake-native': '1.0.0' },
			}),
			src: {
				'app.ts':
					"import { defineHostApplication } from '@pluxel/host'\n" +
					"export default defineHostApplication(() => ({ name: 'native-worker-fixture', plugins: [] }))\n",
				'entry.ts':
					"import { defineNodeModule } from '@pluxel/services/node'\n" +
					"export const task = defineNodeModule(import.meta.url, './worker.ts')\n",
				'worker.ts':
					"import { parentPort } from 'node:worker_threads'\n" +
					"import { value } from 'fake-native'\nparentPort?.postMessage(value)\n",
				node_modules: {
					'fake-native': {
						'package.json': JSON.stringify({
							name: 'fake-native',
							version: '2.0.0',
							type: 'module',
							exports: { '.': { import: './import.mjs', require: './require.cjs' } },
							napi: { binaryName: 'fake' },
						}),
						'import.mjs': 'export const value = 13\n',
						'require.cjs': 'exports.value = 13\n',
					},
				},
			},
			node_modules: {
				'fake-native': {
					'package.json': JSON.stringify({
						name: 'fake-native',
						version: '1.0.0',
						type: 'module',
						exports: { '.': { import: './import.mjs', require: './require.cjs' } },
						napi: { binaryName: 'fake' },
						dependencies: { 'fake-helper': '1.0.0' },
					}),
					'import.mjs': 'export const value = 0\n',
					'require.cjs': "module.exports = require('fake-helper')\n",
				},
				'fake-helper': {
					'package.json': JSON.stringify({
						name: 'fake-helper',
						version: '1.0.0',
						type: 'module',
						exports: { '.': { import: './import.mjs', require: './require.cjs' } },
					}),
					'import.mjs': 'export const value = 0\n',
					'require.cjs': 'exports.value = 42\n',
				},
			},
		})
		const root = fixture.getPath('')
		const buildScript = fixture.getPath('build.mts')
		await writeFile(
			buildScript,
			String.raw`import { rolldown } from ${JSON.stringify(import.meta.resolve('rolldown'))}
import { createStaticApplicationConfig } from ${JSON.stringify(new URL('../src/cli/static-application.ts', import.meta.url).href)}

const root = process.cwd()
const config = createStaticApplicationConfig({
	cwd: root,
	entry: './src/app.ts',
	variant: 'headless',
	launcher: 'host',
	lint: false,
})
const compilerPlugins = [
	'pluxel-static-application-declaration',
	'pluxel-plugin-artifact-build',
	'pluxel:nf3-externals',
	'pluxel-static-application-assembly',
].map((name) => {
	const plugin = config.plugins.find((candidate) => candidate?.name === name)
	if (!plugin) throw new Error('Missing compiler plugin: ' + name)
	return plugin
})
const bootstrap = '\0pluxel:static-application-bootstrap'
const api = '\0fixture:node-api'
const bundle = await rolldown({
	input: bootstrap,
	plugins: [
		{
			name: 'fixture:native-worker-entry',
			resolveId(id) {
				if (id === bootstrap) return bootstrap
				if (id === '@pluxel/services/node') return api
				return null
			},
			load(id) {
				if (id === bootstrap) return 'export { task } from ' + JSON.stringify(root + '/src/entry.ts')
				if (id === api) return 'export function defineNodeModule(base, entry, key) { return { base, entry, key } }'
				return null
			},
		},
		...compilerPlugins,
	],
})
try {
	await bundle.write({ dir: root + '/dist', format: 'esm', entryFileNames: 'app.mjs' })
} finally {
	await bundle.close()
}
`,
		)
		await promisify(execFile)(
			process.execPath,
			['--import', import.meta.resolve('tsx'), buildScript],
			{ cwd: root, timeout: 30_000 },
		)
		const manifest = JSON.parse(
			await readFile(fixture.getPath('dist/pluxel-distribution.json'), 'utf8'),
		) as { entries: Array<{ path: string }> }
		expect(manifest.entries.map(({ path }) => path)).toEqual(
			expect.arrayContaining([
				'node_modules/fake-native/require.cjs',
				'node_modules/fake-helper/require.cjs',
			]),
		)
		await using relocated = await createDiskFixture({})
		await cp(fixture.getPath('dist'), relocated.getPath('application'), { recursive: true })
		await rm(fixture.getPath('node_modules'), { recursive: true })
		await rm(fixture.getPath('src/node_modules'), { recursive: true })
		const key = resolveNodeModuleArtifactKey(root, fixture.getPath('src/entry.ts'), './worker.ts')
		// Deployment workers use Node's default conditions; Vitest adds an `import` condition.
		const worker = new Worker(
			pathToFileURL(relocated.getPath('application/artifacts/node/' + key + '.mjs')),
			{ execArgv: [] },
		)
		try {
			await expect(
				once(worker, 'message', { signal: AbortSignal.timeout(10_000) }),
			).resolves.toEqual([42])
		} finally {
			await worker.terminate()
		}
	}, 45_000)
})
