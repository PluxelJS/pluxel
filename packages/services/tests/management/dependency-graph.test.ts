import { BasePlugin, definePluginRef, parsePluginNodeAddress, Plugin } from '@pluxel/core'
import { createHost } from '@pluxel/host'
import { RpcStub } from 'capnweb'
import { expect, it } from 'vitest'
import { managementAccess } from '../../src/management/access'
import { createRuntimeManagementClient } from '../../src/management/client'
import { createHostManagementTarget, management } from '../../src/management/service'

abstract class Journal extends BasePlugin {}

@Plugin(Journal)
class LocalJournal extends Journal {}

@Plugin()
class ReceiptWriter extends BasePlugin {}

@Plugin()
class AuditTrail extends BasePlugin {}

const Audit = definePluginRef<AuditTrail>()

@Plugin({ forkable: true })
class Checkout extends BasePlugin {
	constructor(
		readonly journal: Journal,
		readonly receipts: ReceiptWriter,
	) {
		super()
	}

	init() {
		this.plugins.use(Audit, () => undefined)
	}
}

@Plugin(Journal)
class RecursiveJournal extends Journal {
	constructor(readonly checkout: Checkout) {
		super()
	}
}

const consumer = parsePluginNodeAddress(Checkout.nodeAddress())
const provider = parsePluginNodeAddress(LocalJournal.nodeAddress())
const requirement = Journal.address()
const start = { address: consumer, command: 'start' } as const

it('shows declared edges before startup and effective edges only for the active graph', async () => {
	await using host = await createHost({
		plugins: [{ plugin: LocalJournal }, { plugin: ReceiptWriter }, { plugin: Checkout }],
		policy: { document: false },
		services: [managementAccess(), management()],
	})
	await host.start()
	using remote = new RpcStub(createHostManagementTarget(host.ctx))
	const client = createRuntimeManagementClient(remote)
	const dormant = Checkout.nodeAddress('preview')
	await client.forks.ensure({ fork: dormant })
	const declared = await client.dependencies.graph()
	expect(declared.edges).toContainEqual({
		consumer,
		requirement,
		mode: 'required',
		resolution: { state: 'unresolved' },
		effective: false,
	})

	expect(await client.plugins.applyLifecycleCommands([start])).toMatchObject({ ok: true })
	const active = await client.dependencies.graph()
	const effectiveEdges = active.edges.filter(({ effective }) => effective)
	expect(effectiveEdges).toEqual(
		expect.arrayContaining([
			{
				consumer,
				requirement,
				mode: 'required',
				resolution: { state: 'resolved', via: 'provider-default', provider },
				effective: true,
			},
			{
				consumer,
				requirement: ReceiptWriter.address(),
				mode: 'required',
				resolution: {
					state: 'resolved',
					via: 'direct',
					provider: parsePluginNodeAddress(ReceiptWriter.nodeAddress()),
				},
				effective: true,
			},
		]),
	)
	expect(effectiveEdges).toHaveLength(2)
	expect(active.edges).toContainEqual(
		expect.objectContaining({
			consumer,
			requirement: AuditTrail.address(),
			mode: 'optional',
			effective: false,
		}),
	)
	expect(active.edges).toContainEqual(
		expect.objectContaining({
			consumer: parsePluginNodeAddress(dormant),
			requirement,
			effective: false,
		}),
	)
})

it('rejects a dependency cycle and keeps both the saved policy and the committed graph', async () => {
	await using host = await createHost({
		plugins: [
			{ plugin: LocalJournal },
			{ plugin: ReceiptWriter },
			{ plugin: Checkout },
			{ plugin: RecursiveJournal },
		],
		policy: { document: false },
		services: [managementAccess(), management()],
	})
	await host.start()
	using remote = new RpcStub(createHostManagementTarget(host.ctx))
	const client = createRuntimeManagementClient(remote)
	expect(
		await client.dependencies.setConsumerOverride({ consumer, requirement, provider }),
	).toMatchObject({
		ok: true,
	})
	expect(await client.plugins.applyLifecycleCommands([start])).toMatchObject({ ok: true })
	const before = await client.dependencies.graph()
	const policy = await client.policy.get()
	expect(
		await client.dependencies.setConsumerOverride({
			consumer,
			requirement,
			provider: RecursiveJournal.nodeAddress(),
		}),
	).toMatchObject({ ok: false, code: 'graph_rejected', state: 'unchanged' })
	expect(await client.policy.get()).toEqual(policy)
	expect(await client.dependencies.graph()).toEqual(before)
})
