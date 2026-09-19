import type { PluginConstructor } from '@pluxel/core'
import type { WorkbenchTestHost } from '@pluxel/workbench/test'
import type { RpcStub } from 'capnweb'
import type { WorkbenchAttachmentPlacement } from '@pluxel/workbench'
import type { WorkbenchFederatedViewRef } from '@pluxel/workbench/client'
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
	host: WorkbenchTestHost,
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
