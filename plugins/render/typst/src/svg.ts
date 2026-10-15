import type { TypstOperationOptions } from './operation.ts'

export interface TypstSvgOptions extends TypstOperationOptions {
	/** Additional output limit; the lower of this and TypstConfig.maxOutputBytes applies. */
	readonly maxOutputBytes?: number
}
