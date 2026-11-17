import { defineDevConsole } from '@pluxel/host-vite/console'
import { ReportStudioPlugin } from '../src/showcase/ReportStudio'

/** Saved/effective authority for the browser ConfigForm acceptance. */
export default defineDevConsole((dev) => dev.config.get(ReportStudioPlugin))

/** Restore only the field changed by explicit --save browser acceptance. */
export const restoreOutboundPath = defineDevConsole((dev) => {
	const input = dev.input
	if (
		!input ||
		typeof input !== 'object' ||
		!('hadOverride' in input) ||
		typeof input.hadOverride !== 'boolean'
	)
		throw new TypeError('restoreOutboundPath requires { hadOverride, value? }')
	if (input.hadOverride && (!('value' in input) || typeof input.value !== 'string'))
		throw new TypeError('An existing outboundPath override must be a string')
	return dev.config.patch(
		ReportStudioPlugin,
		input.hadOverride
			? { set: { outboundPath: 'value' in input ? input.value : undefined } }
			: { remove: [['outboundPath']] },
	)
})
