import { describe, expect, it, vi } from 'vitest'
import { createFixture } from 'fs-fixture'
import { dirname, join } from 'pathe'
import { fileURLToPath } from 'node:url'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

import {
	createCompiledExtensionModule,
	ExtensionService,
} from '../../src/services/plugin-interaction/ExtensionService'
import { doc } from '../../src/web/extensions'

const runtimePackageDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

function createNodeFsShim() {
	return {
		exists: (path: string) => existsSync(path),
		readText: (path: string) => readFile(path, 'utf-8'),
		writeTextAtomic: async (path: string, text: string) => {
			await mkdir(dirname(path), { recursive: true })
			await writeFile(path, text, 'utf-8')
		},
		readdir: async (path: string) => {
			try {
				return await readdir(path)
			} catch {
				return []
			}
		},
		stat: async (path: string) => {
			try {
				const st = await stat(path)
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
			await rm(path, { force: true })
		},
		rm: async (path: string, options: { recursive?: boolean; force?: boolean }) => {
			await rm(path, { recursive: options.recursive === true, force: options.force === true })
		},
	}
}

function createFakeCtx(overrides?: Partial<any>) {
	const rootLogger = {
		error: vi.fn(),
		warn: vi.fn(),
		info: vi.fn(),
		debug: vi.fn(),
	}
	const root: any = { logger: rootLogger, config: {}, fs: createNodeFsShim() }

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
	if (!ctx.root.fs) ctx.root.fs = createNodeFsShim()
	if (!ctx.root.logger) ctx.root.logger = rootLogger
	if (!ctx.root.config) ctx.root.config = {}
	ctx.config = ctx.config ?? ctx.root.config
	return { ctx, root, logger: rootLogger }
}

describe('ExtensionService runtime/dev boundary', () => {
	it('runtime ExtensionService has no chokidar import (guardrail)', async () => {
		const code = await readFile(
			join(runtimePackageDir, 'src/services/plugin-interaction/ExtensionService.ts'),
			'utf-8',
		)
		expect(code).not.toMatch(/\bchokidar\b/)
	})

	it('packaged() registers packaged federation metadata', async () => {
		await using fixture = await createFixture({
			dist: {
				'index.mjs': 'export {}',
				'ui.remote': {
					'mf-manifest.json': JSON.stringify({
						id: 'demo',
						metadata: {},
					}),
				},
			},
		})
		const registryPath = join(fixture.path, 'dist/index.mjs')
		const { ctx } = createFakeCtx({
			loader: {
				api: {
					registry: {
						findModuleIdByName: vi.fn(() => registryPath),
					},
					anchors: {
						list: vi.fn(() => [registryPath]),
					},
				},
			},
			pluginInfo: { id: 'test-plugin' },
		})
		const service = new ExtensionService(ctx, { enabled: true })

		const dispose = service.packaged()
		await vi.waitFor(() => expect(service.getCompiledModule('test-plugin')).toBeDefined())

		expect(service.getCompiledModule('test-plugin')).toMatchObject({
			pluginName: 'test-plugin',
			manifestUrl: expect.stringContaining('/extensions/artifacts/'),
			exposedModule: './ui-module',
		})
		expect(
			service.resolveArtifactFile('test-plugin', service.getCompiledModule('test-plugin')!.sourceHash, 'mf-manifest.json'),
		).toBe(join(fixture.path, 'dist/ui.remote/mf-manifest.json'))

		dispose()
	})

	it('packaged() resolves the default manifest from package root dist output', async () => {
		await using fixture = await createFixture({
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
		})
		const registryPath = join(fixture.path, 'src/index.ts')
		const { ctx } = createFakeCtx({
			loader: {
				api: {
					registry: {
						findModuleIdByName: vi.fn(() => registryPath),
					},
					anchors: {
						list: vi.fn(() => [registryPath]),
					},
				},
			},
			pluginInfo: { id: 'test-plugin' },
		})
		const service = new ExtensionService(ctx, { enabled: true })

		const dispose = service.packaged()
		await vi.waitFor(() => expect(service.getCompiledModule('test-plugin')).toBeDefined())

		expect(
			service.resolveArtifactFile(
				'test-plugin',
				service.getCompiledModule('test-plugin')!.sourceHash,
				'mf-manifest.json',
			),
		).toBe(join(fixture.path, 'dist/ui.remote/mf-manifest.json'))

		dispose()
	})

	it('packaged() does not warn when the implicit packaged manifest is absent', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({ name: 'test-plugin', version: '0.0.0' }),
			src: {
				'index.ts': 'export {}',
			},
		})
		const registryPath = join(fixture.path, 'src/index.ts')
		const { ctx, logger } = createFakeCtx({
			loader: {
				api: {
					registry: {
						findModuleIdByName: vi.fn(() => registryPath),
					},
					anchors: {
						list: vi.fn(() => [registryPath]),
					},
				},
			},
			pluginInfo: { id: 'test-plugin' },
		})
		const service = new ExtensionService(ctx, { enabled: true })

		const dispose = service.packaged()
		await Promise.resolve()

		expect(service.getCompiledModule('test-plugin')).toBeUndefined()
		expect(logger.warn).not.toHaveBeenCalled()
		dispose()
	})

	it('doc() bumps manifest version and is cleaned up by disposer', async () => {
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
			content: doc`b`,
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

	it('helpers() emit signaldb-only builtin form/button blocks', async () => {
		const { ctx } = createFakeCtx()
		const service = new ExtensionService(ctx, { enabled: true })
		const binding = {
			field: (key: string, fallback: unknown) =>
				({ kind: 'signaldb', collection: 'runtime', selector: { id: 'runtime' }, path: key, fallback }) as const,
			path: (path: string, fallback: unknown) =>
				({ kind: 'signaldb', collection: 'runtime', selector: { id: 'runtime' }, path, fallback }) as const,
			snapshot: (fallback: unknown) =>
				({ kind: 'signaldb', collection: 'runtime', selector: { id: 'runtime' }, fallback }) as const,
		}

		const helpers = service.helpers(binding)
		const form = helpers.form({
			schemaKey: 'demo',
			write: {
				collection: 'runtime-actions',
				mode: 'insert',
				value: { id: { kind: 'generatedId' }, paused: { kind: 'field', key: 'paused' } },
			},
			sync: { id: 'runtime', paused: false },
		})
		const button = helpers.button({
			label: 'Reset',
			write: {
				collection: 'runtime-actions',
				mode: 'insert',
				value: { id: { kind: 'generatedId' }, ticks: 0 },
			},
		})

		expect(form).toMatchObject({
			kind: 'form',
			syncFrom: { kind: 'signaldb', collection: 'runtime', selector: { id: 'runtime' } },
		})
		expect(button).toMatchObject({
			kind: 'action',
			label: 'Reset',
		})
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
