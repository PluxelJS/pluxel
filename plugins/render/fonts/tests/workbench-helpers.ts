import type { PluginConstructor } from '@pluxel/core'
import type { WorkbenchTestHost } from '@pluxel/services/test'
import type { OpenedLocalWorkbenchEntry } from '@pluxel/workbench/test'
import { workbench } from '@pluxel/workbench'
import { FontsPlugin } from '../src/index.ts'
import { FontsWorkbench } from '../src/workbench.ts'

export const FontsTestWorkbench = workbench.define({
	fonts: FontsWorkbench.selection.place(
		workbench.tab({ label: 'Fonts', icon: workbench.icons.Typography }),
	),
})

export function openFontsManager(
	host: WorkbenchTestHost,
): Promise<OpenedLocalWorkbenchEntry<typeof FontsWorkbench.manager>> {
	return host.workbench.open({
		target: FontsPlugin,
		entry: FontsWorkbench.manager,
		principal: testPrincipal,
	})
}

export function openFontSelection(
	host: WorkbenchTestHost,
	consumer: PluginConstructor,
): Promise<OpenedLocalWorkbenchEntry<typeof FontsTestWorkbench.fonts>> {
	return host.workbench.open({
		target: consumer,
		entry: FontsTestWorkbench.fonts,
		principal: testPrincipal,
	})
}

const testPrincipal = Object.freeze({ provider: 'test', subject: 'fonts-tests' })
