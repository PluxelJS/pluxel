import type { ProjectScript } from '@pluxel/host-vite/project'
import { ReportStudioPlugin } from '../src/showcase/ReportStudio'

/** Saved/effective authority for the browser ConfigForm acceptance. */
export default ((sdk) =>
	sdk.plugin(sdk.dev.address(ReportStudioPlugin)).config.get()) satisfies ProjectScript

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
	const { patch } = sdk.plugin(sdk.dev.address(ReportStudioPlugin)).config
	return patch(
		input.hadOverride
			? { set: { outboundPath: 'value' in input ? input.value : undefined } }
			: { remove: [['outboundPath']] },
	)
}) satisfies ProjectScript
