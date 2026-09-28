import { Result, TaggedError } from '@pluxel/core/better-result'
import { CanvasError, type CanvasPlugin, type Image } from '../../src/index.ts'

export class ImageRejected extends TaggedError('ImageRejected')<{
	reason: 'invalid_image' | 'too_large'
}> {}

// An ordinary business helper; pass the consumer's injected CanvasPlugin.
export async function decodeUpload(
	canvas: CanvasPlugin,
	data: Uint8Array,
	signal?: AbortSignal,
): Promise<Result<Image, ImageRejected>> {
	try {
		return Result.ok(await canvas.decodeImage(data, { signal }))
	} catch (error) {
		if (error instanceof CanvasError) {
			if (error.code === 'INVALID_IMAGE') {
				return Result.err(new ImageRejected({ reason: 'invalid_image' }))
			}
			if (
				error.code === 'IMAGE_BYTES_EXCEEDED' ||
				error.code === 'DIMENSIONS_EXCEEDED' ||
				error.code === 'PIXELS_EXCEEDED'
			) {
				return Result.err(new ImageRejected({ reason: 'too_large' }))
			}
		}
		throw error
	}
}
