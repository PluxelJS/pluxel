import type { PluginConstructor } from '@pluxel/runtime'
import type { RuntimeTestHost } from '@pluxel/runtime/test'
import type { RpcStub } from '@pluxel/runtime/capnweb'
import type { WorkbenchAttachmentPlacement } from '@pluxel/runtime/workbench'
import type { WorkbenchFederatedViewRef } from '@pluxel/runtime/workbench/client'
import { ConsumerWorkbench } from '../src/test-fixtures.ts'
import type { WretchSettingsApi } from '../src/workbench.ts'

/** The helper deliberately exposes only the provider API exercised by Wretch tests. */
type WretchSettingsLease = Readonly<{
	kind: 'attachment'
	api: RpcStub<WretchSettingsApi>
	consumer: undefined
	params: Readonly<Record<string, string>>
	federatedViewRef: WorkbenchFederatedViewRef
	[Symbol.dispose](): void
}>

export async function openWretchSettings(
	host: RuntimeTestHost,
	consumer: PluginConstructor,
	entry: WorkbenchAttachmentPlacement<WretchSettingsApi> = ConsumerWorkbench.settings,
): Promise<WretchSettingsLease> {
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
