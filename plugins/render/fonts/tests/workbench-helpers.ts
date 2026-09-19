import type { PluginConstructor } from '@pluxel/core'
import type { OpenedWorkbenchTestEntry, ServiceTestHost } from '@pluxel/services/test'
import { workbench } from '@pluxel/workbench'
import { FontsPlugin } from '../src/index.ts'
import { FontsWorkbench } from '../src/workbench.ts'

export const FontsTestWorkbench = workbench.define({
	fonts: FontsWorkbench.selection.place(
		workbench.tab({ label: 'Fonts', icon: workbench.icons.Typography }),
	),
})

export function openFontsManager(
	host: ServiceTestHost,
): Promise<OpenedWorkbenchTestEntry<typeof FontsWorkbench.manager>> {
	return host.workbench.open({
		target: FontsPlugin,
		entry: FontsWorkbench.manager,
		principal: testPrincipal,
	})
}

export function openFontSelection(
	host: ServiceTestHost,
	consumer: PluginConstructor,
): Promise<OpenedWorkbenchTestEntry<typeof FontsTestWorkbench.fonts>> {
	return host.workbench.open({
		target: consumer,
		entry: FontsTestWorkbench.fonts,
		principal: testPrincipal,
	})
}

const testPrincipal = Object.freeze({ provider: 'test', subject: 'fonts-tests' })
