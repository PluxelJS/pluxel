import { BasePlugin, parsePluginNodeAddress, Plugin } from '@pluxel/core'
import { createHost } from '@pluxel/host'
import { lowerTestReplacement } from '@pluxel/test/unsafe'
import { RpcStub } from 'capnweb'
import { expect, it } from 'vitest'
import { managementAccess } from '../../src/management/access'
import { createRuntimeManagementClient } from '../../src/management/client'
import { createHostManagementTarget, management } from '../../src/management/service'

@Plugin()
class Documents extends BasePlugin {}

@Plugin({ displayName: 'Reports' })
class Reports extends BasePlugin {
	constructor(readonly documents: Documents) {
		super()
	}
}

@Plugin({ displayName: 'Reports' })
class ScheduledReports extends BasePlugin {}

it('groups stopped plugins by their declared dependencies and restores that layout after customization', async () => {
	await using host = await createHost({
		plugins: [{ plugin: Documents }, { plugin: Reports }, { plugin: ScheduledReports }],
		services: [managementAccess(), management()],
		policy: { document: false },
	})
	await host.start()
	using remote = new RpcStub(createHostManagementTarget(host.ctx))
	const { catalog } = createRuntimeManagementClient(remote)
	const initial = await catalog.snapshot()
	expect(initial.summary).toMatchObject({ total: 3, stopped: 3 })
	expect(initial.sections).toMatchObject([
		{
			name: 'Reports',
			basis: { kind: 'dependency' },
			nodes: [Documents, Reports].map((entry) => parsePluginNodeAddress(entry.nodeAddress())),
		},
	])

	const layout = {
		sections: [
			{
				sectionId: 'manual:b62dc718-884f-4679-8675-b062a77e6aff',
				name: 'Operations',
				nodes: initial.plugins.map(({ address }) => address),
			},
		],
	}
	expect(await catalog.updateLayout(layout)).toMatchObject({ ok: true })
	const customized = await catalog.snapshot()
	expect(customized.sections).toMatchObject([{ ...layout.sections[0], basis: { kind: 'manual' } }])
	expect(await catalog.updateLayout({ sections: null })).toEqual({
		ok: true,
		sections: initial.sections,
	})
})

it('keeps the exact plugin address selectable when names collide or a declaration is replaced', async () => {
	await using host = await createHost({
		plugins: [],
		services: [managementAccess(), management()],
		policy: { document: false },
	})
	await host.updateCatalog([ScheduledReports])
	using remote = new RpcStub(createHostManagementTarget(host.ctx))
	const { plugins } = createRuntimeManagementClient(remote)
	const selected = ScheduledReports.nodeAddress()
	expect(await plugins.status(selected)).toMatchObject({ value: { label: { text: 'Reports' } } })

	await host.updateCatalog([ScheduledReports, Reports, Documents])
	for (const owner of [selected, Reports.nodeAddress()]) {
		expect(await plugins.status(owner)).toMatchObject({
			value: { address: owner, label: { title: 'Reports', qualifier: expect.any(String) } },
		})
	}

	const Renamed = lowerTestReplacement(ScheduledReports, class extends ScheduledReports {}, {
		plugin: { displayName: 'Scheduled reports' },
	})
	await host.updateCatalog([Renamed, Reports, Documents])
	expect(await plugins.status(selected)).toMatchObject({
		value: { address: selected, label: { text: 'Scheduled reports' } },
	})
	expect(await plugins.status(Reports.nodeAddress())).toMatchObject({
		value: { label: { text: 'Reports' } },
	})
})
