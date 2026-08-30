import type { PluginConstructor } from '@pluxel/runtime'
import { pluginNodeAddressOf, type RuntimeHost } from '@pluxel/runtime/test'
import { requireWorkbench } from '@pluxel/runtime/internal'
import type { WorkbenchLayoutEntry } from '@pluxel/runtime/workbench/client'
import type { WretchSettingsApi } from '../src/workbench.ts'

export type OpenedWretchSettings = Disposable &
	Readonly<{
		api: WretchSettingsApi
		entry: WorkbenchLayoutEntry
	}>

export async function openWretchSettings(
	host: RuntimeHost,
	consumer: PluginConstructor,
): Promise<OpenedWretchSettings> {
	const backend = requireWorkbench(host.ctx)
	const target = pluginNodeAddressOf(consumer)
	const layout = backend.registry.getLayout(target)
	const entry = layout.entries[0]
	if (!entry) throw new Error('Wretch consumer published no settings Attachment')
	const session = backend.createSession(
		Object.freeze({ provider: 'test', subject: 'wretch-tests' }),
		() => {},
	)
	const opened = await session.target.openView({
		layoutRevision: layout.revision,
		target,
		descriptor: entry.descriptor,
	})
	if (opened.ok === false) {
		session.dispose()
		throw new Error(`Wretch settings failed to open: ${opened.code}`)
	}
	if (opened.value.kind !== 'attachment') {
		session.dispose()
		throw new Error('Wretch settings did not open as an Attachment')
	}
	return Object.freeze({
		api: opened.value.provider as WretchSettingsApi,
		entry,
		[Symbol.dispose]: () => session.dispose(),
	})
}
