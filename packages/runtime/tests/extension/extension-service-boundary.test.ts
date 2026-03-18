import { describe, expect, it, vi } from 'vitest'
import { createFixture } from 'fs-fixture'
import { dirname, join } from 'pathe'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

import { ExtensionService } from '../../src/services/plugin-interaction/ExtensionService'

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
			join(process.cwd(), 'src/services/plugin-interaction/ExtensionService.ts'),
			'utf-8',
		)
		expect(code).not.toMatch(/\bchokidar\b/)
	})

	it('bindModule() no-ops (and warns once) when compile mode but compiler missing', () => {
		const { ctx, logger } = createFakeCtx()
		const service = new ExtensionService(ctx, { mode: 'compile', enabled: true })

		const dispose1 = service.bindModule({ entryPath: './ui.tsx' })
		const dispose2 = service.bindModule({ entryPath: './ui.tsx' })

		dispose1()
		dispose2()

		expect(logger.warn).toHaveBeenCalledTimes(1)
	})

	it('bindModule() delegates to a configured compiler when present', () => {
		const { ctx } = createFakeCtx()
		const compiler = {
			attachStore: vi.fn(),
			bindModule: vi.fn(() => () => undefined),
		}

		const service = new ExtensionService(ctx, { mode: 'compile', enabled: true, compiler })
		const disposer = service.bindModule({ entryPath: './ui.tsx' })
		disposer()

		expect(compiler.attachStore).toHaveBeenCalledTimes(1)
		expect(compiler.bindModule).toHaveBeenCalledTimes(1)
	})

	it('registerBuiltin() bumps manifest version and is cleaned up by disposer', async () => {
		await using fixture = await createFixture({})
		const { ctx } = createFakeCtx()
		void fixture
		const service = new ExtensionService(ctx, { mode: 'registry-only', enabled: true })

		const events: any[] = []
		const unsubscribe = service.subscribeManifest((e) => events.push(e))

		const before = service.getManifest().version
		const dispose = service.registerBuiltin({
			id: 'a',
			point: 'plugin:tabs' as any,
			kind: 'doc' as any,
			title: 't',
			body: 'b',
		} as any)

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

	it('getModuleSource() serves committed module code', async () => {
		const { ctx } = createFakeCtx()
		const service = new ExtensionService(ctx, { mode: 'registry-only', enabled: true })

		const okHash = 'abcd'
		await service.commitCompiledModule('test-plugin', okHash, 'export const ok = 1\n', 123)
		expect(await service.getModuleSource('test-plugin', okHash)).toContain('export const ok')
	})
})
