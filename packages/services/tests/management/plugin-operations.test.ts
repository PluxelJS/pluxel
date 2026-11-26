import { BasePlugin, parsePluginNodeAddress, Plugin } from '@pluxel/core'
import { createHost } from '@pluxel/host'
import { RpcStub } from 'capnweb'
import * as v from 'valibot'
import { expect, it } from 'vitest'
import { managementAccess } from '../../src/management/access'
import { createRuntimeManagementClient } from '../../src/management/client'
import { createHostManagementTarget, management } from '../../src/management/service'

abstract class Queue extends BasePlugin {}

@Plugin(Queue, { forkable: true })
class LocalQueue extends Queue {}

@Plugin(Queue)
class BackupQueue extends Queue {}

@Plugin()
class Reporter extends BasePlugin {}

const config = v.object({ endpoint: v.optional(v.pipe(v.string(), v.trim()), 'default') })

@Plugin({ forkable: true })
class Dispatcher extends BasePlugin {
	readonly config = this.configs.use(config)

	constructor(readonly queue: Queue) {
		super()
	}

	override init() {
		if (this.config.endpoint === 'offline') throw new Error('queue connection failed')
		this.configs.onUpdate(this.config, ({ desired }) => {
			if (desired.endpoint === 'offline') throw new Error('queue connection failed')
		})
	}
}

const primary = parsePluginNodeAddress(LocalQueue.nodeAddress())
const canary = LocalQueue.nodeAddress('canary')
const dispatcher = parsePluginNodeAddress(Dispatcher.nodeAddress())
const startDispatcher = { address: dispatcher, command: 'start' } as const
const conflict = { ok: false, code: 'revision_conflict', state: 'unchanged' }

function application() {
	return createHost({
		plugins: [
			{ plugin: LocalQueue },
			{ plugin: BackupQueue },
			{ plugin: Reporter },
			{
				plugin: Dispatcher,
				forks: { canary: { configMode: 'saved-first', config: { endpoint: 'offline' } } },
			},
		],
		services: [managementAccess(), management()],
		policy: {
			document: false,
			modes: { providerDefaults: 'saved-first' },
			providerDefaults: [{ token: Queue.address(), provider: primary }],
		},
		config: { document: false },
	})
}

it('reports a failed fork start, keeps its diagnostic across unrelated work, and clears it on recovery', async () => {
	await using host = await application()
	await host.start()
	using remote = new RpcStub(createHostManagementTarget(host.ctx))
	const client = createRuntimeManagementClient(remote)
	const fork = Dispatcher.nodeAddress('canary')
	const command = { address: fork, command: 'start' } as const
	const failed = await client.plugins.applyLifecycleCommands([command])
	expect(failed).toMatchObject({
		ok: false,
		status: 'applied-with-issues',
		results: [
			{
				address: fork,
				code: 'lifecycle_failed',
				control: { desiredState: 'running', lifecycleState: 'stopped' },
				report: {
					core: {
						summary: { lifecycleReport: { issues: [{ plugin: fork, kind: 'start-failed' }] } },
					},
				},
			},
		],
	})
	const graph = await client.dependencies.graph()
	expect(graph.nodes).toContainEqual(
		expect.objectContaining({
			effective: true,
			status: expect.objectContaining({
				address: parsePluginNodeAddress(fork),
				lifecycleState: 'stopped',
			}),
		}),
	)
	await client.plugins.applyLifecycleCommands([
		{ address: Reporter.nodeAddress(), command: 'start' },
	])
	expect(await client.plugins.status(Reporter.nodeAddress())).toMatchObject({
		value: { lifecycleState: 'running' },
	})
	expect(await client.plugins.status(fork)).toMatchObject({
		value: { issues: [{ message: 'queue connection failed' }] },
	})
	expect(await client.config.patch(fork, { set: { endpoint: 'ready' } })).toMatchObject({
		ok: true,
		application: 'deferred',
	})
	expect(await client.plugins.applyLifecycleCommands([command])).toMatchObject({ ok: true })
	expect(await client.plugins.status(fork)).toMatchObject({
		value: { lifecycleState: 'running', issues: [] },
	})
})

it('previews and saves input through Management, while an older editor keeps its stale revision', async () => {
	await using host = await application()
	await host.start()
	using remote = new RpcStub(createHostManagementTarget(host.ctx))
	const client = createRuntimeManagementClient(remote)
	await client.plugins.applyLifecycleCommands([startDispatcher])
	const before = await client.config.get(dispatcher)
	if (before.ok === false) throw new Error(before.message)
	const patch = { set: { endpoint: '   offline   ' } }
	const revision = { expectedManagedRevision: before.managedRevision }
	expect(
		await client.config.patchField(dispatcher, { fieldPath: '__proto__.endpoint', value: true }),
	).toMatchObject({ ok: false, code: 'invalid_input', state: 'unchanged' })
	expect(await client.config.validate(dispatcher, patch, revision)).toMatchObject({
		ok: true,
		config: { endpoint: 'offline' },
		persistence: { status: 'unchanged' },
	})
	expect(await client.config.get(dispatcher)).toMatchObject({
		managedRevision: before.managedRevision,
		managedInput: null,
	})
	const saved = await client.config.patch(dispatcher, patch, revision)
	expect(saved).toMatchObject({
		ok: true,
		managedInput: patch.set,
		config: { endpoint: 'offline' },
		application: 'saved-not-applied',
		applyFailure: { code: 'listener_failed' },
		persistence: { status: 'confirmed' },
		appliedRevision: before.appliedRevision,
	})
	if (saved.ok === false) throw new Error(saved.message)
	expect(await client.config.validate(dispatcher, { set: { endpoint: 99 } }, revision)).toEqual({
		...conflict,
		message: 'Managed config changed; refresh before editing.',
		managedRevision: saved.managedRevision,
	})
	expect(await client.config.validate(dispatcher, { set: { endpoint: 99 } })).toMatchObject({
		ok: false,
		code: 'validation_failed',
		managedRevision: saved.managedRevision,
	})
	expect(await client.config.reset(dispatcher, undefined, revision)).toMatchObject(conflict)
	expect(await client.config.get(dispatcher)).toMatchObject({ managedInput: patch.set })
	expect(
		await client.config.reset(dispatcher, undefined, {
			expectedManagedRevision: saved.managedRevision,
		}),
	).toMatchObject({
		ok: true,
		managedInput: null,
		config: { endpoint: 'default' },
	})
})

