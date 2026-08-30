import type { PluginConstructor } from '@pluxel/runtime'
import { pluginNodeAddressOf, type RuntimeHost } from '@pluxel/runtime/test'
import { requireWorkbench } from '@pluxel/runtime/internal'
import { FontsPlugin } from '../src/index.ts'
import type { FontSelectionApi, FontsManagerApi } from '../src/workbench.ts'

type OpenedApi<Api> = Disposable & Readonly<{ api: Api }>

export async function openFontsManager(host: RuntimeHost): Promise<OpenedApi<FontsManagerApi>> {
	const backend = requireWorkbench(host.ctx)
	const target = pluginNodeAddressOf(FontsPlugin)
	const layout = backend.registry.getLayout(target)
	const entry = layout.entries.find(
		(candidate) => candidate.descriptor.kind === 'view' && candidate.descriptor.key === 'manager',
	)
	if (!entry) throw new Error('FontsPlugin published no manager View')
	const session = backend.createSession(testPrincipal, () => {})
	const opened = await session.target.openView({
		layoutRevision: layout.revision,
		target,
		descriptor: entry.descriptor,
	})
	if (!opened.ok || opened.value.kind !== 'local') {
		session.dispose()
		throw new Error('Fonts manager failed to open')
	}
	return Object.freeze({
		api: opened.value.api as FontsManagerApi,
		[Symbol.dispose]: () => session.dispose(),
	})
}

export async function openFontSelection(
	host: RuntimeHost,
	consumer: PluginConstructor,
): Promise<OpenedApi<FontSelectionApi>> {
	const backend = requireWorkbench(host.ctx)
	const target = pluginNodeAddressOf(consumer)
	const layout = backend.registry.getLayout(target)
	const entry = layout.entries.find(
		(candidate) =>
			candidate.descriptor.kind === 'attachment-placement' &&
			candidate.descriptor.provider.key === 'selection',
	)
	if (!entry) throw new Error('Consumer published no Fonts selection Attachment')
	const session = backend.createSession(testPrincipal, () => {})
	const opened = await session.target.openView({
		layoutRevision: layout.revision,
		target,
		descriptor: entry.descriptor,
	})
	if (!opened.ok || opened.value.kind !== 'attachment') {
		session.dispose()
		throw new Error('Fonts selection failed to open')
	}
	return Object.freeze({
		api: opened.value.provider as FontSelectionApi,
		[Symbol.dispose]: () => session.dispose(),
	})
}

const testPrincipal = Object.freeze({ provider: 'test', subject: 'fonts-tests' })
