import {
	Image as NativeImage,
	SvgExportFlag,
	createCanvas as createNativeCanvas,
} from '@napi-rs/canvas'
import {
	CanvasError,
	type CanvasWorkerAdapter,
	type CanvasWorkerSnapshot,
	type DecodeImageOptions,
} from './contracts.ts'
import { DecodeScheduler } from './decode-scheduler.ts'
import {
	assertCanvasDimensions,
	normalizeCanvasWorkerSnapshot,
	resolveImageDataOwnership,
} from './worker-internal.ts'

const neverAbortSignal = new AbortController().signal

/** Create a caller-owned native Canvas adapter from a detached host policy snapshot. */
export function createCanvasWorkerAdapter(snapshot: CanvasWorkerSnapshot): CanvasWorkerAdapter {
	const normalized = normalizeCanvasWorkerSnapshot(snapshot)
	const scheduler = new DecodeScheduler(
		normalized.decodeLimits.maxConcurrent,
		normalized.decodeLimits.maxQueued,
		normalized.decodeLimits.maxQueued,
	)
	const schedulerOwner = scheduler.createOwner()
	let active = true
	const requireActive = (): void => {
		if (!active) throw new CanvasError('NOT_RUNNING', 'Canvas worker adapter is closed')
	}
	const adapter: CanvasWorkerAdapter = {
		snapshot: normalized,
		async close() {
			if (!active) {
				await scheduler.close(new CanvasError('NOT_RUNNING', 'Canvas worker adapter is closed'))
				return
			}
			active = false
			await scheduler.close(new CanvasError('NOT_RUNNING', 'Canvas worker adapter is closed'))
		},
		createCanvas(width, height) {
			requireActive()
			assertCanvasDimensions(width, height, normalized.limits)
			const canvas = createNativeCanvas(width, height)
			canvas.getContext('2d').font = `10px ${normalized.font.cssFamily}`
			return canvas
		},
		createSvgCanvas(width, height, options = {}) {
			requireActive()
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
			requireActive()
			return new NativeImage()
		},
		decodeImageInto(image, data, options = {}) {
			if (!active) {
				return Promise.reject(new CanvasError('NOT_RUNNING', 'Canvas worker adapter is closed'))
			}
			if (!(image instanceof NativeImage)) {
				return Promise.reject(
					new CanvasError(
						'INVALID_IMAGE',
						'decodeImageInto() requires a worker-local Canvas Image',
					),
				)
			}
			return decodeImage(image, data, normalized, scheduler, schedulerOwner, options)
		},
		decodeImage(data, options = {}) {
			if (!active) {
				return Promise.reject(new CanvasError('NOT_RUNNING', 'Canvas worker adapter is closed'))
			}
			return decodeImage(new NativeImage(), data, normalized, scheduler, schedulerOwner, options)
		},
	}
	return Object.freeze(adapter)
}

async function decodeImage(
	image: NativeImage,
	data: Uint8Array,
	snapshot: CanvasWorkerSnapshot,
	scheduler: DecodeScheduler,
	schedulerOwner: ReturnType<DecodeScheduler['createOwner']>,
	options: DecodeImageOptions,
): Promise<NativeImage> {
	if (!(data instanceof Uint8Array) || data.byteLength <= 0) {
		throw new CanvasError('INVALID_IMAGE', 'decodeImage() requires non-empty Uint8Array data')
	}
	if (data.byteLength > snapshot.limits.maxImageBytes) {
		throw new CanvasError(
			'IMAGE_BYTES_EXCEEDED',
			`Encoded image is ${data.byteLength} bytes; the configured limit is ${snapshot.limits.maxImageBytes}`,
		)
	}
	const dataOwnership = resolveImageDataOwnership(options)
	if (options.signal !== undefined && !isAbortSignal(options.signal)) {
		throw new CanvasError('INVALID_IMAGE', 'signal must be an AbortSignal')
	}
	const signal = options.signal ?? neverAbortSignal
	return scheduler.run(schedulerOwner, signal, async (hold): Promise<NativeImage> => {
		const source = dataOwnership === 'owned' ? data : Buffer.from(data)
		const task = decodeNativeImageInto(image, source).catch((cause: unknown) => {
			throw new CanvasError('INVALID_IMAGE', 'Native image decoder rejected the image data', {
				cause,
			})
		})
		hold(task)
		const decoded = await waitForDecode(task, signal)
		assertCanvasDimensions(decoded.width, decoded.height, snapshot.limits)
		return decoded
	})
}

function decodeNativeImageInto(image: NativeImage, source: Uint8Array): Promise<NativeImage> {
	return new Promise<NativeImage>((resolve, reject) => {
		let settled = false
		const settle = (callback: () => void): void => {
			if (settled) return
			settled = true
			image.onload = undefined
			image.onerror = undefined
			callback()
		}
		image.onload = () => {
			void image.decode().then(
				() => settle(() => resolve(image)),
				(cause: unknown) => settle(() => reject(cause)),
			)
		}
		image.onerror = (cause) => settle(() => reject(cause))
		try {
			image.src = source
		} catch (cause) {
			settle(() => reject(cause))
		}
	})
}

async function waitForDecode<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
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

function isAbortSignal(value: unknown): value is AbortSignal {
	return Boolean(
		value &&
		typeof value === 'object' &&
		typeof (value as AbortSignal).aborted === 'boolean' &&
		typeof (value as AbortSignal).addEventListener === 'function' &&
		typeof (value as AbortSignal).removeEventListener === 'function',
	)
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
	CanvasWorkerDecodeLimits,
	CanvasWorkerFontSnapshot,
	CanvasWorkerSnapshot,
	DecodeImageOptions,
	SvgCanvasOptions,
} from './contracts.ts'
export type { Canvas, Image, SKRSContext2D, SvgCanvas } from '@napi-rs/canvas'
