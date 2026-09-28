import type { PluginSource, PluginSourceOpenOptions } from '@pluxel/host'
import type { ViteDevServer } from 'vite'
import { expect, it } from 'vitest'
import { createHostSourceEvaluator } from '../src/application-sources'

it('reuses equivalent source sessions, isolates rejected declarations, and publishes staged changes only on acceptance', async () => {
	const opens: string[] = []
	const closes: string[] = []
	const notifications: string[] = []
	const callbacks = new Map<string, PluginSourceOpenOptions>()
	const source = (key: string): PluginSource => ({
		key,
		covers: () => false,
		async open(options) {
			opens.push(key)
			callbacks.set(key, options)
			return {
				entries: [],
				async close() {
					closes.push(key)
				},
			}
		},
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
		await initial.accept()
		const equivalent = await evaluate('active')
		await equivalent.reject()
		expect(opens).toEqual(['active'])
		const rejected = await evaluate('rejected')
		callbacks.get('rejected')!.onChange({ type: 'add', path: '/app/rejected.mjs' })
		callbacks.get('active')!.onChange({ type: 'add', path: '/app/active.mjs' })
		await rejected.reject()
		expect(notifications).toEqual(['/app/active.mjs'])
		expect(closes).toEqual(['rejected'])
		const accepted = await evaluate('accepted')
		callbacks.get('accepted')!.onChange({ type: 'add', path: '/app/accepted.mjs' })
		expect(notifications).toEqual(['/app/active.mjs'])
		await accepted.accept()
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
