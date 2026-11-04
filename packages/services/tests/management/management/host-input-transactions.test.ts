import { BasePlugin, Plugin } from '@pluxel/core/internal/test'
import { createServiceInternalTestHarness } from '@pluxel/services/internal/test'
import { RpcStub } from 'capnweb'
import * as v from 'valibot'
import { expect, it } from 'vitest'
import { createRuntimeManagementClient } from '../../../src/management/web/client'
import { RuntimeManagementTargetImpl } from '../../../src/management/services/management/RuntimeManagementTarget'

@Plugin()
class ManagedOwner extends BasePlugin {
	readonly config = this.configs.use(v.object({ value: v.optional(v.string(), 'default') }))
	protected override init(): void {
		this.configs.onUpdate(this.config, () => {})
	}
}

abstract class ProviderToken extends BasePlugin {}
@Plugin(ProviderToken, { forkable: true })
class ManagedProvider extends ProviderToken {}
@Plugin()
class ManagedConsumer extends BasePlugin {
	constructor(readonly provider: ProviderToken) {
		super()
	}
}

it('guards existing policy actions with the displayed revision and keeps batch session intent', async () => {
	await using host = await createServiceInternalTestHarness({ workbench: false, management: true })
	host.add([ManagedOwner, ManagedProvider, ManagedConsumer])
	await host.commit()
	using remote = new RpcStub(new RuntimeManagementTargetImpl(host.ctx))
	const client = createRuntimeManagementClient(remote)
	const owner = ManagedOwner.nodeAddress()
	const provider = ManagedProvider.nodeAddress()
	const consumer = ManagedConsumer.nodeAddress()
	const fork = ManagedProvider.nodeAddress('cas')
	const initialCatalog = await client.catalog.snapshot()
	const baseline = initialCatalog.statePolicy.managedRevision
	expect(await client.policy.get()).toMatchObject({ managedRevision: baseline })
	const batch = await client.plugins.setAutoStart(
		[
			{ address: owner, autoStart: true },
			{ address: provider, autoStart: true },
			{ address: owner, autoStart: false },
		],
		{ expectedManagedRevision: baseline },
	)
	expect(batch.ok).toBe(true)
	expect(batch.results.map((item) => item.ok && item.control.autoStart)).toEqual([
		true,
		true,
		false,
	])
	expect(host.isRunning(owner)).toBe(false)
	expect(host.isRunning(provider)).toBe(false)
	const updatedCatalog = await client.catalog.snapshot()
	const current = updatedCatalog.statePolicy.managedRevision
	expect(current).not.toBe(baseline)
	const stale = { expectedManagedRevision: baseline }
	const conflict = { ok: false, code: 'revision_conflict', state: 'unchanged' }
	expect(
		await client.plugins.setAutoStart([{ address: owner, autoStart: true }], stale),
	).toMatchObject({ ok: false, results: [conflict] })
	expect(
		await client.dependencies.setConsumerOverride(
			{ consumer, requirement: ProviderToken.definitionAddress(), provider },
			stale,
		),
	).toMatchObject(conflict)
	expect(
		await client.dependencies.setProviderPolicyDefault({ policyOwner: provider, provider }, stale),
	).toMatchObject(conflict)
	expect(await client.forks.ensure({ fork }, stale)).toMatchObject(conflict)
	expect(await client.catalog.snapshot()).toMatchObject({
		statePolicy: { managedRevision: current },
	})
	expect(await client.forks.ensure({ fork }, { expectedManagedRevision: current })).toMatchObject({
		ok: true,
	})
	expect(await client.forks.remove(fork, { expectedManagedRevision: current })).toMatchObject(
		conflict,
	)
	const forkCatalog = await client.catalog.snapshot()
	const afterFork = forkCatalog.statePolicy.managedRevision
	expect(await client.forks.remove(fork, { expectedManagedRevision: afterFork })).toMatchObject({
		ok: true,
	})
})

