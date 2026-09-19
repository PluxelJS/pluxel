import type { PluginTestTarget } from '@pluxel/core/test'
import type {
	WorkbenchOpenableEntry,
	LocalWorkbenchEntryOptions,
	OpenedLocalWorkbenchEntry,
} from '../local-entry'
export type WorkbenchTestOpenOptions<
	Entry extends WorkbenchOpenableEntry,
	TTarget extends PluginTestTarget = PluginTestTarget,
> = Omit<LocalWorkbenchEntryOptions<Entry>, 'target'> & Readonly<{ target: TTarget }>
export interface WorkbenchTestDriver<TTarget extends PluginTestTarget = PluginTestTarget> {
	open<const Entry extends WorkbenchOpenableEntry>(
		options: WorkbenchTestOpenOptions<Entry, TTarget>,
	): Promise<OpenedLocalWorkbenchEntry<Entry>>
}
