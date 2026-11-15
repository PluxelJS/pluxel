import type { PluginDefinitionAddress } from '@pluxel/core'
import type { Result } from '@pluxel/core/better-result'
import type {
	Inspection,
	InspectionFailure,
	InspectionPluginReport,
	InspectionPluginSection,
} from './inspection'
import type { ScriptInspectionOptions } from './sdk-types'

/**
 * A source environment supplies its own read-only analyzer. Host borrows it for each
 * admitted query, passes the run signal, and drains it before closing the run. The
 * backend owns any query resources and must release them before settling. It binds
 * application resolution; callers cannot redirect a selected Host to another app.
 */
export type ScriptInspectionBackend = (
	target: PluginDefinitionAddress,
	options: ScriptInspectionOptions & { readonly include?: readonly InspectionPluginSection[] },
) => Promise<
	Result<Inspection<InspectionPluginReport<readonly InspectionPluginSection[]>>, InspectionFailure>
>