it('transports policy and config previews, atomic writes, resets and domain-specific CAS', async () => {
	await using host = await createServiceInternalTestHarness({ workbench: false, management: true })
	host.add(ManagedOwner)
	await host.commit()
	using remote = new RpcStub(new RuntimeManagementTargetImpl(host.ctx))
	const client = createRuntimeManagementClient(remote)
	const owner = ManagedOwner.nodeAddress()
	const policy = await client.policy.get()
	const config = await client.config.get(owner)
	if (policy.ok === false || config.ok === false)
		throw new Error('Expected initial input snapshots')
	expect(policy.managedInput).toEqual({})
	expect(config.managedInput).toBeNull()
	const preview = await client.policy.validate({ startTimeoutMs: 2100, autoStart: [owner] })
	expect(preview).toMatchObject({
		ok: true,
		persistence: { status: 'unchanged' },
		pendingExecutionFields: ['startTimeoutMs'],
	})
	expect(await client.policy.get()).toMatchObject({
		ok: true,
		managedRevision: policy.managedRevision,
		managedInput: {},
	})
	const applied = await client.policy.patch(
		{ autoStart: [owner], startTimeoutMs: 2100 },
		{ expectedManagedRevision: policy.managedRevision },
	)
	expect(applied).toMatchObject({
		ok: true,
		effective: { startTimeoutMs: 2100 },
		appliedExecution: { startTimeoutMs: 1500 },
		application: 'requires-host-recreation',
		report: {
			writtenFields: ['autoStart', 'startTimeoutMs'],
			persistence: { status: 'confirmed', retention: 'session' },
		},
	})
	expect(host.isRunning(owner)).toBe(false)
	await expect(
		client.plugins.applyLifecycleCommands([{ address: owner, command: 'start' }]),
	).resolves.toMatchObject({ ok: true })
	expect(host.isRunning(owner)).toBe(true)
	await expect(
		client.policy.reset(['autoStart'], { expectedManagedRevision: policy.managedRevision }),
	).resolves.toMatchObject({ ok: false, code: 'revision_conflict', state: 'unchanged' })
	if (applied.ok === false) throw new Error(applied.message)
	await expect(
		client.config.patch(
			owner,
			{ set: { value: 'wrong-domain' } },
			{ expectedManagedRevision: applied.managedRevision },
		),
	).resolves.toMatchObject({ ok: false, code: 'revision_conflict' })
	await expect(client.config.validate(owner, { set: { value: 'preview' } })).resolves.toMatchObject(
		{ ok: true, managedInput: { value: 'preview' }, persistence: { status: 'unchanged' } },
	)
	expect(await client.config.get(owner)).toMatchObject({
		ok: true,
		managedRevision: config.managedRevision,
		managedInput: null,
	})
	const saved = await client.config.patch(
		owner,
		{ set: { value: 'saved' } },
		{ expectedManagedRevision: config.managedRevision },
	)
	expect(saved).toMatchObject({
		ok: true,
		managedInput: { value: 'saved' },
		application: 'applied',
		persistence: { status: 'confirmed', retention: 'session' },
	})
	if (saved.ok === false) throw new Error(saved.message)
	await expect(
		client.config.reset(owner, undefined, { expectedManagedRevision: config.managedRevision }),
	).resolves.toMatchObject({ ok: false, code: 'revision_conflict' })
	await expect(
		client.config.reset(owner, [], { expectedManagedRevision: saved.managedRevision }),
	).resolves.toMatchObject({
		ok: true,
		managedRevision: saved.managedRevision,
		persistence: { status: 'unchanged' },
	})
	await expect(
		client.config.reset(owner, undefined, { expectedManagedRevision: saved.managedRevision }),
	).resolves.toMatchObject({ ok: true, managedInput: null, config: { value: 'default' } })
	await expect(
		client.policy.reset(['startTimeoutMs'], { expectedManagedRevision: applied.managedRevision }),
	).resolves.toMatchObject({ ok: true, pendingExecutionFields: [], application: 'applied' })
})
