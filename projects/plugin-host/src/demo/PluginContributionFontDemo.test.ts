import { elysia } from '@pluxel/services/elysia'
import { createTestHost } from '@pluxel/test'
import { expect, it } from 'vitest'
import {
	PluginContributionFontConsumer,
	PluginContributionFontManager,
} from './PluginContributionFontDemo'
import { FONT_KIND, FONT_MANAGER_PLUGIN_NAME } from './PluginContributionFontDemo.shared'
import { FontConsumerWorkbench } from './PluginContributionFontDemo.workbench'

it('shares the font catalog while each report writes its own selection', async () => {
	await using host = await createTestHost({ workbench: true, services: [elysia()] })
	const sales = PluginContributionFontConsumer.nodeAddress('sales')
	const finance = PluginContributionFontConsumer.nodeAddress('finance')
	await host.start([PluginContributionFontManager.nodeAddress(), sales, finance])

	const options = {
		entry: FontConsumerWorkbench.appearanceFont,
		principal: { provider: 'local', subject: 'report-author' },
	}
	using financePage = await host.workbench.open({ target: finance, ...options })
	const original = await financePage.consumer.currentDto()
	const selected = { provider: FONT_MANAGER_PLUGIN_NAME, kind: FONT_KIND, id: 'editorial-serif' }
	{
		using salesPage = await host.workbench.open({ target: sales, ...options })
		const catalog = await salesPage.provider.listDto()
		expect(await financePage.provider.listDto()).toEqual(catalog)
		expect(await salesPage.consumer.currentDto()).toEqual(original)
		expect(catalog).toContainEqual(expect.objectContaining({ id: selected.id }))
		expect(original?.id).not.toBe(selected.id)
		await salesPage.consumer.set(selected)
	}

	using reopened = await host.workbench.open({ target: sales, ...options })
	expect(await reopened.consumer.currentDto()).toEqual(selected)
	expect(await financePage.consumer.currentDto()).toEqual(original)
})
