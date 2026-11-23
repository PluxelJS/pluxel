import { BasePlugin, Plugin } from '@pluxel/core'
import { expect, it, vi } from 'vitest'
import { startHost } from '../../src/index'
import { startHost as startEmbeddedHost } from '../../src/embedded'
import { createWorkerHost } from '../../src/cloudflare'
import { defineHostApplication } from '../../src/application'

const ctx = {
	waitUntil(task: Promise<unknown>) {
		void task.catch(() => {})
	},
}

@Plugin()
class Failing extends BasePlugin {
	protected override init() {
		throw new Error('fixture unavailable')
	}
}

it('closes an unready root and reports the committed failing node', async () => {
	const close = vi.fn()
	const application = defineHostApplication(() => ({
		plugins: [{ plugin: Failing, autoStart: true }],
		services: [
			{
				name: 'resource',
				provides: [],
				prepare({ effects }) {
					effects.defer(close)
				},
			},
		],
	}))
	await expect(startHost(application)).rejects.toMatchObject({
		code: 'startup_rejected',
		status: { summary: { running: 0 } },
	})
	expect(close).toHaveBeenCalledOnce()
})

it('keeps the published catalog identifiable when its synchronous observer throws', async () => {
	await using host = await startHost(defineHostApplication(() => ({})))
	const before = host.catalog().revision
	const failure = new Error('publication failed')
	await expect(
		host.updateCatalog([Failing], {
			onGraphCommitted() {
				throw failure
			},
		}),
	).rejects.toThrow('publication failed')
	expect(host.catalog().revision).toBeGreaterThan(before)
	const report = await host.updateCatalog([])
	expect(report.catalogRevision).toBe(host.catalog().revision)
})

@Plugin()
class Feature extends BasePlugin {}

it.each([startHost, startEmbeddedHost])(
	'evaluates env, plugins, services and hooks once per fresh embedded root',
	async (start) => {
		const hooks: string[] = []
		const app = defineHostApplication(({ env }) => {
			expect(Object.isFrozen(env)).toBe(true)
			const enabled = env.FEATURE === 'on'
			return {
				plugins: enabled ? [{ plugin: Feature, autoStart: true }] : [],
				services: enabled
					? [
							{
								name: 'feature',
								provides: [],
								prepare() {
									hooks.push('service')
								},
							},
						]
					: [],
				prepare() {
					hooks.push('prepare')
				},
				acceptStartup({ status }) {
					return status.summary.running === Number(enabled)
				},
				launch() {
					hooks.push('launch')
				},
			}
		})
		await using a = await start(app, { env: { FEATURE: 'on' } })
		await using b = await start(app, { env: { FEATURE: 'off' } })
		expect(hooks).toEqual(['service', 'prepare', 'launch', 'prepare', 'launch'])
		expect(a.ctx).not.toBe(b.ctx)
	},
)

it('publishes a changed deployment after acceptance and drains only the previous root', async () => {
	const started: string[] = []
	const stopped: string[] = []
	const inside = Promise.withResolvers<void>()
	const finish = Promise.withResolvers<void>()
	await using worker = createWorkerHost(
		defineHostApplication(({ env }) => {
			const name = env.REGION!
			started.push(name)
			return {
				name,
				prepare({ host }) {
					host.ctx.effects.defer(() => {
						stopped.push(name)
					})
				},
				acceptStartup() {
					return name !== 'invalid'
				},
			}
		}),
	)
	const env = { REGION: 'east', FEATURE: '1' }
	let firstScope: unknown
	const first = worker.run({ env, ctx }, async (sdk) => {
		firstScope = sdk.ctx
		inside.resolve()
		await finish.promise
	})
	await inside.promise
	try {
		await worker.run({ env: { FEATURE: '1', REGION: 'east' }, ctx }, (sdk) => {
			expect(sdk.ctx).not.toBe(firstScope)
		})
		env.REGION = 'invalid'
		await expect(worker.run({ env, ctx }, () => {})).rejects.toMatchObject({
			code: 'startup_rejected',
		})
		await worker.run({ env: { FEATURE: '1', REGION: 'east' }, ctx }, () => {})
		env.REGION = 'west'
		const west = worker.run({ env, ctx }, () => {})
		env.REGION = 'changed-after-call'
		await west
		expect(started).toEqual(['east', 'invalid', 'west'])
		expect(stopped).toEqual(['invalid'])
	} finally {
		finish.resolve()
		await first
	}
	expect(stopped).toEqual(['invalid', 'east'])
	await Promise.all([worker.close(), worker.close()])
	expect(stopped).toEqual(['invalid', 'east', 'west'])
	await expect(worker.run({ ctx }, () => {})).rejects.toThrow('closed')
})

