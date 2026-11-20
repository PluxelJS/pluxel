import { BasePlugin, Plugin, defineServiceRef, pluginNodeAddressEqual } from '@pluxel/core'
import { elysia } from '@pluxel/services/elysia'
import { createTestHost } from '@pluxel/test'
import { workbench, type Workbench } from '@pluxel/workbench'
import { readWorkbenchLayout } from '@pluxel/workbench/client'
import { WorkbenchHost } from '@pluxel/workbench/server'
import { RpcStub, RpcTarget } from 'capnweb'
import { expect, it, vi } from 'vitest'

const WorkbenchRef = defineServiceRef<Workbench>()
const IncidentView = workbench.define({
	incident: workbench.view<IncidentPage>({
		renderer: workbench.entry(import.meta.url, './fixtures/settings.tsx'),
		placement: workbench.route('/incidents/:id', { title: 'Incident' }),
	}),
})

class IncidentPage extends RpcTarget implements Disposable {
	private acknowledged = false
	releases = 0
	constructor(
		readonly id: string,
		readonly user: string,
		readonly signal: AbortSignal,
	) {
		super()
	}
	read() {
		return { id: this.id, user: this.user, acknowledged: this.acknowledged }
	}
	acknowledge() {
		this.acknowledged = true
	}
	[Symbol.dispose]() {
		this.releases++
	}
}

@Plugin({ forkable: true })
class Alerts extends BasePlugin {
	readonly opened: IncidentPage[] = []
	waitForApproval?: () => Promise<void>

	protected override init() {
		this.ctx.service(WorkbenchRef)?.publish(IncidentView, {
			incident: async ({ principal, params, signal }) => {
				const page = new IncidentPage(params.id!, principal.subject, signal)
				this.opened.push(page)
				await this.waitForApproval?.()
				return page
			},
		})
	}
}

const incident = '/incidents/priority%201'
const operator = { provider: 'test', subject: 'operator' }

it('opens an exact fork lazily, gives each open its own state, and expires old leases when the fork stops', async () => {
	await using host = await createTestHost({ workbench: true, services: [elysia()] })
	const main = Alerts.nodeAddress()
	const night = Alerts.nodeAddress('night')
	const [mainOwner, nightOwner] = await host.start([main, night])
	const invalidate = vi.fn()
	const epoch = mainOwner.ctx.root.service(WorkbenchHost).createSession(operator, invalidate)
	try {
		using remote = new RpcStub(epoch.target)
		const directory = await readWorkbenchLayout(remote, { target: null })
		const filtered = await readWorkbenchLayout(remote, { target: night })
		expect(filtered.entries).toEqual(
			directory.entries.filter(({ target }) => pluginNodeAddressEqual(target.node, night)),
		)
		expect(filtered.entries).toHaveLength(1)
		expect(filtered.entries[0]).not.toHaveProperty('api')
		expect(mainOwner.opened).toEqual([])
		expect(nightOwner.opened).toEqual([])

		const options = { entry: IncidentView.incident, principal: operator, target: night }
		await expect(
			host.workbench.open({ ...options, location: '/reports/priority' }),
		).rejects.toMatchObject({ code: 'target_unavailable' })
		using first = await host.workbench.open({ ...options, location: incident })
		using second = await host.workbench.open({ ...options, location: incident })
		await first.api.acknowledge()
		expect(await first.api.read()).toEqual({
			id: 'priority 1',
			user: 'operator',
			acknowledged: true,
		})
		expect(await second.api.read()).toEqual({
			id: 'priority 1',
			user: 'operator',
			acknowledged: false,
		})
		first[Symbol.dispose]()
		expect(nightOwner.opened[0]?.signal.aborted).toBe(true)
		expect(nightOwner.opened[0]?.releases).toBe(1)
		await expect(second.api.read()).resolves.toMatchObject({ acknowledged: false })

		await host.stop(night)
		expect(epoch.signal.aborted).toBe(true)
		expect(invalidate).toHaveBeenCalledOnce()
		expect(nightOwner.opened.map((page) => [page.signal.aborted, page.releases])).toEqual([
			[true, 1],
			[true, 1],
		])
		await expect(second.api.read()).rejects.toBeInstanceOf(Error)
		using survivor = await host.workbench.open({ ...options, location: incident, target: main })
		await expect(survivor.api.read()).resolves.toMatchObject({ acknowledged: false })
	} finally {
		epoch.dispose()
	}
})

it('releases a target returned after an operator has canceled the open', async () => {
	await using host = await createTestHost({ workbench: true, services: [elysia()] })
	const target = Alerts.nodeAddress()
	const owner = await host.start(target)
	const entered = Promise.withResolvers<void>()
	const approval = Promise.withResolvers<void>()
	owner.waitForApproval = () => {
		entered.resolve()
		return approval.promise
	}
	const controller = new AbortController()
	const pending = host.workbench.open({
		target,
		entry: IncidentView.incident,
		location: incident,
		principal: operator,
		signal: controller.signal,
	})
	try {
		await entered.promise
		const cancellation = new Error('User closed the incident')
		controller.abort(cancellation)
		await expect(pending).rejects.toBe(cancellation)
		expect(owner.opened[0]?.signal.aborted).toBe(true)
	} finally {
		approval.resolve()
	}
	await expect.poll(() => owner.opened[0]?.releases).toBe(1)
})
