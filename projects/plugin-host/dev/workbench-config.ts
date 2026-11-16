import type { Script } from '@pluxel/agent-sdk/host'
import { ReportStudioPlugin } from '../src/showcase/ReportStudio'

/** Current class selection for browser acceptance; generated descriptors provide schema I/O. */
export default ((sdk) => sdk.plugin(ReportStudioPlugin.nodeAddress()).config.get()) satisfies Script

/** Restore only the field changed by explicit --save browser acceptance. */
export const restoreOutboundPath = ((sdk, run) => {
	const input = run.input
	if (
		!input ||
		typeof input !== 'object' ||
		!('hadOverride' in input) ||
		typeof input.hadOverride !== 'boolean'
	)
		throw new TypeError('restoreOutboundPath requires { hadOverride, value? }')
	if (input.hadOverride && (!('value' in input) || typeof input.value !== 'string'))
		throw new TypeError('An existing outboundPath override must be a string')
	const { patch } = sdk.plugin(ReportStudioPlugin.nodeAddress()).config
	return patch(
		input.hadOverride
			? { set: { outboundPath: 'value' in input ? input.value : undefined } }
			: { remove: [['outboundPath']] },
	)
}) satisfies Script