it('shares cold failure, wakes waiters and retries on the next event', async () => {
	const gate = Promise.withResolvers<void>()
	let calls = 0
	await using worker = createWorkerHost(
		defineHostApplication(async () => {
			if (++calls === 1) {
				await gate.promise
				throw new Error('cold failure')
			}
			return {}
		}),
	)
	const both = Promise.allSettled([worker.run({ ctx }, () => {}), worker.run({ ctx }, () => {})])
	gate.resolve()
	const results = await both
	expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])
	await worker.run({ ctx }, () => {})
	expect(calls).toBe(2)
})

it('publishes cold edits, blocks admission during warm edits, and reopens after rejection', async () => {
	let implementation: typeof Feature | undefined
	const published = vi.fn((): undefined => {
		implementation = Feature
	})
	const select = vi.fn(({ env }: { env: Readonly<Record<string, string | undefined>> }) =>
		env.FEATURE === '1' ? [Feature] : [],
	)
	const start = vi.fn(() => ({ plugins: implementation ? [{ plugin: implementation }] : [] }))
	await using worker = createWorkerHost(defineHostApplication(start))
	expect(await worker.updateCatalog(select, { onGraphCommitted: published })).toBeUndefined()
	expect(start).not.toHaveBeenCalled()
	expect(select).not.toHaveBeenCalled()
	const finish = Promise.withResolvers<void>()
	const admitted = Promise.withResolvers<void>()
	const first = worker.run({ ctx, env: { FEATURE: '1' } }, async () => {
		admitted.resolve()
		await finish.promise
	})
	await admitted.promise
	const update = worker.updateCatalog(select, { onGraphCommitted: published })
	const callback = vi.fn(() => published.mock.calls.length)
	const next = worker.run({ ctx, env: { FEATURE: '1' } }, callback)
	await Promise.resolve()
	expect(callback).not.toHaveBeenCalled()
	finish.resolve()
	await first
	const report = await update
	expect(report?.catalogRevision).toBeGreaterThan(1)
	expect(await next).toBe(2)
	expect(select).toHaveBeenCalledExactlyOnceWith({ env: { FEATURE: '1' } })
	await expect(
		worker.updateCatalog(() => [undefined as never], { onGraphCommitted: published }),
	).rejects.toThrow(/constructor/)
	await worker.run({ ctx, env: { FEATURE: '1' } }, () => {})
	expect(start).toHaveBeenCalledOnce()
})

it('keeps the latest accepted deployment when a superseded cold start finishes late', async () => {
	const preparing = Promise.withResolvers<void>()
	const finish = Promise.withResolvers<void>()
	const started: string[] = []
	const stopped: string[] = []
	await using worker = createWorkerHost(
		defineHostApplication(({ env }) => ({
			async prepare({ host }) {
				const region = env.REGION!
				started.push(region)
				host.ctx.effects.defer(() => {
					stopped.push(region)
				})
				if (region === 'east') {
					preparing.resolve()
					await finish.promise
				}
			},
		})),
	)
	const old = worker.run({ ctx, env: { REGION: 'east' } }, () => 'east')
	await preparing.promise
	try {
		await worker.run({ ctx, env: { REGION: 'west' } }, () => {})
	} finally {
		finish.resolve()
		await old
	}
	await worker.run({ ctx, env: { REGION: 'west' } }, () => {})
	expect(started).toEqual(['east', 'west'])
	expect(stopped).toEqual(['east'])
})
