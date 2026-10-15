import { formatPluginNodeReference, parsePluginNodeReference } from '@pluxel/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
	type LogFilter,
	type LogStreamMeta,
	type RuntimeLogEvent,
	type RuntimeLogLine,
	useRuntimeManagementClient,
} from '../../runtime'
import { stringifyUnknown } from '../../utils/unknown'
import { createLogStreamStore, type LogStreamStore } from './logStreamStore'

export type LogStreamState = {
	store: LogStreamStore
	status: 'loading' | 'live' | 'error'
	error: string | null
	meta: LogStreamMeta | null
	/** Clears only this reader's cache; in-flight historical reads cannot restore cleared rows. */
	clear(): void
	/** Opens a fresh subscription on the existing management client. */
	retry(): void
}
const PAGE_LIMIT = 2000
const BUFFER_LIMIT = 2048

export function useLogStream({
	streamId,
	filter,
	capacity,
	historyLimit,
}: {
	streamId: string
	filter: LogFilter
	capacity: number
	historyLimit: number
}): LogStreamState {
	if (
		!Number.isSafeInteger(capacity) ||
		capacity < 1 ||
		!Number.isSafeInteger(historyLimit) ||
		historyLimit < 0 ||
		historyLimit > capacity
	)
		throw new RangeError('Log historyLimit must be between zero and the positive cache capacity')
	const management = useRuntimeManagementClient()
	const store = useMemo(() => createLogStreamStore(capacity), [capacity])
	// Canonical primitive dependencies keep equivalent owner objects from restarting the subscription.
	const ownerReference = filter.plugin ? formatPluginNodeReference(filter.plugin) : undefined
	const { context, displayName, category } = filter
	const activeFilter = useMemo(
		() => ({
			plugin: ownerReference === undefined ? undefined : parsePluginNodeReference(ownerReference),
			context,
			displayName,
			category,
		}),
		[ownerReference, context, displayName, category],
	)
	const [attempt, setAttempt] = useState(0)
	const [state, setState] = useState<Pick<LogStreamState, 'status' | 'error' | 'meta'>>({
		status: 'loading',
		error: null,
		meta: null,
	})
	const clearCurrent = useRef<() => void>(() => {})
	const clear = useCallback(() => clearCurrent.current(), [])
	const retry = useCallback(() => setAttempt((value) => value + 1), [])

	useEffect(() => {
		let disposed = false
		let subscription: Disposable | undefined
		let frame: number | undefined
		let epoch: number | undefined
		let bootId: string | undefined
		let clearVersion = 0
		let epochGeneration = 0
		let draining = false
		let bootstrapped = false
		let resync = false
		let bufferedWeight = 0
		const queue: RuntimeLogEvent[] = []
		const pending = createLogStreamStore(capacity)
		store.clear()
		setState({ status: 'loading', error: null, meta: null })
		const cancelFrame = () => {
			if (frame !== undefined) cancelAnimationFrame(frame)
			frame = undefined
		}
		const release = () => {
			const current = subscription
			subscription = undefined
			current?.[Symbol.dispose]()
		}
		const fail = (error: unknown) => {
			if (disposed) return
			disposed = true
			cancelFrame()
			pending.clear()
			queue.length = 0
			release()
			setState((previous) => ({
				...previous,
				status: 'error',
				error: stringifyUnknown(error, '日志读取失败'),
			}))
		}
		const append = (lines: readonly RuntimeLogLine[]) => {
			if (disposed) return
			pending.append(lines.filter((line) => line.epoch === epoch))
			if (pending.length === 0 || frame !== undefined) return
			frame = requestAnimationFrame(() => {
				frame = undefined
				if (disposed) return
				store.append(pending.toArray())
				pending.clear()
			})
		}
		const acceptMeta = (meta: LogStreamMeta) => {
			if (epoch !== meta.epoch || bootId !== meta.bootId) {
				epochGeneration++
				epoch = meta.epoch
				bootId = meta.bootId
				cancelFrame()
				pending.clear()
				store.clear()
			}
			setState((previous) => ({ ...previous, meta }))
		}
		clearCurrent.current = () => {
			clearVersion++
			queue.length = 0
			bufferedWeight = 0
			cancelFrame()
			pending.clear()
			store.clear()
		}
		const read = async (meta: LogStreamMeta, start: string, stop: bigint, limit: number) => {
			const generation = epochGeneration
			const result = createLogStreamStore(Math.max(1, limit))
			let cursor = BigInt(start)
			while (!disposed && cursor <= stop) {
				const page = await management.logs
					.range(streamId, {
						epoch: meta.epoch,
						fromSeq: String(cursor),
						limit: PAGE_LIMIT,
						filter: activeFilter,
					})
					.catch((error: unknown) => {
						if (disposed || generation !== epochGeneration || epoch !== meta.epoch) return null
						throw error
					})
				if (disposed || generation !== epochGeneration || epoch !== meta.epoch || page === null)
					return []
				if (!page.ok) throw new Error(page.message ?? `日志读取失败：${page.code}`)
				if (page.epoch !== meta.epoch) throw new Error('日志读取期间 epoch 已变化，请重试')
				const next = BigInt(page.nextSeq)
				if (next <= cursor) throw new Error('日志分页游标未前进，请重试')
				result.append(page.lines.filter((line) => BigInt(line.seq) <= stop))
				cursor = next
			}
			return limit === 0 ? [] : result.toArray()
		}
		const snapshot = async () => {
			const version = clearVersion
			const generation = epochGeneration
			const meta = await management.logs.meta(streamId).catch((error: unknown) => {
				if (disposed || generation !== epochGeneration) return null
				throw error
			})
			if (disposed || generation !== epochGeneration || meta === null) return
			acceptMeta(meta)
			const lines = historyLimit
				? await read(meta, meta.headSeq, BigInt(meta.tailSeq), historyLimit)
				: []
			if (!disposed && version === clearVersion) append(lines)
		}
		const handle = async (event: RuntimeLogEvent) => {
			if (event.type === 'reset') {
				acceptMeta(event)
				return
			}
			if (event.epoch !== epoch) return
			if (event.type === 'append') {
				append(event.lines)
				return
			}
			const version = clearVersion
			const generation = epochGeneration
			const meta = await management.logs.meta(streamId).catch((error: unknown) => {
				if (disposed || generation !== epochGeneration) return null
				throw error
			})
			if (disposed || generation !== epochGeneration || meta === null) return
			acceptMeta(meta)
			if (meta.epoch !== event.epoch) {
				await snapshot()
				return
			}
			const start =
				BigInt(event.missingFrom) < BigInt(meta.headSeq) ? meta.headSeq : event.missingFrom
			const stop =
				BigInt(event.missingTo) < BigInt(meta.tailSeq)
					? BigInt(event.missingTo)
					: BigInt(meta.tailSeq)
			const lines = await read(meta, start, stop, capacity)
			if (!disposed && version === clearVersion) append(lines)
		}
		const drain = async () => {
			if (draining || !bootstrapped || disposed) return
			draining = true
			let recoveries = 0
			try {
				while (!disposed && (resync || queue.length > 0)) {
					if (resync) {
						if (++recoveries > 8) throw new Error('日志更新过快，无法完成同步，请重试')
						resync = false
						await snapshot()
					} else {
						const event = queue.shift()!
						bufferedWeight -= event.type === 'append' ? Math.max(1, event.lines.length) : 1
						await handle(event)
					}
				}
				if (!disposed) setState((previous) => ({ ...previous, status: 'live', error: null }))
			} catch (error) {
				fail(error)
			} finally {
				draining = false
			}
		}
		void (async () => {
			try {
				subscription = await management.logs.follow({ streamId, filter: activeFilter }, (event) => {
					if (disposed) return
					if (event.type === 'reset') {
						acceptMeta(event)
						queue.length = 0
						bufferedWeight = 0
						resync = false
						return
					}
					const weight = event.type === 'append' ? Math.max(1, event.lines.length) : 1
					if (bufferedWeight + weight > BUFFER_LIMIT) {
						queue.length = 0
						bufferedWeight = 0
						resync = true
					} else {
						queue.push(event)
						bufferedWeight += weight
					}
					void drain()
				})
				if (disposed) {
					release()
					return
				}
				await snapshot()
				if (disposed) return
				bootstrapped = true
				await drain()
			} catch (error) {
				fail(error)
			}
		})()
		return () => {
			disposed = true
			clearCurrent.current = () => {}
			cancelFrame()
			pending.clear()
			queue.length = 0
			release()
		}
	}, [management, streamId, activeFilter, capacity, historyLimit, attempt, store])
	return { store, ...state, clear, retry }
}
