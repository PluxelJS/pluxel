import type { Context } from '@pluxel/core'
import {
	defineContextCapability,
	installOwnerViewCapability,
	enterOwnerInvocation,
} from '@pluxel/core/host'
import { defineHostService } from '@pluxel/host'
import { Observations } from './observation'
export interface NetworkApi {
	readonly fetch: typeof fetch
}
export interface NetworkPolicy {
	timeoutMs?: number
	maxConcurrent?: number
	maxBodyBytes?: number
	allowedOrigins?: readonly string[]
}
export const Network = defineContextCapability<NetworkApi>('launcher.network', { access: 'owner' })
type BodyReader = ReadableStreamDefaultReader<Uint8Array>
/** Keep native Response/ReadableStream identities. Only this response's consumption entry points are decorated. */
function ownerFetch(
	owner: Context,
	runtimeFetch: typeof fetch,
	policy: Required<Omit<NetworkPolicy, 'allowedOrigins'>> & Pick<NetworkPolicy, 'allowedOrigins'>,
) {
	const observation = owner.root.require(Observations).acquire(owner, 'Network')
	let active = 0
	return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const admission = enterOwnerInvocation(
			owner,
			init?.signal ?? (input instanceof Request ? input.signal : undefined),
		)
		const finishObservation = observation.begin()
		const controller = new AbortController()
		const signal = AbortSignal.any([admission.signal, controller.signal])
		let timer: ReturnType<typeof setTimeout> | undefined
		let origin = '',
			method = 'GET',
			status: number | undefined,
			bytes = 0,
			failed = false,
			ended = false
		const branches = new Set<{ cancel(reason: unknown): Promise<void> }>()
		function end() {
			if (ended || branches.size > 0) return
			ended = true
			active--
			if (timer !== undefined) clearTimeout(timer)
			admission.dispose()
			finishObservation({
				outcome: failed ? 'failed' : signal.aborted ? 'cancelled' : 'completed',
				origin,
				method,
				...(status === undefined ? {} : { status }),
				bodyBytesRead: bytes,
			})
		}
		active++
		function monitor(response: Response): Response {
			const nativeClone = response.clone.bind(response)
			const known = new WeakMap<ReadableStream<Uint8Array>, { finish(): void }>()
			function stream(body: ReadableStream<Uint8Array>, count = true): ReadableStream<Uint8Array> {
				if (known.has(body)) return body
				let reader: BodyReader | undefined,
					pipeline: Promise<void> | undefined,
					done = false,
					size = 0
				const nativeGetReader = body.getReader.bind(body)
				const nativeCancel = body.cancel.bind(body)
				const nativePipeThrough = body.pipeThrough.bind(body)
				const nativeTee = body.tee.bind(body)
				const branch = {
					async cancel(reason: unknown) {
						try {
							if (pipeline) await pipeline.catch((): void => {})
							else if (reader) await reader.cancel(reason)
							else if (!body.locked) await nativeCancel(reason)
						} finally {
							finish()
						}
					},
				}
				const finish = () => {
					if (done) return
					done = true
					branches.delete(branch)
					signal.removeEventListener('abort', onAbort)
					end()
				}
				const onAbort = () => {
					void branch.cancel(signal.reason).catch(() => {
						failed = true
						finish()
					})
				}
				known.set(body, { finish })
				branches.add(branch)
				signal.addEventListener('abort', onAbort, { once: true })
				if (signal.aborted) onAbort()
				function measure(value: unknown) {
					if (!count) return
					if (!ArrayBuffer.isView(value))
						throw new TypeError('Network response body must contain bytes')
					size += value.byteLength
					bytes += value.byteLength
					if (size > policy.maxBodyBytes) {
						failed = true
						const error = new RangeError('Network body budget exceeded')
						controller.abort(error)
						throw error
					}
				}
				function trackedReader(options?: ReadableStreamGetReaderOptions) {
					const acquired = nativeGetReader(options) as BodyReader
					reader = acquired
					const read = acquired.read.bind(acquired),
						cancel = acquired.cancel.bind(acquired),
						release = acquired.releaseLock.bind(acquired)
					Object.defineProperties(acquired, {
						read: {
							configurable: true,
							value: async (...args: unknown[]) => {
								try {
									const chunk = await Reflect.apply(read, acquired, args)
									if (chunk.done) finish()
									else measure(chunk.value)
									return chunk
								} catch (error) {
									failed = !signal.aborted
									finish()
									throw error
								}
							},
						},
						cancel: {
							configurable: true,
							value: async (reason?: unknown) => {
								try {
									await cancel(reason)
								} finally {
									finish()
								}
							},
						},
						releaseLock: {
							configurable: true,
							value: () => {
								release()
								if (reader === acquired) reader = undefined
							},
						},
					})
					return acquired
				}
				Object.defineProperties(body, {
					getReader: { configurable: true, value: trackedReader },
					cancel: {
						configurable: true,
						value: async (reason?: unknown) => {
							try {
								await nativeCancel(reason)
							} finally {
								finish()
							}
						},
					},
					pipeTo: {
						configurable: true,
						value: async (destination: WritableStream<Uint8Array>, options?: StreamPipeOptions) => {
							const counter = new TransformStream<Uint8Array, Uint8Array>({
								transform(chunk, control) {
									measure(chunk)
									control.enqueue(chunk)
								},
							})
							try {
								pipeline = nativePipeThrough(counter).pipeTo(destination, {
									...options,
									signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal,
								})
								await pipeline
							} catch (error) {
								failed = !signal.aborted
								throw error
							} finally {
								finish()
							}
						},
					},
					pipeThrough: {
						configurable: true,
						value: (
							transform: ReadableWritablePair<Uint8Array, Uint8Array>,
							options?: StreamPipeOptions,
						) => {
							const counter = new TransformStream<Uint8Array, Uint8Array>({
								transform(chunk, control) {
									measure(chunk)
									control.enqueue(chunk)
								},
							})
							const output = nativePipeThrough(counter, options).pipeThrough(transform, options)
							stream(output, false)
							finish()
							return output
						},
					},
					tee: {
						configurable: true,
						value: () => {
							const pair = nativeTee()
							stream(pair[0], count)
							stream(pair[1], count)
							finish()
							return pair
						},
					},
					[Symbol.asyncIterator]: {
						configurable: true,
						value: async function* () {
							const current = trackedReader()
							try {
								while (true) {
									const chunk = await current.read()
									if (chunk.done) return
									yield chunk.value
								}
							} finally {
								if (!done) await current.cancel()
								current.releaseLock()
							}
						},
					},
				})
				return body
			}
			if (response.body) stream(response.body)
			else end()
			const methods = ['arrayBuffer', 'blob', 'formData', 'json', 'text', 'bytes'] as const
			for (const name of methods) {
				const nativeMethod = (response as unknown as Record<string, unknown>)[name]
				if (typeof nativeMethod !== 'function') continue
				Object.defineProperty(response, name, {
					configurable: true,
					value: async () => {
						if (response.bodyUsed || response.body?.locked)
							throw new TypeError('Body is already used')
						if (!response.body) return Reflect.apply(nativeMethod, response, [])
						const current = response.body.getReader()
						const chunks: Uint8Array[] = []
						let length = 0
						try {
							while (true) {
								const chunk = await current.read()
								if (chunk.done) break
								chunks.push(chunk.value)
								length += chunk.value.byteLength
							}
						} finally {
							current.releaseLock()
						}
						const buffer = new Uint8Array(length)
						let offset = 0
						for (const chunk of chunks) {
							buffer.set(chunk, offset)
							offset += chunk.byteLength
						}
						const consumed = new Response(buffer, { headers: response.headers })
						return Reflect.apply(
							(consumed as unknown as Record<string, Function>)[name],
							consumed,
							[],
						)
					},
				})
			}
			Object.defineProperty(response, 'clone', {
				configurable: true,
				value: () => {
					const gate = enterOwnerInvocation(owner, signal)
					try {
						const old = response.body
						const cloned = nativeClone()
						if (response.body) stream(response.body)
						const wrapped = monitor(cloned)
						if (old && old !== response.body) known.get(old)?.finish()
						return wrapped
					} finally {
						gate.dispose()
					}
				},
			})
			return response
		}
		try {
			if (active > policy.maxConcurrent) throw new Error('Network concurrency budget exceeded')
			const normalized = new Request(input, init)
			const url = new URL(normalized.url)
			origin = url.origin
			method = normalized.method
			if (!['http:', 'https:'].includes(url.protocol))
				throw new TypeError('Network requires HTTP(S)')
			if (policy.allowedOrigins && !policy.allowedOrigins.includes(origin))
				throw new Error('Network origin denied')
			timer = setTimeout(
				() => controller.abort(new Error('Network request timeout')),
				policy.timeoutMs,
			)
			const response = await runtimeFetch(normalized, { signal, redirect: 'error' })
			status = response.status
			return monitor(response)
		} catch (error) {
			failed = !signal.aborted
			end()
			throw error
		}
	}) as typeof fetch
}
export function network(
	runtimeFetch: typeof fetch = globalThis.fetch,
	options: NetworkPolicy = {},
) {
	const policy = {
		timeoutMs: options.timeoutMs ?? 5000,
		maxConcurrent: options.maxConcurrent ?? 4,
		maxBodyBytes: options.maxBodyBytes ?? 1024 * 1024,
		...(options.allowedOrigins ? { allowedOrigins: [...options.allowedOrigins] } : {}),
	}
	for (const [key, value] of Object.entries(policy)) {
		if (key !== 'allowedOrigins' && (!Number.isSafeInteger(value) || Number(value) <= 0))
			throw new TypeError(`Invalid Network policy ${key}`)
	}
	return defineHostService({
		name: 'Network',
		requires: { observations: Observations },
		capabilities: [
			installOwnerViewCapability(Network, {
				createRoot: () => runtimeFetch,
				createView: (runtime, owner) =>
					Object.freeze({ fetch: ownerFetch(owner, runtime, policy) }),
			}),
		],
	})
}
