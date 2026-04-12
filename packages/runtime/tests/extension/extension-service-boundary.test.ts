import { describe, expect, it, vi } from 'vitest'
import { createFixture, type TestFixture } from '@pluxel/test/fixtures'
import { dirname, join } from 'pathe'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'

import {
	createCompiledExtensionModule,
	ExtensionService,
} from '../../src/services/plugin-interaction/ExtensionService'
import { defineInteractionContract, doc } from '../../src/web/extensions'

const runtimePackageDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

function createNodeFsShim(fixture: Pick<TestFixture, 'fs' | 'fsp'>) {
	return {
		exists: (path: string) => fixture.fs.existsSync(path),
		readText: (path: string) => fixture.fsp.readFile(path, 'utf-8'),
		writeTextAtomic: async (path: string, text: string) => {
			await fixture.fsp.mkdir(dirname(path), { recursive: true })
			await fixture.fsp.writeFile(path, text, 'utf-8')
		},
		readdir: async (path: string) => {
			try {
				return await fixture.fsp.readdir(path)
			} catch {
				return []
			}
		},
		stat: async (path: string) => {
			try {
				const st = await fixture.fsp.stat(path)
				return {
					type: st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other',
					size: st.size,
					mtimeMs: st.mtimeMs,
				} as const
			} catch {
				return { type: 'missing' } as const
			}
		},
		unlink: async (path: string) => {
			await fixture.fsp.rm(path, { force: true })
		},
		rm: async (path: string, options: { recursive?: boolean; force?: boolean }) => {
			await fixture.fsp.rm(path, {
				recursive: options.recursive === true,
				force: options.force === true,
			})
		},
	}
}

function createFakeCtx(overrides?: Partial<any>, fixture?: Pick<TestFixture, 'fs' | 'fsp'>) {
	const rootLogger = {
		error: vi.fn(),
		warn: vi.fn(),
		info: vi.fn(),
		debug: vi.fn(),
	}
	const root: any = {
		logger: rootLogger,
		config: {},
		...(fixture ? { fs: createNodeFsShim(fixture) } : {}),
	}

	const ctx: any = {
		root,
		config: root.config,
		logger: rootLogger,
		name: 'test',
		pluginInfo: { id: 'test-plugin' },
		effects: {
			defer: (fn: () => void) => ({ dispose: fn }),
		},
		...overrides,
	}
	if (!ctx.root) ctx.root = root
	if (!ctx.root.fs && fixture) ctx.root.fs = createNodeFsShim(fixture)
	if (!ctx.root.logger) ctx.root.logger = rootLogger
	if (!ctx.root.config) ctx.root.config = {}
	ctx.config = ctx.config ?? ctx.root.config
	return { ctx, root, logger: rootLogger }
}

function createDependencyLoader(graph: Record<string, string[]>) {
	const names = new Set<string>()
	for (const [name, deps] of Object.entries(graph)) {
		names.add(name)
		for (const dep of deps) names.add(dep)
	}

	const ctors = new Map<string, new () => unknown>()
	const namesByCtor = new Map<new () => unknown, string>()
	for (const name of names) {
		const ctor = class {}
		ctors.set(name, ctor)
		namesByCtor.set(ctor, name)
	}

	return {
		api: {
			registry: {
				getCtor: vi.fn((name: string) => ctors.get(name)),
			},
			runtime: {
				resolve: vi.fn((name: string) => ctors.get(name)),
			},
			deps: {
				list: vi.fn((ctor: new () => unknown) =>
					(graph[namesByCtor.get(ctor) ?? ''] ?? []).map((name) => ({
						name,
						isRunning: true,
					})),
				),
			},
		},
	}
}

async function withPackagedService(
	files: Record<string, unknown>,
	registryPath: (fixture: TestFixture) => string,
	run: (args: {
		fixture: TestFixture
		service: ExtensionService
		ctx: any
		logger: ReturnType<typeof createFakeCtx>['logger']
	}) => Promise<void>,
) {
	await using fixture = await createFixture(files)
	const entryPath = registryPath(fixture)
	const { ctx, logger } = createFakeCtx(
		{
			loader: {
				api: {
					registry: {
						findModuleIdByName: vi.fn(() => entryPath),
					},
					anchors: {
						list: vi.fn(() => [entryPath]),
					},
				},
			},
			pluginInfo: { id: 'test-plugin' },
		},
		fixture,
	)
	const service = new ExtensionService(ctx, { enabled: true })
	await run({ fixture, service, ctx, logger })
}

const FontInteractionContract = defineInteractionContract<
	{ current: string | null },
	{ selectedId: string | null },
	{ selectedId: string | null }
