import { describe, expect, it, vi } from 'vitest'

import { clientNodeImportGuardPlugin } from '../../src/hmr/engine/plugins/clientNodeImportGuard'

describe('clientNodeImportGuardPlugin', () => {
	it('uses a resolveId filter for node-only imports', () => {
		const plugin = clientNodeImportGuardPlugin()
		const hook = plugin.resolveId as {
			filter?: { id?: RegExp }
			handler: (this: unknown, source: string, importer?: string) => unknown
		}

		expect(hook.filter?.id).toBeInstanceOf(RegExp)
		expect(hook.filter?.id?.test('node:fs')).toBe(true)
		expect(hook.filter?.id?.test('fs/promises')).toBe(true)
		expect(hook.filter?.id?.test('\0__vite-browser-external:node:path')).toBe(true)
		expect(hook.filter?.id?.test('react')).toBe(false)
	})

	it('fails fast for node-only client imports', () => {
		const plugin = clientNodeImportGuardPlugin()
		const hook = plugin.resolveId as {
			handler: (this: unknown, source: string, importer?: string) => unknown
		}
		const ctx = {
			environment: { name: 'client' },
			error: vi.fn((message: string) => {
				throw new Error(message)
			}),
		}

		expect(() => hook.handler.call(ctx, 'node:fs', '/src/ui.tsx')).toThrow(
			/Node-only import detected/,
		)
		expect(ctx.error).toHaveBeenCalledOnce()
	})

	it('does not fail in ssr environment', () => {
		const plugin = clientNodeImportGuardPlugin()
		const hook = plugin.resolveId as {
			handler: (this: unknown, source: string, importer?: string) => unknown
		}
		const ctx = {
			environment: { name: 'ssr' },
			error: vi.fn(),
		}

		expect(hook.handler.call(ctx, 'node:fs', '/src/plugin.ts')).toBeNull()
		expect(ctx.error).not.toHaveBeenCalled()
	})
})
