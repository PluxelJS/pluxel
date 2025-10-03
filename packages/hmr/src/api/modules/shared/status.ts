import type { Context as PlxContext } from '@pluxel/core'
import * as v from 'valibot'

import { PluginStatusOverview } from '../../schema'

export function getStatusOverview(pCtx: PlxContext) {
	const { statuses, summary } = pCtx.loader.getFullPluginStatus()
	return {
		__typename: 'PluginStatusOverview' as const,
		statuses: Object.keys(statuses).map((name) => ({
			__typename: 'PluginStatusEntry' as const,
			name,
			isRunning: statuses[name].isRunning,
		})),
		summary: {
			__typename: 'PluginStatusSummary' as const,
			total: summary.total,
			running: summary.running,
			stopped: summary.stopped,
		},
	} satisfies v.InferOutput<typeof PluginStatusOverview>
}
