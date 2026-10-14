import * as v from 'valibot'

/** Deployment limits; updating saved configuration requires plugin restart. */
export const FiscalTicketConfig = v.object({
	/** Total budget including context acquisition, navigation and human interaction. */
	timeoutMs: v.optional(
		v.pipe(v.number(), v.integer(), v.minValue(1000), v.maxValue(600_000)),
		120_000,
	),
	/** Reject excess calls with BUSY; the plugin does not queue or retry. */
	maxConcurrent: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(8)), 1),
})
