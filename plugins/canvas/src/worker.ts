import {
	Image as NativeImage,
	SvgExportFlag,
	createCanvas as createNativeCanvas,
	loadImage as loadNativeImage,
} from '@napi-rs/canvas'
import {
	CanvasError,
	type CanvasWorkerAdapter,
	type CanvasWorkerSnapshot,
	type DecodeImageOptions,
} from './contracts.ts'
import { assertCanvasDimensions, normalizeCanvasWorkerSnapshot } from './worker-internal.ts'

/** Create a thread-local native Canvas adapter from a detached host policy snapshot. */
export function createCanvasWorkerAdapter(snapshot: CanvasWorkerSnapshot): CanvasWorkerAdapter {
	const normalized = normalizeCanvasWorkerSnapshot(snapshot)
	const adapter: CanvasWorkerAdapter = {
		snapshot: normalized,
		createCanvas(width, height) {
			assertCanvasDimensions(width, height, normalized.limits)
			const canvas = createNativeCanvas(width, height)
			canvas.getContext('2d').font = `10px ${normalized.font.cssFamily}`
			return canvas
		},
		createSvgCanvas(width, height, options = {}) {
			assertCanvasDimensions(width, height, normalized.limits)
			const flags =
				options.mode === 'text-to-paths'
					? SvgExportFlag.ConvertTextToPaths
					: options.mode === 'relative-paths'
						? SvgExportFlag.RelativePathEncoding
						: SvgExportFlag.NoPrettyXML
			const canvas = createNativeCanvas(width, height, flags)
			canvas.getContext('2d').font = `10px ${normalized.font.cssFamily}`
			return canvas
		},
		createImage() {
			return new NativeImage()
		},
		decodeImage(data, options = {}) {
			return decodeImage(data, normalized, options)
		},
	}
	return Object.freeze(adapter)
}

async function decodeImage(
	data: Uint8Array,
	snapshot: CanvasWorkerSnapshot,
	options: DecodeImageOptions,
) {
	if (!(data instanceof Uint8Array) || data.byteLength <= 0) {
		throw new CanvasError('INVALID_IMAGE', 'decodeImage() requires non-empty Uint8Array data')
	}
	if (data.byteLength > snapshot.limits.maxImageBytes) {
		throw new CanvasError(
			'IMAGE_BYTES_EXCEEDED',
			`Encoded image is ${data.byteLength} bytes; the configured limit is ${snapshot.limits.maxImageBytes}`,
		)
	}
	if (options.signal?.aborted) throw abortReason(options.signal)
	let task
	try {
		task = loadNativeImage(Buffer.from(data))
	} catch (cause) {
		throw new CanvasError('INVALID_IMAGE', 'Native image decoder rejected the image data', {
			cause,
		})
	}
	const image = await waitForDecode(
		task.catch((cause: unknown) => {
			throw new CanvasError('INVALID_IMAGE', 'Native image decoder rejected the image data', {
				cause,
			})
		}),
		options.signal,
	)
	assertCanvasDimensions(image.width, image.height, snapshot.limits)
	return image
}

async function waitForDecode<T>(task: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return task
	if (signal.aborted) throw abortReason(signal)
	let rejectAbort!: (reason: Error) => void
	const aborted = new Promise<never>((_resolve, reject) => void (rejectAbort = reject))
	const listener = () => rejectAbort(abortReason(signal))
	signal.addEventListener('abort', listener, { once: true })
	try {
		return await Promise.race([task, aborted])
	} finally {
		signal.removeEventListener('abort', listener)
	}
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException('Image decode aborted', 'AbortError')
}

export { CanvasError } from './contracts.ts'
export type {
	CanvasErrorCode,
	CanvasResourceLimits,
	CanvasTextResourceLimits,
	CanvasWorkerAdapter,
	CanvasWorkerFontSnapshot,
	CanvasWorkerSnapshot,
	DecodeImageOptions,
	SvgCanvasOptions,
} from './contracts.ts'
export type { Canvas, Image, SKRSContext2D, SvgCanvas } from '@napi-rs/canvas'
