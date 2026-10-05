import type { PluginSource } from '@pluxel/host/sources'
import type { PluginSourceOpenOptions } from '../src/source-session'
import { watchPluginSource } from '../src/sources-watch'
import type { ViteDevServer } from 'vite'
import { expect, it, vi } from 'vitest'
vi.mock('../src/sources-watch', () => ({ watchPluginSource: vi.fn() }))
import { createHostSourceEvaluator } from '../src/application-sources'

it('reuses equivalent source sessions, isolates rejected declarations, and publishes staged changes only on acceptance', async () => {
	const opens: string[] = []
	const closes: string[] = []
	const notifications: string[] = []
	const callbacks = new Map<string, PluginSourceOpenOptions>()
	const source = (key: string): PluginSource => ({ kind: 'file', path: key })
	vi.mocked(watchPluginSource).mockImplementation(async (declaration, options) => {
		const key = declaration.path
		opens.push(key)
		callbacks.set(key, options)
		return {
			entries: async () => [],
			covers: (path) => path === `/physical/${key}` || path === `/app/${key}`,
			close: async () => {
				closes.push(key)
			},
		}
	})
	const evaluator = createHostSourceEvaluator({
		server: {} as ViteDevServer,
		root: '/app',
		onChange(change) {
			notifications.push(change.path)
		},
		onError(error) {
			throw error
		},
	})
	const evaluate = (key: string) =>
		evaluator.evaluate({
			application: { plugins: [], sources: [source(key)] },
			entryFiles: new Set<string>(),
		})
	try {
		const initial = await evaluate('active')
		expect(evaluator.covers('/physical/active')).toBe(true)
		expect(evaluator.covers('/app/active')).toBe(true)
		await initial.accept()
		const equivalent = await evaluate('active')
		await equivalent.reject()
		expect(opens).toEqual(['active'])
		const rejected = await evaluate('rejected')
		callbacks.get('rejected')!.onChange({ type: 'add', path: '/app/rejected.mjs' })
		callbacks.get('active')!.onChange({ type: 'add', path: '/app/active.mjs' })
		await rejected.reject()
		expect(evaluator.covers('/physical/rejected')).toBe(false)
		expect(notifications).toEqual(['/app/active.mjs'])
		expect(closes).toEqual(['rejected'])
		const accepted = await evaluate('accepted')
		callbacks.get('accepted')!.onChange({ type: 'add', path: '/app/accepted.mjs' })
		expect(notifications).toEqual(['/app/active.mjs'])
		await accepted.accept()
		expect(evaluator.covers('/physical/active')).toBe(false)
		expect(evaluator.covers('/physical/accepted')).toBe(true)
		await accepted.reject()
		expect(notifications).toEqual(['/app/active.mjs', '/app/accepted.mjs'])
		expect(closes).toEqual(['rejected', 'active'])
	} finally {
		await evaluator.close()
	}
	expect(closes).toEqual(['rejected', 'active', 'accepted'])
	callbacks.get('accepted')!.onChange({ type: 'add', path: '/app/late.mjs' })
	expect(notifications).not.toContain('/app/late.mjs')
})

it('preserves source validation failure as the cause when releasing its watcher also fails', async () => {
	const sourceError = Object.assign(new TypeError('invalid source'), { file: '/app/plugin.mjs' })
	const cleanupError = new Error('source watcher cleanup failed')
	vi.mocked(watchPluginSource).mockResolvedValue({
		entries: vi.fn().mockResolvedValueOnce([]).mockRejectedValue(sourceError),
		covers: () => false,
		close: async () => {
			throw cleanupError
		},
	})
	const evaluator = createHostSourceEvaluator({
		root: '/app',
		server: {} as ViteDevServer,
		onChange() {},
		onError() {},
	})
	try {
		await expect(
			evaluator.evaluate({
				application: { plugins: [], sources: [{ kind: 'file', path: 'plugin.mjs' }] },
				entryFiles: new Set<string>(),
			}),
		).rejects.toMatchObject({
			cause: sourceError,
			errors: [sourceError, expect.objectContaining({ errors: [cleanupError] })],
		})
	} finally {
		await evaluator.close()
	}
})
