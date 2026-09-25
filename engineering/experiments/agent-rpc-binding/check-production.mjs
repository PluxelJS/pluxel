import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { rolldown } from '../../../packages/rolldown/node_modules/rolldown/dist/index.mjs'
import { createServer } from 'vite'
import { createPluginBuildPipeline } from '../../../packages/rolldown/src/cli/plugin-build.ts'
import { pluginSourceVitePlugins } from '../../../packages/rolldown/src/vite/plugin-source.ts'

const root = resolve(import.meta.dirname, '../../../packages/rolldown/tests')
const fixture = mkdtempSync(join(root, '.rpc-build-'))
const nodeModules = resolve(fixture, 'node_modules')

function write(path, value) {
	const file = resolve(fixture, path)
	mkdirSync(dirname(file), { recursive: true })
	writeFileSync(file, value)
}

try {
	write('package.json', JSON.stringify({ name: '@fixture/rpc-plugin', type: 'module' }))
	mkdirSync(resolve(nodeModules, '@pluxel'), { recursive: true })
	symlinkSync(
		resolve(import.meta.dirname, '../../../packages/services'),
		resolve(nodeModules, '@pluxel/services'),
		'dir',
	)
	symlinkSync(
		resolve(import.meta.dirname, '../../../packages/core'),
		resolve(nodeModules, '@pluxel/core'),
		'dir',
	)
	mkdirSync(resolve(nodeModules, '@fixture'), { recursive: true })
	symlinkSync(
		resolve(import.meta.dirname, '../../../packages/commands'),
		resolve(nodeModules, '@pluxel/commands'),
		'dir',
	)
	write(
		'provider-src/package.json',
		JSON.stringify({
			name: '@fixture/records-provider',
			version: '1.0.0',
			type: 'module',
			files: ['src'],
			exports: { '.': './src/index.ts' },
		}),
	)
	write('provider-src/src/index.ts', `export { read, write } from './commands.js'`)
	write(
		'provider-src/src/dto.ts',
		`export interface Receipt { operationId: string; committed: boolean }`,
	)
	write(
		'provider-src/src/commands.ts',
		`
		import { defineCommand, Result, type CommandFailure } from '@pluxel/commands'
		import { Type, obj } from '@pluxel/commands/typebox'
		import type { Receipt } from './dto.js'
		export const write = defineCommand({
			name: 'records.write', description: 'Write a record.',
			input: obj({
				id: Type.String(),
				offset: Type.Transform(Type.String()).Decode(Number).Encode(String),
				batch: Type.Optional(Type.Object({
					items: Type.Array(Type.Object({
						amount: Type.Number({ minimum: 0 }),
						approved: Type.Boolean(),
						note: Type.Optional(Type.String()),
					}), { minItems: 1, maxItems: 2 }),
				})),
			}),
			execute(input): Result<Receipt, CommandFailure> {
				return Result.ok({ operationId: input.id + ':' + input.offset + ':' + (input.batch?.items.length ?? 0), committed: true })
			},
		})
		export const read = defineCommand({
			name: 'records.read', description: 'Read a record.',
			input: obj({ id: Type.String() }),
			execute({ id }): Result<{ id: string }, CommandFailure> { return Result.ok({ id }) },
		})
	`,
	)
	const tarball = execFileSync(
		'npm',
		['pack', '--ignore-scripts', '--silent', '--pack-destination', fixture],
		{
			cwd: resolve(fixture, 'provider-src'),
			encoding: 'utf8',
		},
	).trim()
	const packedProvider = resolve(nodeModules, '@fixture/records-provider')
	mkdirSync(packedProvider, { recursive: true })
	execFileSync('tar', [
		'-xzf',
		resolve(fixture, tarball),
		'-C',
		packedProvider,
		'--strip-components=1',
	])
	const pluginSource = `
		import { BasePlugin, Plugin } from '@pluxel/core'
		import { consumePluginDefinitionCandidate } from '@pluxel/core/internal'
		import { Rpc } from '@pluxel/services/rpc'
		import { read, write } from '@fixture/records-provider'
		@Plugin()
		export class RecordsPlugin extends BasePlugin {
			protected override init() {
				this.ctx.require(Rpc).publish({ id: 'records', commands: { write, read } })
			}
		}
		export const __fixtureCandidate = () => consumePluginDefinitionCandidate(RecordsPlugin)
	`
	write('plugin.ts', pluginSource)
	const pipeline = createPluginBuildPipeline({ root: fixture, lint: false, workbench: false })
	const bundle = await rolldown({
		input: resolve(fixture, 'plugin.ts'),
		external: [/^@pluxel\//],
		plugins: pipeline.plugins,
		transform: pipeline.inputOptions.transform,
	})
	try {
		const output = await bundle.generate({ format: 'esm' })
		const code = output.output
			.filter((item) => item.type === 'chunk')
			.map((item) => item.code)
			.join('\n')
		assert.match(code, /pluxel-rpc-artifact-v1/)
		assert.match(code, /bindings/)
		assert.match(code, /__pluxelRpcPublications/)
		const chunks = output.output.filter((item) => item.type === 'chunk')
		assert.equal(chunks.length, 1)
		write('built.mjs', chunks[0].code)
		const module = await import(pathToFileURL(resolve(fixture, 'built.mjs')).href)
		const site = module.__pluxelRpcPublications[0]
		const candidate = module.__fixtureCandidate()
		assert.equal(candidate.implementation, module.RecordsPlugin)
		assert.equal(candidate.rpcSites, module.__pluxelRpcPublications)
		assert.equal(candidate.rpcSites[0], site)
		assert.equal(module.__fixtureCandidate(), candidate)
		assert.equal(site.owner, 'RecordsPlugin')
		assert.match(site.site, /plugin\.ts:RecordsPlugin:records:0$/)
		assert(Object.isFrozen(site.artifact))
		assert(Object.isFrozen(site.artifact.contract))
		assert(Object.isFrozen(site.artifact.methods))
		assert(Object.isFrozen(site.artifact.methods[0].inputSchema))
		const writeSchema = site.artifact.methods.find(
			(method) => method.method === 'write',
		).inputSchema
		assert.equal(
			JSON.stringify(writeSchema),
			JSON.stringify(site.bindings.write.descriptor.inputSchema),
		)
		assert.equal(writeSchema.properties.batch.type, 'object')
		assert.equal(writeSchema.properties.batch.additionalProperties, false)
		assert.deepEqual(writeSchema.properties.batch.required, ['items'])
		assert.equal(writeSchema.properties.batch.properties.items.items.additionalProperties, false)
		assert.deepEqual(writeSchema.properties.batch.properties.items.items.required, [
			'amount',
			'approved',
		])
		assert(Object.isFrozen(site.bindings))
		let published
		module.RecordsPlugin.prototype.init.call({
			ctx: {
				require() {
					return {
						publish(value) {
							published = value
						},
					}
				},
			},
		})
		assert.equal(published.artifact, site.artifact)
		assert.equal(published.bindings, site.bindings)
		for (const [method, command] of Object.entries(site.bindings))
			assert.equal(published.api.commands[method], command)
		assert(
			output.output.some(
				(item) =>
					item.type === 'asset' &&
					item.fileName.startsWith('rpc/') &&
					item.fileName.endsWith('.d.ts'),
			),
		)
		const declaration = output.output.find(
			(item) =>
				item.type === 'asset' &&
				item.fileName.startsWith('rpc/') &&
				item.fileName.endsWith('.d.ts'),
		)
		assert(declaration)
		assert.equal(site.artifact.declaration, String(declaration.source))
		write('generated-client.d.ts', String(declaration.source))
		write(
			'client-check.ts',
			`
			import type { RpcApi, RpcClient } from './generated-client.js'
			declare const api: RpcApi
			declare const rpc: RpcClient
			rpc.open('records').write({ id: 'x', offset: '2' })
			api.write({ id: 'x', offset: '2', batch: { items: [{ amount: 1, approved: true }] } })
			// @ts-expect-error nested wire fields retain their types
			api.write({ id: 'x', offset: '2', batch: { items: [{ amount: '1', approved: true }] } })
			// @ts-expect-error unknown publication id
			rpc.open('missing')
			const result = await api.write({ id: 'x', offset: '2' })
			// @ts-expect-error wire input is a string
			api.write({ id: 'x', offset: 2 })
			if (result.ok) {
				result.value.operationId
				// @ts-expect-error success DTO has no missing field
				result.value.missing
			} else if (result.error.code === 'REJECTED') {
				result.error.reason
			}
		`,
		)
		write(
			'tsconfig-client.json',
			JSON.stringify({
				compilerOptions: {
					target: 'ESNext',
					module: 'ESNext',
					moduleResolution: 'Bundler',
					strict: true,
					noEmit: true,
				},
				include: ['generated-client.d.ts', 'client-check.ts'],
			}),
		)
		execFileSync(resolve(import.meta.dirname, '../../../node_modules/.bin/tsc'), [
			'-p',
			resolve(fixture, 'tsconfig-client.json'),
			'--pretty',
			'false',
		])
		const { createHost } = await import('../../../packages/host/dist/index.mjs')
		const { Rpc, rpc } = await import('../../../packages/services/dist/rpc.mjs')
		const host = await createHost({
			plugins: [module.RecordsPlugin],
			services: [rpc()],
			state: {
				initial: {
					autoStart: [{ definition: candidate.declaration.address, variant: 'default' }],
				},
			},
		})
		try {
			const startup = await host.start()
			assert.equal(startup.core.summary.lifecycleReport.ok, true)
			const session = host.ctx.require(Rpc).createSession({
				principal: { id: 'fixture-user' },
				access: [site.artifact.contract],
			})
			try {
				const read = await session.call({ id: 'records', method: 'read', input: { id: 'one' } })
				assert.equal(read.ok, true)
				assert.equal(read.value.id, 'one')
				const written = await session.call({
					id: 'records',
					method: 'write',
					input: {
						id: 'one',
						offset: '2',
						batch: { items: [{ amount: 1.5, approved: true }] },
					},
				})
				assert.equal(written.ok, true)
				assert.equal(written.value.operationId, 'one:2:1')
				const invalid = await session.call({ id: 'records', method: 'missing', input: {} })
				assert.equal(invalid.ok, false)
				assert.equal(invalid.error.code, 'COMMAND_NOT_FOUND')
			} finally {
				await session.close()
			}
		} finally {
			await host.close()
		}
		console.log(
			JSON.stringify({
				realPluginModule: true,
				sharedRolldownPipeline: true,
				packedSourcePackage: true,
				rpcDeclarationAsset: true,
				verifiedHostPublication: true,
			}),
		)
	} finally {
		await bundle.close()
	}
	const server = await createServer({
		root: fixture,
		configFile: false,
		logLevel: 'silent',
		plugins: pluginSourceVitePlugins({ root: fixture, lintGuard: false, configSource: false }),
		server: { middlewareMode: true, watch: null },
	})
	try {
		const transformed = await server.transformRequest('/plugin.ts', { ssr: true })
		assert.match(transformed?.code ?? '', /pluxel-rpc-artifact-v1/)
		assert.match(transformed?.code ?? '', /__pluxelRpcPublications/)
	} finally {
		await server.close()
	}
	write('plugin-space.ts', pluginSource.replace('.publish(', '.publish ('))
	const spacedPipeline = createPluginBuildPipeline({ root: fixture, lint: false, workbench: false })
	const spacedBundle = await rolldown({
		input: resolve(fixture, 'plugin-space.ts'),
		plugins: spacedPipeline.plugins,
		transform: spacedPipeline.inputOptions.transform,
	})
	try {
		const spaced = await spacedBundle.generate({ format: 'esm' })
		assert(
			spaced.output.some(
				(item) => item.type === 'chunk' && item.code.includes('__pluxelRpcPublications'),
			),
		)
	} finally {
		await spacedBundle.close()
	}
	write(
		'plugin-alias.ts',
		pluginSource.replace('this.ctx.require(Rpc).publish', '(this.ctx.require(Rpc)).publish'),
	)
	const aliasPipeline = createPluginBuildPipeline({ root: fixture, lint: false, workbench: false })
	await assert.rejects(async () => {
		const aliasBundle = await rolldown({
			input: resolve(fixture, 'plugin-alias.ts'),
			plugins: aliasPipeline.plugins,
			transform: aliasPipeline.inputOptions.transform,
		})
		try {
			await aliasBundle.generate({ format: 'esm' })
		} finally {
			await aliasBundle.close()
		}
	}, /indirect RPC publish is unsupported/)
	write('plugin-unowned.ts', pluginSource.replace('@Plugin()', ''))
	const unownedPipeline = createPluginBuildPipeline({
		root: fixture,
		lint: false,
		workbench: false,
	})
	await assert.rejects(async () => {
		const unownedBundle = await rolldown({
			input: resolve(fixture, 'plugin-unowned.ts'),
			plugins: unownedPipeline.plugins,
			transform: unownedPipeline.inputOptions.transform,
		})
		try {
			await unownedBundle.generate({ format: 'esm' })
		} finally {
			await unownedBundle.close()
		}
	}, /inside an exported @Plugin class in the same module/)
	write('plugin-forged.ts', `${pluginSource}\nconst __pluxelRpcPublications = []`)
	const forgedPipeline = createPluginBuildPipeline({ root: fixture, lint: false, workbench: false })
	await assert.rejects(async () => {
		const forgedBundle = await rolldown({
			input: resolve(fixture, 'plugin-forged.ts'),
			plugins: forgedPipeline.plugins,
			transform: forgedPipeline.inputOptions.transform,
		})
		try {
			await forgedBundle.generate({ format: 'esm' })
		} finally {
			await forgedBundle.close()
		}
	}, /reserved generated RPC binding name appears in source/)
	write('plain.ts', `export const plain = 1`)
	const plainPipeline = createPluginBuildPipeline({ root: fixture, lint: false, workbench: false })
	const plainBundle = await rolldown({
		input: resolve(fixture, 'plain.ts'),
		plugins: plainPipeline.plugins,
		transform: plainPipeline.inputOptions.transform,
	})
	try {
		const plain = await plainBundle.generate({ format: 'esm' })
		assert(!plain.output.some((item) => item.type === 'asset' && item.fileName.startsWith('rpc/')))
		assert(
			!plain.output.some(
				(item) => item.type === 'chunk' && item.code.includes('__pluxelRpcPublications'),
			),
		)
	} finally {
		await plainBundle.close()
	}
	write(
		'provider-js-src/package.json',
		JSON.stringify({
			name: '@fixture/records-js-only',
			version: '1.0.0',
			type: 'module',
			files: ['index.js', 'index.d.ts'],
			exports: { '.': { types: './index.d.ts', default: './index.js' } },
		}),
	)
	write('provider-js-src/index.js', `export { read, write } from '@fixture/records-provider'`)
	write(
		'provider-js-src/index.d.ts',
		`export declare const read: any; export declare const write: any`,
	)
	const jsTarball = execFileSync(
		'npm',
		['pack', '--ignore-scripts', '--silent', '--pack-destination', fixture],
		{
			cwd: resolve(fixture, 'provider-js-src'),
			encoding: 'utf8',
		},
	).trim()
	const jsPackage = resolve(nodeModules, '@fixture/records-js-only')
	mkdirSync(jsPackage, { recursive: true })
	execFileSync('tar', [
		'-xzf',
		resolve(fixture, jsTarball),
		'-C',
		jsPackage,
		'--strip-components=1',
	])
	write(
		'plugin-js.ts',
		pluginSource.replace('@fixture/records-provider', '@fixture/records-js-only'),
	)
	const jsPipeline = createPluginBuildPipeline({ root: fixture, lint: false, workbench: false })
	await assert.rejects(async () => {
		const jsBundle = await rolldown({
			input: resolve(fixture, 'plugin-js.ts'),
			plugins: jsPipeline.plugins,
			transform: jsPipeline.inputOptions.transform,
		})
		try {
			await jsBundle.generate({ format: 'esm' })
		} finally {
			await jsBundle.close()
		}
	}, /Command write must resolve to a direct defineCommand export/)
	write(
		'provider-dual-src/package.json',
		JSON.stringify({
			name: '@fixture/records-dual',
			version: '1.0.0',
			type: 'module',
			files: ['src', 'dist'],
			exports: { '.': { '@pluxel/hmr': './src/index.ts', default: './dist/index.js' } },
		}),
	)
	for (const file of ['index.ts', 'commands.ts', 'dto.ts'])
		write(
			`provider-dual-src/src/${file}`,
			readFileSync(resolve(fixture, 'provider-src/src', file), 'utf8'),
		)
	write(
		'provider-dual-src/dist/index.js',
		`export { read, write } from '@fixture/records-provider'`,
	)
	write(
		'provider-dual-src/dist/index.d.ts',
		`export { read, write } from '@fixture/records-provider'`,
	)
	const dualTarball = execFileSync(
		'npm',
		['pack', '--ignore-scripts', '--silent', '--pack-destination', fixture],
		{
			cwd: resolve(fixture, 'provider-dual-src'),
			encoding: 'utf8',
		},
	).trim()
	const dualPackage = resolve(nodeModules, '@fixture/records-dual')
	mkdirSync(dualPackage, { recursive: true })
	execFileSync('tar', [
		'-xzf',
		resolve(fixture, dualTarball),
		'-C',
		dualPackage,
		'--strip-components=1',
	])
	write(
		'plugin-dual.ts',
		pluginSource.replace('@fixture/records-provider', '@fixture/records-dual'),
	)
	const dualPipeline = createPluginBuildPipeline({ root: fixture, lint: false, workbench: false })
	await assert.rejects(async () => {
		const dualBundle = await rolldown({
			input: resolve(fixture, 'plugin-dual.ts'),
			plugins: dualPipeline.plugins,
			transform: dualPipeline.inputOptions.transform,
		})
		try {
			await dualBundle.generate({ format: 'esm' })
		} finally {
			await dualBundle.close()
		}
	}, /resolves differently in TypeScript and Vite\/Rolldown/)
	console.log(
		JSON.stringify({
			sharedVitePipeline: true,
			whitespacePublishRecognized: true,
			indirectPublishRejected: true,
			unusedPipelineHasNoRpcOutput: true,
			forgedGeneratedNameRejected: true,
			packedJsWithoutSourceRejected: true,
			sourceResolutionMismatchRejected: true,
		}),
	)
} finally {
	rmSync(fixture, { recursive: true, force: true })
}
