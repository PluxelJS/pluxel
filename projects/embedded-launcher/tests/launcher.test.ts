import * as plugins from '../src/plugins'
import { expect, it } from 'vitest'
import { createSession } from '../src/execution/session'
import {
	Launcher,
	LauncherControl,
	launcher,
	type Json,
	type NativeTransport,
} from '@embedded-launcher/sdk'

it('query/action revocation, CLI and config share the same Host', async () => {
	const writes: string[] = []
	const native: NativeTransport = {
		async request(method, params) {
			const input = params as Record<string, Json>
			if (method === 'desktop.list')
				return { actions: [{ id: 'toggle-theme', title: '切换主题', subtitle: '原生应用' }] }
			if (method === 'clipboard.write') {
				writes.push(String(input.text))
				return { committed: true }
			}
			if (method === 'desktop.execute') return { committed: true, message: 'theme changed' }
			if (method === 'native.echo') return { text: input.text }
			return { accepted: true }
		},
	}
	const session = createSession(native, undefined, Object.values(plugins))
	let id = 0
	const rpc = async (method: string, params = {}) =>
		JSON.parse(await session.dispatch(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params })))
	try {
		const first = await rpc('launcher.query', { revision: 1, text: '1 / 3', limit: 10 })
		expect(first.result.results[0].title).toBe('0.3333333333')
		const old = first.result.results[0].action.handle
		const second = await rpc('launcher.query', { revision: 2, text: '2+3', limit: 10 })
		expect(await rpc('launcher.action', { handle: old })).toMatchObject({
			error: { message: 'Action handle revoked' },
		})
		expect(
			await rpc('launcher.action', { handle: second.result.results[0].action.handle }),
		).toMatchObject({ result: { committed: true } })
		expect(writes).toEqual(['5'])
		expect(
			await rpc('host.config', { plugin: 'Calculator', patch: { precision: 3 } }),
		).toMatchObject({ result: { ok: true, application: 'applied' } })
		expect(await rpc('cli.execute', { argv: ['calc', '1/3'] })).toMatchObject({
			result: { ok: true, value: { text: '0.333', precision: 3 } },
		})
		await rpc('host.stop', { plugin: 'CalculatorLauncher' })
		const stopped = await rpc('launcher.query', { revision: 3, text: '1/3', limit: 10 })
		expect(stopped.result.results).toEqual([])
		expect(await rpc('cli.execute', { argv: ['calc', '1/3'] })).toMatchObject({
			result: { ok: true, value: { text: '0.333' } },
		})
		await rpc('host.startNode', { plugin: 'CalculatorLauncher' })
		const restarted = await rpc('launcher.query', { revision: 4, text: '1/3', limit: 10 })
		expect(restarted.result.results[0].title).toBe('0.333')
		expect(await rpc('launcher.action', { handle: old })).toMatchObject({
			error: { message: 'Action handle revoked' },
		})
	} finally {
		await session.close()
	}
})

import { BasePlugin, Plugin } from '@pluxel/core'
import { createTestHost } from '@pluxel/test'
@Plugin()
class QueryInspector extends BasePlugin {
	query(revision: number) {
		return this.ctx.root.require(LauncherControl).query({ revision, text: 'test', limit: 10 })
	}
}
@Plugin()
class BrokenQuery extends BasePlugin {
	protected override init() {
		this.ctx.require(Launcher).register('broken', async () => [
			{
				id: 'bad',
				title: 'must not publish',
				subtitle: '',
				action: { label: 'bad', execute: async () => null },
			},
		])
		throw new Error('Expected init failure')
	}
}
let releaseQuery: () => void
let queryEntered: () => void
let ownerCancelled: () => void
@Plugin()
class DelayedQuery extends BasePlugin {
	protected override init() {
		this.ctx.require(Launcher).register('delayed', async ({ signal }) => {
			signal.addEventListener('abort', () => ownerCancelled(), { once: true })
			queryEntered()
			await new Promise<void>((resolve) => {
				releaseQuery = resolve
			})
			return [
				{
					id: 'late',
					title: 'must not publish after stop',
					subtitle: '',
					action: { label: 'late', execute: async () => null },
				},
			]
		})
	}
}
it('failed init and late owner results never publish contributions', async () => {
	await using host = await createTestHost({
		services: [
			launcher({
				async request() {
					return { accepted: true }
				},
			}),
		],
	})
	const inspector = await host.start(QueryInspector)
	const failed = await host.commitExpectFail((change) => {
		change.start(BrokenQuery)
	})
	expect(failed.lifecycleReport.issues).toEqual(
		expect.arrayContaining([expect.objectContaining({ kind: 'start-failed' })]),
	)
	expect(await inspector.query(1)).toMatchObject({ results: [] })
	await host.stop(BrokenQuery)
	await host.start(DelayedQuery)
	const entered = new Promise<void>((resolve) => {
		queryEntered = resolve
	})
	const cancelled = new Promise<void>((resolve) => {
		ownerCancelled = resolve
	})
	const query = inspector.query(2)
	await entered
	const stop = host.stop(DelayedQuery)
	await cancelled
	releaseQuery()
	expect(await query).toMatchObject({ results: [] })
	await stop
	expect(await inspector.query(3)).toMatchObject({ results: [] })
})
