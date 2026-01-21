import { useElementSize } from '@mantine/hooks'
import { LazyLog, ScrollFollow } from '@melloware/react-logviewer'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { LogFilter, LogRecord as UiLogRecord } from '@pluxel/hmr-web'
import { defaultOnAuthBlocked } from '@pluxel/hmr-web'
import { createAuthAwareFetch } from '../rpc'
import { createPrettyPrinter } from './pretty'

interface Props {
	module?: string
	showName?: boolean
	filter?: LogFilter
}

const SNAPSHOT_MAX = 1000 // 首屏最多加载多少行历史
const RAW_RING_CAP = 4000 // 原始环容量（原始记录）
const VIEW_RING_CAP = 4000 // 展示环容量（格式化后的行）
const FLUSH_MS = 80 // 合批最迟刷新间隔

const baseFetch =
	typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined
const authFetch = baseFetch ? createAuthAwareFetch(baseFetch) : undefined

const MONO_FONT = '13px ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'

/* ================= 轻量环形缓冲（O(1) push + 有序遍历） ================= */
function createRing<T>(cap = 2000) {
	const buf = new Array<T>(cap)
	let start = 0
	let len = 0
	return {
		clear() {
			start = 0
			len = 0
		},
		push(s: T) {
			if (len < cap) {
				buf[(start + len) % cap] = s
				len++
			} else {
				buf[start] = s
				start = (start + 1) % cap
			}
		},
		toArray(): T[] {
			if (len === 0) return []
			if (start + len <= cap) return buf.slice(start, start + len)
			return buf.slice(start).concat(buf.slice(0, (start + len) % cap))
		},
	}
}

function createStringRing(cap = 2000) {
	const base = createRing<string>(cap)
	return {
		...base,
		join(sep = '\n'): string {
			return base.toArray().join(sep)
		},
	}
}

