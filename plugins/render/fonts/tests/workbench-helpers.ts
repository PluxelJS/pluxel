import type { TestHost, PluginTestTarget } from '@pluxel/test'
import type { OpenedLocalWorkbenchEntry } from '@pluxel/workbench/test'
import { workbench } from '@pluxel/workbench'
import { FontsPlugin } from '../src/index.ts'
import { FontsWorkbench } from '../src/workbench.ts'

export const FontsTestWorkbench = workbench.define(import.meta.url, {
	fonts: FontsWorkbench.selection.place({
		kind: 'tab',
		label: 'Fonts',
		icon: 'typography',
	}),
})

export function openFontsManager(
	host: TestHost<true>,
): Promise<OpenedLocalWorkbenchEntry<typeof FontsWorkbench.manager>> {
	return host.workbench.open({
		target: FontsPlugin.nodeAddress(),
		entry: FontsWorkbench.manager,
		principal: testPrincipal,
	})
}

export function openFontSelection(
	host: TestHost<true>,
	consumer: PluginTestTarget,
): Promise<OpenedLocalWorkbenchEntry<typeof FontsTestWorkbench.fonts>> {
	return host.workbench.open({
		target: consumer,
		entry: FontsTestWorkbench.fonts,
		principal: testPrincipal,
	})
}

const testPrincipal = Object.freeze({ provider: 'test', subject: 'fonts-tests' })
