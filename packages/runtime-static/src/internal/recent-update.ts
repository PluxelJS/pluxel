import {
	pluginDefinitionIndexKey,
	type PluginDefinitionAddress,
	type CommitSummary,
	type PluginNodeAddress,
	type PluginNodeSlot,
} from '@pluxel/core'
import { PluginRecentUpdateTracker, type PluginUpdateBatchSnapshot } from '@pluxel/runtime/internal'

/** Static route owns sequence and scope; common Runtime owns snapshot attribution and retention. */
export class StaticRuntimeRecentUpdateTracker extends PluginRecentUpdateTracker {
	recordDefinitions(
		definitions: Iterable<PluginDefinitionAddress>,
		result: Omit<PluginUpdateBatchSnapshot, 'sequence' | 'scope'>,
		context: Readonly<{
			scope: 'application' | 'definitions'
			lifecycle?: Readonly<{
				commit: CommitSummary
				addressOf: (slot: PluginNodeSlot) => PluginNodeAddress
			}>
		}> = { scope: 'definitions' },
	): void {
		this.record({
			definitionKeys: Array.from(definitions, pluginDefinitionIndexKey),
			batch: { ...result, scope: context.scope },
			...(context.lifecycle ? { lifecycle: context.lifecycle } : {}),
		})
	}
}