>({
	id: 'test.font-picker',
	version: 1,
	validateInput(value) {
		return {
			current:
				typeof (value as any)?.current === 'string' && (value as any).current.trim()
					? (value as any).current.trim()
					: null,
		}
	},
	validateDraft(value) {
		return {
			selectedId:
				typeof (value as any)?.selectedId === 'string' && (value as any).selectedId.trim()
					? (value as any).selectedId.trim()
					: null,
		}
	},
	validateResult(value) {
		return {
			selectedId:
				typeof (value as any)?.selectedId === 'string' && (value as any).selectedId.trim()
					? (value as any).selectedId.trim()
					: null,
		}
	},
})

describe('ExtensionService runtime/dev boundary', () => {
	it('runtime ExtensionService has no chokidar import (guardrail)', async () => {
		const code = await readFile(
			join(runtimePackageDir, 'src/services/plugin-interaction/ExtensionService.ts'),
			'utf-8',
		)
		expect(code).not.toMatch(/\bchokidar\b/)
	})

	it('packaged() registers packaged federation metadata', async () => {
		await withPackagedService(
			{
			dist: {
				'index.mjs': 'export {}',
				'ui.remote': {
					'mf-manifest.json': JSON.stringify({
						id: 'demo',
						metadata: {},
					}),
				},
			},
			},
			(fixture) => join(fixture.path, 'dist/index.mjs'),
			async ({ fixture, service }) => {
				const dispose = service.packaged()
				await vi.waitFor(() => expect(service.getCompiledModule('test-plugin')).toBeDefined())
				const compiled = service.getCompiledModule('test-plugin')!

				expect(compiled).toMatchObject({
					pluginName: 'test-plugin',
					manifestUrl: expect.stringContaining('/extensions/artifacts/'),
					exposedModule: './ui-module',
				})
				expect(
					service.resolveArtifactFile('test-plugin', compiled.sourceHash, 'mf-manifest.json'),
				).toBe(join(fixture.path, 'dist/ui.remote/mf-manifest.json'))

				dispose()
			},
		)
	})

	it('packaged() resolves the default manifest from package root dist output', async () => {
		await withPackagedService(
			{
			'package.json': JSON.stringify({ name: 'test-plugin', version: '0.0.0' }),
			src: {
				'index.ts': 'export {}',
			},
			dist: {
				'ui.remote': {
					'mf-manifest.json': JSON.stringify({
						id: 'demo',
						metadata: {},
					}),
				},
			},
			},
			(fixture) => join(fixture.path, 'src/index.ts'),
			async ({ fixture, service }) => {
				const dispose = service.packaged()
				await vi.waitFor(() => expect(service.getCompiledModule('test-plugin')).toBeDefined())
				const compiled = service.getCompiledModule('test-plugin')!

				expect(
					service.resolveArtifactFile('test-plugin', compiled.sourceHash, 'mf-manifest.json'),
				).toBe(join(fixture.path, 'dist/ui.remote/mf-manifest.json'))

				dispose()
			},
		)
	})

	it('packaged() does not warn when the implicit packaged manifest is absent', async () => {
		await withPackagedService(
			{
			'package.json': JSON.stringify({ name: 'test-plugin', version: '0.0.0' }),
			src: {
				'index.ts': 'export {}',
			},
			},
			(fixture) => join(fixture.path, 'src/index.ts'),
			async ({ service, logger }) => {
				const dispose = service.packaged()
				await Promise.resolve()

				expect(service.getCompiledModule('test-plugin')).toBeUndefined()
				expect(logger.warn).not.toHaveBeenCalled()
				dispose()
			},
		)
	})

	it('doc(schemaMap)`...` bumps manifest version and is cleaned up by disposer', async () => {
		await using fixture = await createFixture({})
		const { ctx } = createFakeCtx()
		void fixture
		const service = new ExtensionService(ctx, { enabled: true })

		const events: any[] = []
		const unsubscribe = service.subscribeManifest((e) => events.push(e))

		const before = service.getManifest().version
		const dispose = service.doc({
			id: 'a',
			point: 'plugin:tabs' as any,
			title: 't',
			content: doc({} as const)`b`,
		})

		const afterAdd = service.getManifest()
		expect(afterAdd.version).toBeGreaterThan(before)
		expect(afterAdd.builtins?.length).toBe(1)

		dispose()
		const afterRemove = service.getManifest()
		expect(afterRemove.version).toBeGreaterThan(afterAdd.version)
		expect(afterRemove.builtins?.length).toBe(0)

		unsubscribe()
		expect(events.length).toBeGreaterThan(0)
	})

	it('surface() registers consumer-owned interaction surfaces into the manifest', () => {
		const apply = vi.fn()
		const { ctx } = createFakeCtx({
			pluginInfo: { id: 'consumer-plugin' },
		})
		const service = new ExtensionService(ctx, { enabled: true })

		const dispose = service.surface({
			id: 'appearance.font',
			point: 'plugin:tabs' as any,
			contract: FontInteractionContract,
			title: 'Typography',
			providers: ['font-manager'],
			input: () => ({ current: null }),
			apply,
		})

		expect(service.getManifest().surfaces).toEqual([
			expect.objectContaining({
				id: 'appearance.font',
				pluginName: 'consumer-plugin',
				point: 'plugin:tabs',
				title: 'Typography',
				providers: ['font-manager'],
				contract: expect.objectContaining({
					id: 'test.font-picker',
					version: 1,
				}),
			}),
		])

		dispose()
		expect(service.getManifest().surfaces ?? []).toHaveLength(0)
	})

	it('offer() resolves active interaction sessions for direct dependencies', () => {
		const loader = createDependencyLoader({
			'consumer-plugin': ['font-manager'],
			'consumer-plugin-2': ['font-manager'],
			'font-manager': [],
		})
		const service = new ExtensionService(
			createFakeCtx({
				loader,
				pluginInfo: { id: 'consumer-plugin' },
			}).ctx,
			{ enabled: true },
		)
		service.surface({
			id: 'appearance.font',
			point: 'plugin:tabs' as any,
			contract: FontInteractionContract,
			title: 'Typography',
			providers: ['font-manager'],
			input: () => ({ current: null }),
			apply: async () => {},
			meta: { label: 'Typography', tab: { id: 'typography', label: 'Typography' } } as any,
		})

		service.ctx = createFakeCtx({
			loader,
			pluginInfo: { id: 'consumer-plugin-2' },
		}).ctx
		service.surface({
			id: 'appearance.font',
			point: 'plugin:tabs' as any,
			contract: FontInteractionContract,
			title: 'Typography',
			providers: ['font-manager'],
			input: () => ({ current: null }),
			apply: async () => {},
			meta: { label: 'Typography', tab: { id: 'typography', label: 'Typography' } } as any,
		})

		service.ctx = createFakeCtx({
			loader,
			pluginInfo: { id: 'font-manager' },
		}).ctx
		const dispose = service.offer({
			id: 'font-picker',
			point: 'plugin:tabs' as any,
			contract: FontInteractionContract,
			renderKey: 'fontPickerSession',
		})

		const manifest = service.getManifest()
		expect(manifest.offers).toEqual([
			expect.objectContaining({
				id: 'font-picker',
				pluginName: 'font-manager',
				renderKey: 'fontPickerSession',
			}),
		])
		expect(manifest.sessions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					pluginName: 'consumer-plugin',
					providerPluginName: 'font-manager',
					surfaceId: 'appearance.font',
					offerId: 'font-picker',
				}),
				expect.objectContaining({
					pluginName: 'consumer-plugin-2',
					providerPluginName: 'font-manager',
				}),
			]),
		)
		expect(manifest.interactions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					targetPlugin: 'consumer-plugin',
					surface: 'appearance.font',
					state: 'active',
					providerPlugin: 'font-manager',
				}),
				expect.objectContaining({
					targetPlugin: 'consumer-plugin-2',
					surface: 'appearance.font',
					state: 'active',
					providerPlugin: 'font-manager',
				}),
			]),
		)

		dispose()
		expect(service.getManifest().offers ?? []).toHaveLength(0)
		expect(service.getManifest().sessions ?? []).toHaveLength(0)
	})

	it('loadSession/syncDraft/commitSession split provider UI from consumer persistence', async () => {
		const loader = createDependencyLoader({
			'consumer-plugin': ['font-manager'],
			'font-manager': [],
		})
		const draftSpy = vi.fn()
		const applySpy = vi.fn()
		const service = new ExtensionService(
			createFakeCtx({
				loader,
				pluginInfo: { id: 'consumer-plugin' },
			}).ctx,
			{ enabled: true },
		)
		service.surface({
			id: 'appearance.font',
			point: 'plugin:tabs' as any,
			contract: FontInteractionContract,
			providers: ['font-manager'],
			input: () => ({ current: 'neo-grotesk' }),
			onDraftChange: async (draft, context) => {
				draftSpy(draft, context)
			},
			apply: async (result, context) => {
				applySpy(result, context)
			},
			meta: { label: 'Typography', tab: { id: 'typography', label: 'Typography' } } as any,
		})

		service.ctx = createFakeCtx({
			loader,
			pluginInfo: { id: 'font-manager' },
		}).ctx
		service.offer({
			id: 'font-picker',
			point: 'plugin:tabs' as any,
			contract: FontInteractionContract,
			renderKey: 'fontPickerSession',
			prepare: async ({ input }) => ({
				draft: { selectedId: input.current },
				prepared: { options: ['neo-grotesk', 'mono-grid'] },
			}),
		})

		const session = service.getManifest().sessions?.[0]
		expect(session).toBeDefined()

		const loaded = await service.loadSession(session!.id)
		expect(loaded).toEqual({
			ok: true,
			input: { current: 'neo-grotesk' },
			draft: { selectedId: 'neo-grotesk' },
			prepared: { options: ['neo-grotesk', 'mono-grid'] },
		})

		const draftResult = await service.syncDraft({
			sessionId: session!.id,
			draft: { selectedId: 'mono-grid' },
		})
		expect(draftResult).toEqual({ ok: true })
		expect(draftSpy).toHaveBeenCalledWith(
			{ selectedId: 'mono-grid' },
			expect.objectContaining({
				sessionId: session!.id,
				targetPlugin: 'consumer-plugin',
				providerPlugin: 'font-manager',
				input: { current: 'neo-grotesk' },
			}),
		)

		const commitResult = await service.commitSession({
			sessionId: session!.id,
			result: { selectedId: 'mono-grid' },
		})
		expect(commitResult).toEqual({ ok: true })
		expect(applySpy).toHaveBeenCalledWith(
			{ selectedId: 'mono-grid' },
			expect.objectContaining({
				draft: { selectedId: 'mono-grid' },
				input: { current: 'neo-grotesk' },
				targetPlugin: 'consumer-plugin',
				providerPlugin: 'font-manager',
			}),
		)
	})

	it('offer() does not resolve sessions when the target does not depend on the provider', () => {
		const loader = createDependencyLoader({
			'consumer-plugin': [],
			'font-manager': [],
		})
		const service = new ExtensionService(
			createFakeCtx({
				loader,
				pluginInfo: { id: 'consumer-plugin' },
			}).ctx,
			{ enabled: true },
		)
		service.surface({
			id: 'appearance.font',
			point: 'plugin:tabs' as any,
			contract: FontInteractionContract,
			providers: ['font-manager'],
			input: () => ({ current: null }),
			apply: async () => {},
		})

		service.ctx = createFakeCtx({
			loader,
			pluginInfo: { id: 'font-manager' },
		}).ctx
		service.offer({
			id: 'font-picker',
			point: 'plugin:tabs' as any,
			contract: FontInteractionContract,
			renderKey: 'fontPickerSession',
		})

		expect(service.getManifest().sessions ?? []).toHaveLength(0)
		expect(service.getManifest().interactions).toEqual([
			expect.objectContaining({
				targetPlugin: 'consumer-plugin',
				surface: 'appearance.font',
				state: 'rejected',
				reason: 'dependency_not_satisfied',
			}),
		])
	})

	it('surface() keeps only the highest-priority offer when cardinality is single', () => {
		const loader = createDependencyLoader({
			'consumer-plugin': ['font-manager', 'theme-manager'],
			'font-manager': [],
			'theme-manager': [],
		})
		const service = new ExtensionService(
			createFakeCtx({
				loader,
				pluginInfo: { id: 'consumer-plugin' },
			}).ctx,
			{ enabled: true },
		)
		service.surface({
			id: 'appearance.font',
			point: 'plugin:tabs' as any,
			contract: FontInteractionContract,
			providers: ['font-manager', 'theme-manager'],
			input: () => ({ current: null }),
			apply: async () => {},
		})

		service.ctx = createFakeCtx({
			loader,
			pluginInfo: { id: 'font-manager' },
		}).ctx
		service.offer({
			id: 'font-picker',
			point: 'plugin:tabs' as any,
			contract: FontInteractionContract,
			priority: 10,
			renderKey: 'fontPickerSession',
		})

		service.ctx = createFakeCtx({
			loader,
			pluginInfo: { id: 'theme-manager' },
		}).ctx
		service.offer({
			id: 'theme-picker',
			point: 'plugin:tabs' as any,
			contract: FontInteractionContract,
			priority: 50,
			renderKey: 'themePickerSession',
		})

		expect(service.getManifest().sessions).toEqual([
			expect.objectContaining({
				pluginName: 'consumer-plugin',
				providerPluginName: 'theme-manager',
				offerId: 'theme-picker',
				priority: 50,
			}),
		])
		expect(service.getManifest().interactions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					targetPlugin: 'consumer-plugin',
					surface: 'appearance.font',
					providerPlugin: 'theme-manager',
					state: 'active',
				}),
				expect.objectContaining({
					targetPlugin: 'consumer-plugin',
					surface: 'appearance.font',
					providerPlugin: 'font-manager',
					state: 'rejected',
					reason: 'shadowed_by_higher_priority',
				}),
			]),
		)
	})

	it('required surfaces surface waiting-provider diagnostics and warn once', () => {
		const { ctx, logger } = createFakeCtx({
			pluginInfo: { id: 'consumer-plugin' },
		})
		const service = new ExtensionService(ctx, { enabled: true })
		service.surface({
			id: 'appearance.font',
			point: 'plugin:tabs' as any,
			contract: FontInteractionContract,
			providers: ['font-manager'],
			required: true,
			input: () => ({ current: null }),
			apply: async () => {},
		})

		const manifest = service.getManifest()
		expect(manifest.builtins ?? []).toHaveLength(0)
		expect(manifest.interactions).toEqual([
			expect.objectContaining({
				targetPlugin: 'consumer-plugin',
				surface: 'appearance.font',
				state: 'waiting-provider',
				reason: 'required_surface_unfulfilled',
			}),
		])

		service.getManifest()
		expect(logger.warn).toHaveBeenCalledTimes(1)
		expect(logger.warn).toHaveBeenCalledWith(
			'required interaction surface has no active offer',
			expect.objectContaining({
				targetPlugin: 'consumer-plugin',
				surface: 'appearance.font',
			}),
		)
	})

	it('offer() without a matching surface surfaces waiting-surface diagnostics', () => {
		const loader = createDependencyLoader({
			'font-manager': [],
		})
		const { ctx } = createFakeCtx({
			loader,
			pluginInfo: { id: 'font-manager' },
		})
		const service = new ExtensionService(ctx, { enabled: true })

		service.offer({
			id: 'font-picker',
			point: 'plugin:tabs' as any,
			contract: FontInteractionContract,
			renderKey: 'fontPickerSession',
		})

		expect(service.getManifest().interactions).toEqual([
			expect.objectContaining({
				surface: undefined,
				state: 'waiting-surface',
				reason: 'surface_not_found',
				providerPlugin: 'font-manager',
			}),
		])
	})

	it('doc(schemaMap)`...` rejects non-string primitive interpolation', () => {
		const d = doc({} as const)
		expect(() => d`${1 as any}`).toThrowError(/invalid interpolation/)
	})

	it('doc(schemaMap)`...` rejects duplicate or unreachable schema placements', () => {
		const d = doc({ a: true, b: true } as const)
		expect(() => d`${d.schema('a')}${d.schema('a')}`).toThrowError(/duplicate schema placement/)
		expect(() => d`${d.schemas()}${d.schema('a')}`).toThrowError(
			/must be the last schema-placement token/,
		)
	})

	it('compile status transitions are surfaced via manifest events', async () => {
		const { ctx } = createFakeCtx()
		const service = new ExtensionService(ctx, { enabled: true })
		const events: any[] = []
		const unsubscribe = service.subscribeManifest((event) => events.push(event))

		await service.markCompiling?.('test-plugin', { updatedAt: 100 })
		await service.markCompileError?.('test-plugin', new Error('boom'), {
			updatedAt: 200,
			sourceHash: 'prev',
			compiledAt: 123,
		})

		const manifest = service.getManifest()
		expect(manifest.states).toContainEqual(
			expect.objectContaining({
				pluginName: 'test-plugin',
				state: 'error',
				updatedAt: 200,
				sourceHash: 'prev',
			}),
		)
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: 'building', pluginName: 'test-plugin', updatedAt: 100 }),
				expect.objectContaining({
					type: 'error',
					pluginName: 'test-plugin',
					updatedAt: 200,
					sourceHash: 'prev',
					message: 'boom',
				}),
			]),
		)

		unsubscribe()
	})

	it('commitCompiledModule() stores federated module metadata', async () => {
		const { ctx } = createFakeCtx()
		const service = new ExtensionService(ctx, { enabled: true })

		const okHash = 'abcd'
		await service.commitCompiledModule(
			createCompiledExtensionModule({
				pluginName: 'test-plugin',
				sourceHash: okHash,
				compiledAt: 123,
			}),
		)

		expect(service.getCompiledModule('test-plugin')).toMatchObject({
			pluginName: 'test-plugin',
			sourceHash: okHash,
			remoteName: expect.any(String),
			manifestUrl: expect.stringContaining('/extensions/artifacts/'),
			exposedModule: './ui-module',
			compiledAt: 123,
		})
	})
})