it('uses a batch receipt to undo saved auto-start choices and detects another operator’s edit', async () => {
	await using host = await application()
	await host.start()
	using first = new RpcStub(createHostManagementTarget(host.ctx))
	using second = new RpcStub(createHostManagementTarget(host.ctx))
	const client = createRuntimeManagementClient(first)
	const other = createRuntimeManagementClient(second)
	const priorPolicy = await client.policy.patch({
		autoStart: [{ node: primary, autoStart: false }],
	})
	if (priorPolicy.ok === false) throw new Error(priorPolicy.message)
	const changed = await client.plugins.setAutoStart(
		[primary, dispatcher].map((address) => ({ address, autoStart: true })),
		{ expectedManagedRevision: priorPolicy.managedRevision },
	)
	expect(changed).toMatchObject({
		ok: true,
		results: [primary, dispatcher].map((address) => ({
			address,
			control: { autoStart: true, lifecycleState: 'stopped' },
		})),
	})
	if (!changed.managedRevision) throw new Error('Expected a batch revision')
	const undo = {
		autoStart: [{ node: primary, autoStart: false }],
		reset: [{ field: 'autoStart', node: dispatcher }],
	} as const
	const afterEdit = await other.policy.patch({
		autoStart: [{ node: dispatcher, autoStart: false }],
	})
	if (afterEdit.ok === false) throw new Error(afterEdit.message)
	expect(
		await client.policy.patch(undo, { expectedManagedRevision: changed.managedRevision }),
	).toMatchObject(conflict)
	expect(await client.policy.get()).toMatchObject({ managedRevision: afterEdit.managedRevision })
	expect(
		await client.policy.patch(undo, { expectedManagedRevision: afterEdit.managedRevision }),
	).toMatchObject({
		ok: true,
		managedInput: { autoStart: [{ node: primary, autoStart: false }] },
	})
})

it('switches a running consumer to one named fork and requires clearing its reference before removal', async () => {
	await using host = await application()
	await host.start()
	using remote = new RpcStub(createHostManagementTarget(host.ctx))
	const client = createRuntimeManagementClient(remote)
	await client.plugins.applyLifecycleCommands([startDispatcher])
	const requirement = Queue.address()
	const selectFor = { consumer: dispatcher, requirement }
	const backup = parsePluginNodeAddress(BackupQueue.nodeAddress())
	expect(await client.dependencies.inspectConsumerRequirements(dispatcher)).toMatchObject({
		ok: true,
		items: [{ requirement, consumerOverride: null, inheritedProvider: primary }],
	})
	expect(
		await client.forks.ensure({
			fork: canary,
			autoStart: true,
			selectFor: { consumer: dispatcher, requirement: BackupQueue.address() },
		}),
	).toMatchObject({ ok: false, code: 'requirement_not_found', state: 'unchanged' })
	expect(await client.plugins.status(canary)).toEqual({ ok: true, value: null })
	const ensured = await client.forks.ensure({ fork: canary, selectFor })
	expect(ensured).toMatchObject({ ok: true, fork: canary, status: 'applied' })
	expect(await client.dependencies.inspectProviderPolicy(canary)).toEqual({ ok: true, value: null })
	expect(await client.dependencies.inspectProviderPolicy(primary)).toMatchObject({
		ok: true,
		value: {
			token: requirement,
			options: expect.arrayContaining([
				expect.objectContaining({ address: backup }),
				expect.objectContaining({ address: primary }),
			]),
		},
	})
	expect(
		await client.dependencies.setProviderPolicyDefault({ policyOwner: primary, provider: backup }),
	).toMatchObject({ ok: true })
	expect(await client.dependencies.inspectConsumerRequirements(dispatcher)).toMatchObject({
		ok: true,
		items: [{ requirement, consumerOverride: canary, inheritedProvider: backup }],
	})
	const graph = await client.dependencies.graph()
	expect(graph.edges).toContainEqual(
		expect.objectContaining({
			consumer: dispatcher,
			requirement,
			resolution: {
				provider: parsePluginNodeAddress(canary),
				state: 'resolved',
				via: 'dependency-override',
			},
			effective: true,
		}),
	)
	expect(await client.forks.remove(canary)).toMatchObject({
		ok: false,
		code: 'fork_referenced',
		state: 'unchanged',
		references: [selectFor],
	})
	expect(
		await client.dependencies.setConsumerOverride({ ...selectFor, provider: null }),
	).toMatchObject({ ok: true })
	expect(await client.forks.remove(canary)).toMatchObject({
		ok: true,
		status: 'removed',
		fork: canary,
	})
	expect(await client.plugins.status(canary)).toEqual({ ok: true, value: null })
	expect(await client.forks.remove(canary)).toMatchObject({ ok: true, status: 'already-absent' })
})