/* ================== LiveLog ================== */
export function LiveLog({ module, showName = true, filter }: Props) {
	const { ref, height } = useElementSize()
	const [text, setText] = useState('')

	const filterQuery = useMemo(() => {
		const params = new URLSearchParams()
		const name = filter?.name ?? module
		if (name) params.set('name', name)
		if (filter?.pluginId) params.set('pluginId', filter.pluginId)
		if (filter?.context) params.set('context', filter.context)
		if (filter?.displayName) params.set('displayName', filter.displayName)
		if (filter?.category) params.set('category', filter.category)
		return params.toString()
	}, [module, filter?.name, filter?.pluginId, filter?.context, filter?.displayName, filter?.category])

	// —— 两层环：原始行（raw）与展示行（view） —— //
	const rawRingRef = useRef(createRing<UiLogRecord>(RAW_RING_CAP))
	const viewRingRef = useRef(createStringRing(VIEW_RING_CAP))
	const lastIdRef = useRef<number>(0)
	const bootIdRef = useRef<string | null>(null)

	const mode = useMemo(() => {
		const scoped =
			Boolean(module) ||
			Boolean(filter?.pluginId) ||
			Boolean(filter?.context) ||
			Boolean(filter?.displayName) ||
			Boolean(filter?.name)
		return scoped ? 'scoped' : 'global'
	}, [module, filter?.pluginId, filter?.context, filter?.displayName, filter?.name])

	const pretty = useMemo(() => {
		return createPrettyPrinter({
			mode,
			// Scoped views (e.g. plugin detail) already provide context, so avoid repeating it.
			showName: mode === 'global' ? showName : false,
		})
	}, [mode, showName])
	const prettyRef = useRef(pretty)
	useEffect(() => {
		prettyRef.current = pretty
	}, [pretty])

	// —— 合批刷入（把“展示行”批量落入 viewRing，再 setText） —— //
	const pendingViewRef = useRef<string[]>([])
	const rafRef = useRef<number | null>(null)
	const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const flush = () => {
		rafRef.current = null
		if (flushTimerRef.current) {
			clearTimeout(flushTimerRef.current)
			flushTimerRef.current = null
		}
		if (pendingViewRef.current.length === 0) return
		const v = viewRingRef.current
		for (let i = 0; i < pendingViewRef.current.length; i++) v.push(pendingViewRef.current[i])
		pendingViewRef.current.length = 0
		setText(v.join('\n'))
	}
	const scheduleFlush = () => {
		if (rafRef.current == null) {
			rafRef.current = requestAnimationFrame(flush)
			if (!flushTimerRef.current) {
				flushTimerRef.current = setTimeout(() => {
					if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
					flush()
				}, FLUSH_MS)
			}
		}
	}

	// —— 入口：接入一条“原始行” —— //
	const pushRecord = (rec: UiLogRecord) => {
		if (typeof rec?.id === 'number' && rec.id > 0) {
			if (rec.id <= lastIdRef.current) return
			lastIdRef.current = rec.id
		}

		rawRingRef.current.push(rec)

		const prettyText = prettyRef.current.format(rec)
		pendingViewRef.current.push(prettyText)
		scheduleFlush()
	}

	// —— pretty 变化时，仅“本地重排展示环”，不触发网络/重连 —— //
	useEffect(() => {
		// 取消上一次 flush，避免旧行混入
		if (rafRef.current != null) {
			cancelAnimationFrame(rafRef.current)
			rafRef.current = null
		}
		if (flushTimerRef.current) {
			clearTimeout(flushTimerRef.current)
			flushTimerRef.current = null
		}
		pendingViewRef.current.length = 0

		const raw = rawRingRef.current.toArray()
		const view = viewRingRef.current
		view.clear()
		for (let i = 0; i < raw.length; i++) view.push(prettyRef.current.format(raw[i] as any))
		setText(view.join('\n'))
	}, [pretty])

	// —— 快照 + SSE（仅跟随 filterQuery 变化） —— //
	const abortRef = useRef<AbortController | null>(null)
	const authProbeInFlightRef = useRef<Promise<boolean> | null>(null)
	const lastAuthProbeAtRef = useRef<number>(0)

	useEffect(() => {
		let disposed = false

		// reset state
		if (abortRef.current) {
			abortRef.current.abort()
			abortRef.current = null
		}
		rawRingRef.current.clear()
		viewRingRef.current.clear()
		pendingViewRef.current.length = 0
		lastIdRef.current = 0
		bootIdRef.current = null
		setText('')

		// —— 拉快照 —— //
		const params = new URLSearchParams(filterQuery)
		params.set('limit', String(SNAPSHOT_MAX))
		const ac = new AbortController()
		abortRef.current = ac

		const probeAuthBlocked = async (url: string): Promise<boolean> => {
			if (!baseFetch) return false
			const now = Date.now()
			if (now - lastAuthProbeAtRef.current < 1500) return false
			lastAuthProbeAtRef.current = now
			try {
				const res = await baseFetch('/api/auth/meta', {
					method: 'GET',
					headers: { 'Cache-Control': 'no-store' },
				})
				if (!res.ok) return false
				const payload = (await res.json()) as any
				if (!payload || payload.enabled !== true) return false
				if (payload.authenticated === true) return false
				const redirectPath =
					typeof payload.redirectPath === 'string' && payload.redirectPath
						? payload.redirectPath
						: undefined
				defaultOnAuthBlocked({ status: 401, url, redirectPath })
				return true
			} catch {
				return false
			}
		}

		const connectLogsStream = (afterId?: number) => {
			const params = new URLSearchParams(filterQuery)
			if (afterId && afterId > 0) params.set('afterId', String(afterId))
			const url = `/api/logs/stream?${params.toString()}`
			const es = new EventSource(url)

			es.addEventListener('ready', (ev) => {
				let payload: any
				try {
					payload = JSON.parse((ev as MessageEvent).data)
				} catch {
					return
				}
				const nextBootId = typeof payload?.bootId === 'string' ? payload.bootId : null
				if (!nextBootId) return
				if (bootIdRef.current && bootIdRef.current !== nextBootId) {
					rawRingRef.current.clear()
					viewRingRef.current.clear()
					pendingViewRef.current.length = 0
					lastIdRef.current = 0
					setText('')
				}
				bootIdRef.current = nextBootId
			})

			es.addEventListener('log', (ev) => {
				let payload: any
				try {
					payload = JSON.parse((ev as MessageEvent).data)
				} catch {
					return
				}
				if (!payload || typeof payload !== 'object') return
				pushRecord(payload as UiLogRecord)
			})

			es.onerror = () => {
				if (authProbeInFlightRef.current) return
				authProbeInFlightRef.current = probeAuthBlocked(url).finally(() => {
					authProbeInFlightRef.current = null
				})
				void authProbeInFlightRef.current.then((blocked) => {
					if (blocked) es.close()
				})
			}

			return es
		}

		let es: EventSource | null = null
		if (!authFetch) {
			abortRef.current = null
			es = connectLogsStream()
		} else {
			// Connect after snapshot to minimize duplicates and allow server-side replay via afterId.
			authFetch(`/api/logs/latest?${params.toString()}`, { signal: ac.signal })
				.then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
				.then((payload) => {
					if (disposed || ac.signal.aborted) return
					const bootId = (payload as any)?.bootId
					if (typeof bootId === 'string') bootIdRef.current = bootId
					const records = (payload as any)?.records
					if (!Array.isArray(records)) return
					const start = Math.max(0, records.length - SNAPSHOT_MAX)
					for (let i = start; i < records.length; i++) {
						const rec = records[i] as UiLogRecord
						if (!rec || typeof rec !== 'object') continue
						pushRecord(rec)
					}
				})
				.catch(() => undefined)
				.finally(() => {
					abortRef.current = null
					// IMPORTANT:
					// This `finally()` may run after unmount / route switch. Never open a new
					// SSE connection after disposal, otherwise we leak EventSource sockets and
					// can exhaust the browser connection pool (everything becomes pending).
					if (disposed || ac.signal.aborted) return
					es = connectLogsStream(lastIdRef.current)
				})
		}

		return () => {
			disposed = true
			if (abortRef.current) {
				abortRef.current.abort()
				abortRef.current = null
			}
			es?.close()
		}
	}, [filterQuery])

	// —— 渲染 —— //
	const logHeight = useMemo(() => Math.max(120, height || 0), [height])

	return (
		<div
			ref={ref}
			style={{
				height: '100%',
				minHeight: 0,
				width: '100%',
				minWidth: 0,
				display: 'flex',
				flexDirection: 'column',
			}}
		>
			<div style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
				<ScrollFollow
					startFollowing
					render={({ follow, onScroll }) => (
						<LazyLog
							key={filterQuery || 'all'}
							height={logHeight}
							text={text}
							external
							follow={follow}
							onScroll={onScroll}
							selectableLines
							wrapLines
							rowHeight={19}
							enableLineNumbers={false}
							enableGutters={false}
							style={{
								fontFamily: MONO_FONT,
								width: '100%',
								maxWidth: '100%',
							}}
							containerStyle={{
								width: '100%',
								maxWidth: '100%',
								overflowX: 'auto',
							}}
						/>
					)}
				/>
			</div>
		</div>
	)
}
