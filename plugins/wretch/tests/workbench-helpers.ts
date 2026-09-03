import type { PluginConstructor } from '@pluxel/runtime'
import type { RuntimeTestHost } from '@pluxel/runtime/test'
import type { WorkbenchAttachmentPlacement } from '@pluxel/runtime/workbench'
import { ConsumerWorkbench } from '../src/test-fixtures.ts'
import type { WretchSettingsApi } from '../src/workbench.ts'

export async function openWretchSettings(
	host: RuntimeTestHost,
	consumer: PluginConstructor,
	entry: WorkbenchAttachmentPlacement<WretchSettingsApi> = ConsumerWorkbench.settings,
) {
	const opened = await host.workbench.open({
		target: consumer,
		entry,
		principal: Object.freeze({ provider: 'test', subject: 'wretch-tests' }),
	})
	return Object.freeze({
		kind: opened.kind,
		api: opened.provider,
		consumer: opened.consumer,
		params: opened.params,
		federatedViewRef: opened.federatedViewRef,
		[Symbol.dispose]: () => opened[Symbol.dispose](),
	})
}
