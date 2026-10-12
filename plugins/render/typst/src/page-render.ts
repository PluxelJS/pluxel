import { TypstError } from './errors.ts'
import type { TypstPage } from './preview-contract.ts'

/** Rectangle in page-local Typst points. */
export interface TypstRegion {
	readonly x: number
	readonly y: number
	readonly width: number
	readonly height: number
}
export interface TypstRenderPageOptions {
	readonly revision: number
	/** One-based page number. */
	readonly page: number
	/** Pixels per Typst point; defaults to 2, maximum 8. */
	readonly scale?: number
	readonly region?: TypstRegion
}
export interface TypstPageImage {
	readonly revision: number
	readonly page: number
	readonly format: 'png'
	readonly data: Uint8Array
	/** Raster dimensions in pixels. */
	readonly width: number
	readonly height: number
	/** Actual pixel-aligned crop, in Typst points. */
	readonly region: TypstRegion
}
export function validateRenderPage(
	input: TypstRenderPageOptions,
	pages?: readonly TypstPage[],
): void {
	if (
		!input ||
		typeof input !== 'object' ||
		!Number.isSafeInteger(input.revision) ||
		input.revision < 1 ||
		!Number.isSafeInteger(input.page) ||
		input.page < 1
	)
		throw new TypstError('INVALID_INPUT', 'revision and page must be positive safe integers')
	const scale = input.scale ?? 2
	if (!Number.isFinite(scale) || scale <= 0 || Math.fround(scale) <= 0)
		throw new TypstError('INVALID_INPUT', 'scale must be positive and finite')
	if (scale > 8) throw new TypstError('LIMIT_EXCEEDED', 'scale exceeds 8 pixels per point')
	const region = input.region
	if (
		region !== undefined &&
		(!region ||
			typeof region !== 'object' ||
			![region.x, region.y, region.width, region.height].every(Number.isFinite) ||
			region.x < 0 ||
			region.y < 0 ||
			region.width <= 0 ||
			region.height <= 0)
	)
		throw new TypstError('INVALID_INPUT', 'region must be a finite positive rectangle')
	if (!pages) return
	const page = pages[input.page - 1]
	if (!page) throw new TypstError('INVALID_INPUT', 'page is outside the compiled document')
	if (region && (region.x + region.width > page.width || region.y + region.height > page.height))
		throw new TypstError('INVALID_INPUT', 'region must stay inside the page')
	const width = Math.max(1, Math.round(Math.fround(Math.fround(scale) * Math.fround(page.width))))
	const height = Math.max(1, Math.round(Math.fround(Math.fround(scale) * Math.fround(page.height))))
	if (width > 8192 || height > 8192 || width * height > 16_000_000)
		throw new TypstError(
			'LIMIT_EXCEEDED',
			'Full page raster exceeds 8192 pixels per side or 16000000 pixels; reduce scale even when cropping',
		)
}
