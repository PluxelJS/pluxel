import { BasePlugin, Plugin } from '@pluxel/core'
import { createPluginLogPolicyStore } from '@pluxel/core/logging'
import { createHost, type HostDocumentStorage } from '@pluxel/host'
import { RpcStub } from 'capnweb'
import * as v from 'valibot'
import { expect, it } from 'vitest'
import { managementAccess } from '../../src/management/access'
import { createRuntimeManagementClient } from '../../src/management/client'
import { createHostManagementTarget, management } from '../../src/management/service'

let restored: string | undefined

@Plugin({ forkable: true })
class Archive extends BasePlugin {
	readonly config = this.configs.use(v.object({ restore: v.optional(v.boolean(), false) }))

	async init() {
		const files = await this.ctx.fs()
		if (this.config.restore) restored = await files.readFile('archive.txt', 'utf8')
		else await files.writeFile('archive.txt', 'a saved report')
	}
}

const fork = Archive.nodeAddress('customer')
const start = { address: fork, command: 'start' } as const

it('keeps a running fork in place when its configuration document is read-only', async () => {
	await using host = await createHost({
		plugins: [{ plugin: Archive }],
		services: [managementAccess(), management()],
		config: { document: { readOnly: true } },
	})
	await host.start()
	using remote = new RpcStub(createHostManagementTarget(host.ctx))
	const operator = createRuntimeManagementClient(remote)
	await operator.forks.ensure({ fork, autoStart: true })
	await operator.plugins.applyLifecycleCommands([start])
	expect(await operator.forks.remove(fork)).toMatchObject({
		ok: false,
		code: 'mutation_rejected',
		state: 'unchanged',
	})
	expect(await operator.plugins.status(fork)).toMatchObject({
		value: { lifecycleState: 'running', autoStart: true },
	})
})

it.each(['configuration', 'log policy'] as const)(
	'retries %s cleanup for a stopped fork and leaves its business data available on redeploy',
	async (metadata) => {
		let fail = false
		let body: string | undefined
		const storage: HostDocumentStorage = {
			async getText() {
				return body
			},
			async stat() {
				return body === undefined ? undefined : {}
			},
			async put(_key, value) {
				if (fail) throw new Error('metadata acknowledgement failed')
				body = value
			},
		}
		await using host = await createHost({
			plugins: [{ plugin: Archive }],
			services: [managementAccess(), management()],
			config: metadata === 'configuration' ? { document: { storage: () => storage } } : {},
			coreConfig:
				metadata === 'log policy'
					? {
							logtape: {
								input: { sinks: {}, loggers: [{ category: [], lowestLevel: 'fatal', sinks: [] }] },
								options: { policyStore: () => createPluginLogPolicyStore(storage) },
							},
						}
					: {},
		})
		await host.start()
		using remote = new RpcStub(createHostManagementTarget(host.ctx))
		const operator = createRuntimeManagementClient(remote)
		expect(await operator.forks.ensure({ fork, autoStart: true })).toMatchObject({
			ok: true,
			status: 'deferred',
		})
		await operator.forks.ensure({ fork })
		if (metadata === 'configuration') {
			await operator.config.patch(fork, { set: { restore: false } })
		} else {
			const policy = await operator.logging.getPolicy()
			await operator.logging.setPluginLevel(policy.revision, fork, 'debug')
		}
		expect(body).toBeDefined()
		expect(await operator.plugins.applyLifecycleCommands([start])).toMatchObject({ ok: true })

		fail = true
		expect(await operator.forks.remove(fork)).toMatchObject({
			ok: false,
			code: 'persistence_failed',
			state: 'stopped-retained',
			fork,
		})
		expect(await operator.plugins.status(fork)).toMatchObject({
			value: { lifecycleState: 'stopped', autoStart: true },
		})

		fail = false
		expect(await operator.forks.remove(fork)).toMatchObject({ ok: true, status: 'removed' })
		expect(await operator.plugins.status(fork)).toEqual({ ok: true, value: null })
		expect(await operator.forks.ensure({ fork })).toMatchObject({ ok: true })
		const replacement =
			metadata === 'configuration'
				? await operator.config.get(fork)
				: await operator.logging.getPolicy()
		expect(replacement).toMatchObject(
			metadata === 'configuration' ? { managedInput: null } : { overrides: [] },
		)
		await operator.config.patch(fork, { set: { restore: true } })
		restored = undefined
		expect(await operator.plugins.applyLifecycleCommands([start])).toMatchObject({ ok: true })
		expect(restored).toBe('a saved report')
	},
)

it('rejects a configuration write queued during removal before the same fork is redeployed', async () => {
	let body: string | undefined
	let deleting = false
	const entered = Promise.withResolvers<void>()
	const release = Promise.withResolvers<void>()
	const storage: HostDocumentStorage = {
		async getText() {
			return body
		},
		async stat() {
			return body === undefined ? undefined : {}
		},
		async put(_key, value) {
			if (deleting) {
				entered.resolve()
				await release.promise
			}
			body = value
		},
	}
	await using host = await createHost({
		plugins: [{ plugin: Archive }],
		services: [managementAccess(), management()],
		config: { document: { storage: () => storage } },
	})
	await host.start()
	using remote = new RpcStub(createHostManagementTarget(host.ctx))
	const operator = createRuntimeManagementClient(remote)
	await operator.forks.ensure({ fork })
	await operator.config.patch(fork, { set: { restore: false } })

	deleting = true
	const removal = operator.forks.remove(fork)
	const patch = entered.promise.then(() => {
		const result = operator.config.patch(fork, { set: { restore: true } })
		release.resolve()
		return result
	})
	expect(await removal).toMatchObject({ ok: true, status: 'removed' })
	expect(await patch).toMatchObject({ ok: false, code: 'node_unavailable', state: 'unchanged' })
	await operator.forks.ensure({ fork })
	expect(await operator.config.get(fork)).toMatchObject({ ok: true, managedInput: null })
})

@Plugin({ forkable: true })
class FailingDrain extends BasePlugin {
	init() {
		return () => {
			throw new Error('closing report stream failed')
		}
	}
}

it('returns a removed fork with its drain issue still present in the receipt', async () => {
	await using host = await createHost({
		plugins: [{ plugin: FailingDrain }],
		services: [managementAccess(), management()],
	})
	await host.start()
	using remote = new RpcStub(createHostManagementTarget(host.ctx))
	const operator = createRuntimeManagementClient(remote)
	const address = FailingDrain.nodeAddress('customer')
	await operator.forks.ensure({ fork: address })
	await operator.plugins.applyLifecycleCommands([{ address, command: 'start' }])
	expect(await operator.forks.remove(address)).toMatchObject({
		ok: true,
		status: 'removed-with-lifecycle-issues',
		report: {
			core: {
				summary: {
					lifecycleReport: {
						issues: [{ plugin: address, phase: 'drain', kind: 'drain-failed' }],
					},
				},
			},
		},
	})
	expect(await operator.plugins.status(address)).toEqual({ ok: true, value: null })
})
