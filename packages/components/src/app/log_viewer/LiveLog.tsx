import {
	type LogFilter,
	type LogRangeOk,
	type LogSseEvent,
	type LogStreamMeta,
	type RuntimeLogLine,
} from '@pluxel/runtime/web'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
	memo,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react'
import { useHmrWebClient } from '../rpc'

interface Props {
	module?: string
	showName?: boolean
	filter?: LogFilter
	/**
	 * - `full`: standalone logs page (controls live in right panel)
	 * - `embedded`: plugin/detail modal (minimal header; no filter controls)
	 */
	variant?: 'full' | 'embedded'
}

const DEFAULT_STREAM_ID = 'default'
const SNAPSHOT_MAX = 1500 // 首屏最多加载多少行历史
const CLIENT_RING_CAP = 50_000 // 客户端缓存窗口（行）
const RANGE_LIMIT = 2000 // /range 每次最多拉多少行（服务端也会 clamp）
const ROW_H = 20
const STICK_THRESHOLD_PX = ROW_H * 30

function isRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== 'object') return false
	if (Array.isArray(value)) return false
	const proto = Object.getPrototypeOf(value)
	return proto === Object.prototype || proto === null
}

const ANSI_ESC = '\u001b'
const ANSI_CSI_RE = new RegExp(`${ANSI_ESC}\\[[0-9;]*[A-Za-z]`, 'g')
const ANSI_OSC_RE = new RegExp(`${ANSI_ESC}\\][^\\u0007]*\\u0007`, 'g')
const ANSI_SGR_RE = new RegExp(`${ANSI_ESC}\\[([0-9;]*)m`, 'g')

const MONO_FONT =
	'12.5px ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'
const PANEL_BG = 'rgba(2, 6, 23, 0.55)'
const LIST_BG = 'rgba(2, 6, 23, 0.45)'
const BORDER = '1px solid rgba(148,163,184,0.20)'

function normalizeFilter(filter: LogFilter | undefined): LogFilter {
	const trimOrUndef = (v: unknown) => {
		if (typeof v !== 'string') return undefined
		const s = v.trim()
		return s ? s : undefined
	}
	return {
		name: trimOrUndef(filter?.name),
		pluginId: trimOrUndef(filter?.pluginId),
		context: trimOrUndef(filter?.context),
		displayName: trimOrUndef(filter?.displayName),
		category: trimOrUndef(filter?.category),
	}
}

function sameFilter(a: LogFilter, b: LogFilter): boolean {
	return (
		(a.name ?? '') === (b.name ?? '') &&
		(a.pluginId ?? '') === (b.pluginId ?? '') &&
		(a.context ?? '') === (b.context ?? '') &&
		(a.displayName ?? '') === (b.displayName ?? '') &&
		(a.category ?? '') === (b.category ?? '')
	)
}

/* ================= 轻量环形缓冲 + 外部订阅（避免 setState 全量重渲染） ================= */
function createRingStore<T>(cap = 2000) {
	const buf = new Array<T>(cap)
	let start = 0
	let len = 0
	let version = 0
	const listeners = new Set<() => void>()

	const notify = () => {
		version++
		for (const fn of listeners) fn()
	}
	return {
		clear() {
			start = 0
			len = 0
			notify()
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
		pushMany(items: readonly T[]) {
			if (!items.length) return
			for (let i = 0; i < items.length; i++) this.push(items[i]!)
			notify()
		},
		get(i: number): T | undefined {
			if (i < 0 || i >= len) return undefined
			return buf[(start + i) % cap]
		},
		toArray(): T[] {
			if (len === 0) return []
			if (start + len <= cap) return buf.slice(start, start + len)
			return buf.slice(start).concat(buf.slice(0, (start + len) % cap))
		},
		subscribe(fn: () => void) {
			listeners.add(fn)
			return () => listeners.delete(fn)
		},
		getVersion() {
			return version
		},
		get length() {
			return len
		},
	}
}

function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n)
}
function pad3(n: number): string {
	if (n < 10) return `00${n}`
	if (n < 100) return `0${n}`
	return String(n)
}

function formatTime(epochMs: number): string {
	const d = new Date(epochMs)
	return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`
}

function levelColor(level: string): string {
	switch (level) {
		case 'trace':
			return '#94a3b8'
		case 'debug':
			return '#60a5fa'
		case 'info':
			return '#34d399'
		case 'warning':
			return '#fbbf24'
		case 'error':
			return '#fb7185'
		case 'fatal':
			return '#c084fc'
		default:
			return '#cbd5e1'
	}
}

function formatCategory(category?: string[]): string {
	if (!Array.isArray(category) || category.length === 0) return ''
	return category.join('·')
}

function oneLine(s: string): string {
	if (!s) return ''
	return s.replace(/\r\n|\r|\n/g, '⏎').replace(/\t/g, '⇥')
}

const ANSI_16_FG = [
	'#000000',
	'#b91c1c',
	'#15803d',
	'#a16207',
	'#1d4ed8',
	'#7c3aed',
	'#0e7490',
	'#e2e8f0',
	'#64748b',
	'#ef4444',
	'#22c55e',
	'#eab308',
	'#3b82f6',
	'#a855f7',
	'#06b6d4',
	'#f8fafc',
] as const

async function copyToClipboard(text: string): Promise<boolean> {
	const v = text ?? ''
	try {
		if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(v)
			return true
		}
	} catch {
		// fall through
	}
	try {
		if (typeof document === 'undefined') return false
		const el = document.createElement('textarea')
		el.value = v
		el.setAttribute('readonly', 'true')
		el.style.position = 'fixed'
		el.style.left = '-9999px'
		el.style.top = '0'
		document.body.appendChild(el)
		el.select()
		const ok = document.execCommand('copy')
		document.body.removeChild(el)
		return ok
	} catch {
		return false
	}
}

function xterm256(n: number): string | undefined {
	if (!Number.isFinite(n) || n < 0 || n > 255) return undefined
	if (n < 16) return ANSI_16_FG[n]!
	if (n >= 232) {
		const v = 8 + (n - 232) * 10
		return `rgb(${v},${v},${v})`
	}
	const idx = n - 16
	const r = Math.floor(idx / 36)
	const g = Math.floor((idx % 36) / 6)
	const b = idx % 6
	const cv = (x: number) => (x === 0 ? 0 : 55 + x * 40)
	return `rgb(${cv(r)},${cv(g)},${cv(b)})`
}

function stripAnsi(s: string): string {
	if (!s) return ''
	// Best-effort: strip CSI sequences (incl. SGR) and OSC hyperlinks.
	return s.replace(ANSI_CSI_RE, '').replace(ANSI_OSC_RE, '')
}

type AnsiStyle = {
	color?: string
	backgroundColor?: string
	fontWeight?: number
	fontStyle?: 'italic'
	textDecoration?: string
}

function renderAnsi(text: string): ReactNode {
	if (!text || !text.includes('\u001b[')) return text

	const parts: Array<{ key: string; text: string; style: AnsiStyle | null }> = []
	let style: AnsiStyle = {}

	const push = (chunk: string, start: number, end: number) => {
		if (!chunk) return
		const st = Object.keys(style).length ? { ...style } : null
		parts.push({ key: `${start}:${end}`, text: chunk, style: st })
	}

	const sgr = new RegExp(ANSI_SGR_RE)
	let last = 0
	for (;;) {
		const m = sgr.exec(text)
		if (!m) break
		const idx = m.index
		push(text.slice(last, idx), last, idx)
		last = idx + m[0].length

		const raw = m[1] ?? ''
		const codes = raw ? raw.split(';') : ['0']
		const nums = codes.map((c) => (c ? Number(c) : 0)).filter((n) => Number.isFinite(n)) as number[]
		if (nums.length === 0) nums.push(0)

		for (let i = 0; i < nums.length; i++) {
			const code = nums[i]!
			if (code === 0) {
				style = {}
				continue
			}
			if (code === 1) {
				style.fontWeight = 700
				continue
			}
			if (code === 22) {
				delete style.fontWeight
				continue
			}
			if (code === 3) {
				style.fontStyle = 'italic'
				continue
			}
			if (code === 23) {
				delete style.fontStyle
				continue
			}
			if (code === 4) {
				style.textDecoration = 'underline'
				continue
			}
			if (code === 24) {
				delete style.textDecoration
				continue
			}

			// 16-color
			if (code >= 30 && code <= 37) {
				style.color = ANSI_16_FG[code - 30]!
				continue
			}
			if (code >= 90 && code <= 97) {
				style.color = ANSI_16_FG[8 + (code - 90)]!
				continue
			}
			if (code === 39) {
				delete style.color
				continue
			}

			if (code >= 40 && code <= 47) {
				style.backgroundColor = ANSI_16_FG[code - 40]!
				continue
			}
			if (code >= 100 && code <= 107) {
				style.backgroundColor = ANSI_16_FG[8 + (code - 100)]!
				continue
			}
			if (code === 49) {
				delete style.backgroundColor
				continue
			}

			// Extended colors: 38/48;5;n or 38/48;2;r;g;b
			if (code === 38 || code === 48) {
				const isBg = code === 48
				const mode = nums[i + 1]
				if (mode === 5) {
					const n = nums[i + 2]
					const c = typeof n === 'number' ? xterm256(n) : undefined
					if (c) {
						if (isBg) style.backgroundColor = c
						else style.color = c
					}
					i += 2
					continue
				}
				if (mode === 2) {
					const r = nums[i + 2]
					const g = nums[i + 3]
					const b = nums[i + 4]
					if (
						typeof r === 'number' &&
						typeof g === 'number' &&
						typeof b === 'number' &&
						r >= 0 &&
						r <= 255 &&
						g >= 0 &&
						g <= 255 &&
						b >= 0 &&
						b <= 255
					) {
						const c = `rgb(${r},${g},${b})`
						if (isBg) style.backgroundColor = c
						else style.color = c
					}
					i += 4
				}
			}
		}
	}
	push(text.slice(last), last, text.length)

	if (parts.length === 0) return ''
	let hasStyle = false
	for (let i = 0; i < parts.length; i++) {
		if (parts[i]!.style) {
			hasStyle = true
			break
		}
	}
	if (!hasStyle) return parts.map((p) => p.text).join('')

	return parts.map((p) =>
		p.style ? (
			<span key={p.key} style={p.style}>
				{p.text}
			</span>
		) : (
			<span key={p.key}>{p.text}</span>
		),
	)
}

function formatLineForCopy(
	line: RuntimeLogLine,
	opts: { showCategory: boolean; showName: boolean },
): string {
	const time = formatTime(line.ts)
	const level = String(line.level).toUpperCase()
	const category = opts.showCategory ? formatCategory(line.category) : ''
	const name = opts.showName && line.name ? `[${line.name}]` : ''
	const msg = stripAnsi(oneLine(messageToText(line)))
	return `${time} ${level}${category ? ` ${category}` : ''}${name ? ` ${name}` : ''} ${msg}`.trim()
}

function messageToText(record: RuntimeLogLine): string {
	if (record.msg) return record.msg
	const parts = record.message
	if (!Array.isArray(parts) || parts.length === 0) return ''

	const limit = 12_000
	let out = ''

	const previewObject = (obj: object): string => {
		const rec = obj as Record<string, unknown>
		let total = 0
		let picked = 0
		let s = '{'
		for (const k in rec) {
			if (!Object.hasOwn(rec, k)) continue
			total++
			if (picked < 4) {
				const v = rec[k]
				if (picked) s += ', '
				s += `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`
				picked++
			}
		}
		if (total > 4) s += ', …'
		s += '}'
		return s
	}

	const formatPart = (part: unknown): string => {
		if (typeof part === 'string') return part
		if (typeof part === 'number' || typeof part === 'boolean' || typeof part === 'bigint')
			return String(part)
		if (part === null || part === undefined) return String(part)
		if (typeof part === 'object') return previewObject(part as object)
		return String(part)
	}

	for (let i = 0; i < parts.length; i++) {
		out += formatPart(parts[i])
		if (out.length >= limit) {
			out = `${out.slice(0, limit)}…`
			break
		}
	}
	return out
}

function seqToBigint(seq: string): bigint | null {
	try {
		if (!seq || !/^\d+$/.test(seq)) return null
		return BigInt(seq)
	} catch {
		return null
	}
}

function addSeq(seq: string, delta: bigint): string | null {
	const n = seqToBigint(seq)
	if (n === null) return null
	return (n + delta).toString(10)
}

/* ================== LiveLog ================== */
type RingStore<T> = {
	clear: () => void
	pushMany: (items: readonly T[]) => void
	get: (index: number) => T | undefined
	toArray: () => T[]
	subscribe: (fn: () => void) => () => void
	getVersion: () => number
	readonly length: number
}

type LogListApi = {
	scrollToTail: () => void
}

const LogList = memo(function LogList(props: {
	store: RingStore<RuntimeLogLine>
	showCategory: boolean
	showName: boolean
	ansi: boolean
	selectedSeq: string | null
	setSelectedSeq: (v: string | null) => void
	setSelectedLine: (v: RuntimeLogLine | null) => void
	follow: boolean
	followRef: { current: boolean }
	followWantedRef: { current: boolean }
	setFollow: (v: boolean) => void
	setNewSincePause: (v: number | ((n: number) => number)) => void
	apiRef: { current: LogListApi | null }
	metaCount?: number
}) {
	const {
		store,
		showCategory,
		showName,
		ansi,
		selectedSeq,
		setSelectedSeq,
		setSelectedLine,
		follow,
		followRef,
		followWantedRef,
		setFollow,
		setNewSincePause,
		apiRef,
		metaCount,
	} = props

	const _version = useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion)
	const listLen = store.length

	const toggleSelected = (line: RuntimeLogLine) => {
		if (selectedSeq === line.seq) {
			setSelectedSeq(null)
			setSelectedLine(null)
			return
		}
		setSelectedSeq(line.seq)
		setSelectedLine(line)
	}

	const scrollRef = useRef<HTMLDivElement | null>(null)
	const virtualizer = useVirtualizer({
		count: listLen,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => ROW_H,
		overscan: 20,
	})

	const scrollToTail = useCallback(() => {
		if (store.length > 0) virtualizer.scrollToIndex(store.length - 1, { align: 'end' })
	}, [store, virtualizer])

	useEffect(() => {
		apiRef.current = { scrollToTail }
		return () => {
			if (apiRef.current?.scrollToTail === scrollToTail) apiRef.current = null
		}
	}, [apiRef, scrollToTail])

	const onScroll = () => {
		const el = scrollRef.current
		if (!el) return
		const total = virtualizer.getTotalSize()
		const bottom = total - (el.scrollTop + el.clientHeight)
		const atBottom = bottom <= STICK_THRESHOLD_PX
		followRef.current = followWantedRef.current ? atBottom : false
		if (followWantedRef.current) setFollow(atBottom)
		if (atBottom) setNewSincePause(0)
	}

	useEffect(() => {
		if (!follow) return
		scrollToTail()
	}, [follow, _version, scrollToTail])

	return (
		<div
			ref={scrollRef}
			onScroll={onScroll}
			style={{
				flex: 1,
				minHeight: 0,
				minWidth: 0,
				overflow: 'auto',
				fontFamily: MONO_FONT,
				fontSize: 12,
				lineHeight: `${ROW_H}px`,
				whiteSpace: 'pre',
				backgroundColor: LIST_BG,
				backgroundImage: `repeating-linear-gradient(
					180deg,
					rgba(148,163,184,0.028) 0px,
					rgba(148,163,184,0.028) ${ROW_H}px,
					rgba(0,0,0,0) ${ROW_H}px,
					rgba(0,0,0,0) ${ROW_H * 2}px
				)`,
				border: BORDER,
				borderRadius: 8,
				backdropFilter: 'blur(10px)',
			}}
		>
			<div
				style={{
					height: virtualizer.getTotalSize(),
					position: 'relative',
					width: '100%',
					minWidth: '100%',
				}}
			>
				{virtualizer.getVirtualItems().map((v) => {
					const line = store.get(v.index)
					if (!line) return null
					const isSelected = selectedSeq === line.seq
					const categoryText = showCategory ? formatCategory(line.category) : ''
					const msgText = oneLine(messageToText(line))
					const msgNode = ansi ? renderAnsi(msgText) : stripAnsi(msgText)
					return (
						<button
							key={`${line.epoch}:${line.seq}`}
							type="button"
							tabIndex={0}
							onKeyDown={(e) => {
								if (e.key !== 'Enter' && e.key !== ' ') return
								e.preventDefault()
								toggleSelected(line)
							}}
							onClick={(e) => {
								// If user is selecting text inside this row, do not toggle details.
								try {
									const sel = typeof window !== 'undefined' ? window.getSelection?.() : null
									if (
										sel &&
										!sel.isCollapsed &&
										sel.anchorNode &&
										e.currentTarget.contains(sel.anchorNode)
									)
										return
								} catch {
									// ignore
								}
								toggleSelected(line)
							}}
							style={{
								appearance: 'none',
								position: 'absolute',
								top: 0,
								left: 0,
								width: '100%',
								height: v.size,
								transform: `translateY(${v.start}px)`,
								display: 'flex',
								alignItems: 'center',
								gap: 8,
								padding: '0 10px',
								border: 'none',
								textAlign: 'left',
								font: 'inherit',
								color: 'inherit',
								cursor: 'default',
								userSelect: 'text',
								background: isSelected ? 'rgba(59,130,246,0.14)' : 'transparent',
								borderLeft: `3px solid ${levelColor(line.level)}`,
							}}
						>
							<span style={{ color: '#94a3b8', flex: '0 0 auto' }}>{formatTime(line.ts)}</span>
							<span
								style={{
									color: levelColor(line.level),
									fontWeight: 700,
									flex: '0 0 auto',
									width: 56,
								}}
							>
								{String(line.level).toUpperCase().padEnd(7)}
							</span>
							{categoryText ? (
								<span style={{ color: '#60a5fa', flex: '0 0 auto' }}>{categoryText}</span>
							) : null}
							{showName && line.name ? (
								<span style={{ color: '#94a3b8', flex: '0 0 auto' }}>[{line.name}]</span>
							) : null}
							<span style={{ color: '#e2e8f0', flex: '1 1 auto' }}>{msgNode}</span>
						</button>
					)
				})}
				{listLen === 0 ? (
					<div
						style={{
							position: 'absolute',
							inset: 0,
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							color: '#94a3b8',
							padding: 16,
						}}
					>
						{metaCount ? '暂无可见日志（可能在加载/被过滤）' : '暂无日志'}
					</div>
				) : null}
			</div>
		</div>
	)
})

export function LiveLog({ module, showName = true, filter, variant = 'full' }: Props) {
	const hmr = useHmrWebClient()
	const [meta, setMeta] = useState<LogStreamMeta | null>(null)
	const [connected, setConnected] = useState(false)
	const [follow, setFollow] = useState(true)
	const [newSincePause, setNewSincePause] = useState(0)
	const [selectedSeq, setSelectedSeq] = useState<string | null>(null)
	const [selectedLine, setSelectedLine] = useState<RuntimeLogLine | null>(null)
	const [showCategory, setShowCategory] = useState(true)
	const [ansi, setAnsi] = useState(true)
	const [copied, setCopied] = useState<null | 'line' | 'json'>(null)
	const [streamIdInput, setStreamIdInput] = useState(DEFAULT_STREAM_ID)
	const [streams, setStreams] = useState<string[]>([DEFAULT_STREAM_ID])
	const streamDatalistId = useId()

	const streamId = useMemo(
		() => (streamIdInput.trim() ? streamIdInput.trim() : DEFAULT_STREAM_ID),
		[streamIdInput],
	)

	const defaultsFilter = useMemo(
		() =>
			normalizeFilter({
				name: filter?.name ?? module,
				pluginId: filter?.pluginId,
				context: filter?.context,
				displayName: filter?.displayName,
				category: filter?.category,
			}),
		[
			module,
			filter?.name,
			filter?.pluginId,
			filter?.context,
			filter?.displayName,
			filter?.category,
		],
	)

	const [draftFilter, setDraftFilter] = useState<LogFilter>(() => defaultsFilter)
	const [activeFilter, setActiveFilter] = useState<LogFilter>(() => defaultsFilter)

	useEffect(() => {
		setDraftFilter(defaultsFilter)
		setActiveFilter(defaultsFilter)
	}, [
		defaultsFilter.name,
		defaultsFilter.pluginId,
		defaultsFilter.context,
		defaultsFilter.displayName,
		defaultsFilter.category,
	])

	const dirty = useMemo(
		() => !sameFilter(normalizeFilter(draftFilter), activeFilter),
		[draftFilter, activeFilter],
	)

	const applyNow = useCallback(() => {
		setActiveFilter(normalizeFilter(draftFilter))
	}, [draftFilter])

	useEffect(() => {
		if (!dirty) return
		const t = setTimeout(() => {
			setActiveFilter(normalizeFilter(draftFilter))
		}, 350)
		return () => clearTimeout(t)
	}, [dirty, draftFilter])

	const filterQuery = useMemo(() => {
		const params = new URLSearchParams()
		if (activeFilter.name) params.set('name', activeFilter.name)
		if (activeFilter.pluginId) params.set('pluginId', activeFilter.pluginId)
		if (activeFilter.context) params.set('context', activeFilter.context)
		if (activeFilter.displayName) params.set('displayName', activeFilter.displayName)
		if (activeFilter.category) params.set('category', activeFilter.category)
		return params.toString()
	}, [activeFilter])

	const ringRef = useRef(createRingStore<RuntimeLogLine>(CLIENT_RING_CAP))
	const listApiRef = useRef<LogListApi | null>(null)
	const followRef = useRef(true)
	const followWantedRef = useRef(true)
	const rafRef = useRef<number | null>(null)
	const pendingLinesRef = useRef<RuntimeLogLine[]>([])

	// —— 快照 + SSE（仅跟随 filterQuery 变化） —— //
	const abortRef = useRef<AbortController | null>(null)
	const authProbeInFlightRef = useRef<Promise<boolean> | null>(null)
	const lastAuthProbeAtRef = useRef<number>(0)

	const refreshStreams = useCallback(async () => {
		try {
			const payload = await hmr.api.logs.streams()
			const ids = payload.streams.map((stream) => stream.streamId).filter(Boolean)
			ids.sort((a: string, b: string) => a.localeCompare(b))
			if (ids.length) setStreams(ids)
		} catch {
			// ignore
		}
	}, [hmr.api.logs])

	useEffect(() => {
		if (variant !== 'full') return
		void refreshStreams()
	}, [refreshStreams, variant])

	useEffect(() => {
		let disposed = false

		// reset state
		if (abortRef.current) {
			abortRef.current.abort()
			abortRef.current = null
		}
		if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
		rafRef.current = null
		pendingLinesRef.current.length = 0
		ringRef.current.clear()
		setMeta(null)
		setConnected(false)
		setNewSincePause(0)
		setSelectedSeq(null)
		setSelectedLine(null)

		// —— 拉快照 —— //
		const ac = new AbortController()
		abortRef.current = ac

		const probeAuthBlocked = async (): Promise<boolean> => {
			const now = Date.now()
			if (now - lastAuthProbeAtRef.current < 1500) return false
			lastAuthProbeAtRef.current = now
			try {
				const payload = await hmr.api.meta.auth()
				if (payload.enabled !== true) return false
				if (payload.authenticated === true) return false
				const redirectPath =
					typeof payload.redirectPath === 'string' && payload.redirectPath
						? payload.redirectPath
						: undefined
				if (redirectPath && typeof window !== 'undefined') window.location.assign(redirectPath)
				return true
			} catch {
				return false
			}
		}

		const fetchMeta = async (): Promise<LogStreamMeta> => {
			return hmr.api.logs.meta(streamId, { signal: ac.signal })
		}

		const fetchRange = async (
			m: LogStreamMeta,
			fromSeq: string,
			limit: number,
		): Promise<LogRangeOk> => {
			const payload = await hmr.api.logs.range(
				streamId,
				{
					epoch: m.epoch,
					from: fromSeq,
					limit,
					...activeFilter,
				},
				{ signal: ac.signal },
			)
			if (!isRecord(payload) || payload.ok !== true) throw new Error('Invalid range response')
			return payload as LogRangeOk
		}

		const flush = () => {
			rafRef.current = null
			if (pendingLinesRef.current.length === 0) return
			const added = pendingLinesRef.current.length
			ringRef.current.pushMany(pendingLinesRef.current)
			pendingLinesRef.current.length = 0
			if (!followRef.current) setNewSincePause((n) => n + added)
		}
		const scheduleFlush = () => {
			if (rafRef.current != null) return
			rafRef.current = requestAnimationFrame(flush)
		}

		const onAppendLines = (lines: RuntimeLogLine[]) => {
			if (disposed || ac.signal.aborted) return
			if (!lines.length) return
			pendingLinesRef.current.push(...lines)
			scheduleFlush()
		}

		const connectFollow = (m: LogStreamMeta, fromSeq: string) => {
			const params = new URLSearchParams(filterQuery)
			params.set('epoch', String(m.epoch))
			params.set('from', fromSeq)
			const url = hmr.api.logs.followUrl(streamId, params)
			const es = new EventSource(url)

			es.onopen = () => setConnected(true)

			const onMsg = (ev: MessageEvent) => {
				let msg: LogSseEvent | null = null
				try {
					msg = JSON.parse(ev.data) as LogSseEvent
				} catch {
					return
				}
				if (!msg || typeof msg !== 'object') return

				if (msg.type === 'reset') {
					setMeta(msg)
					ringRef.current.clear()
					pendingLinesRef.current.length = 0
					setNewSincePause(0)
					setSelectedSeq(null)
					setSelectedLine(null)
					return
				}

				if (msg.type === 'append') {
					onAppendLines(msg.lines ?? [])
					return
				}

				if (msg.type === 'gap') {
					const stop = addSeq(msg.missingTo, 1n)
					if (!stop) return

					let cursor = msg.missingFrom
					const loop = async () => {
						if (disposed || ac.signal.aborted) return
						try {
							const mm = (await fetchMeta()) as LogStreamMeta
							setMeta(mm)
							while (cursor !== stop && !disposed && !ac.signal.aborted) {
								const out = await fetchRange(mm, cursor, RANGE_LIMIT)
								cursor = out.nextSeq
								onAppendLines(out.lines)
							}
						} catch {
							// ignore
						}
					}
					void loop()
				}
			}

			es.addEventListener('reset', (ev) => onMsg(ev as MessageEvent))
			es.addEventListener('append', (ev) => onMsg(ev as MessageEvent))
			es.addEventListener('gap', (ev) => onMsg(ev as MessageEvent))

			es.onerror = () => {
				setConnected(false)
				if (authProbeInFlightRef.current) return
				authProbeInFlightRef.current = probeAuthBlocked().finally(() => {
					authProbeInFlightRef.current = null
				})
				void authProbeInFlightRef.current.then((blocked) => {
					if (blocked) es.close()
				})
			}

			return es
		}

		let es: EventSource | null = null
		;(async () => {
			try {
				const m = await fetchMeta()
				if (disposed || ac.signal.aborted) return
				setMeta(m)

				const tail = seqToBigint(m.tailSeq) ?? 0n
				const head = seqToBigint(m.headSeq) ?? 1n
				const start = tail > 0n ? tail - BigInt(Math.max(1, SNAPSHOT_MAX - 1)) + 1n : head
				const from = (start < head ? head : start).toString(10)
				// Single source of truth: follow SSE (it will send reset + catch-up appends).
				es = connectFollow(m, from)
			} catch {
				// ignore
			} finally {
				abortRef.current = null
			}
		})()

		return () => {
			disposed = true
			if (abortRef.current) {
				abortRef.current.abort()
				abortRef.current = null
			}
			if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
			rafRef.current = null
			es?.close()
		}
	}, [filterQuery, hmr, streamId])

	useEffect(() => {
		followRef.current = follow
	}, [follow])

	useEffect(() => {
		if (!follow) return
		setNewSincePause(0)
		listApiRef.current?.scrollToTail()
	}, [follow])

	useEffect(() => {
		if (!copied) return
		const t = setTimeout(() => setCopied(null), 900)
		return () => clearTimeout(t)
	}, [copied])

	const isFull = variant === 'full'
	const showSidePanel = isFull || !!selectedLine

	const clearLogs = useCallback(() => {
		ringRef.current.clear()
		pendingLinesRef.current.length = 0
		setSelectedSeq(null)
		setSelectedLine(null)
		setNewSincePause(0)
	}, [])

	const scrollToTail = useCallback(() => {
		listApiRef.current?.scrollToTail()
	}, [])

	return (
		<div
			style={{
				flex: 1,
				height: '100%',
				minHeight: 0,
				width: '100%',
				minWidth: 0,
				display: 'flex',
				flexDirection: 'column',
				gap: 8,
				overflow: 'hidden',
			}}
		>
			{/* Minimal header (embedded pages stay clean) */}
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					flexWrap: 'wrap',
					gap: 10,
					rowGap: 8,
					flex: '0 0 auto',
					fontFamily: MONO_FONT,
					fontSize: 12,
					color: '#94a3b8',
					background: PANEL_BG,
					border: BORDER,
					borderRadius: 10,
					padding: '8px 10px',
					backdropFilter: 'blur(8px)',
				}}
			>
				<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
					<label style={{ cursor: 'pointer', userSelect: 'none', display: 'flex', gap: 6 }}>
						<input
							type="checkbox"
							checked={follow}
							onChange={(e) => {
								const next = e.currentTarget.checked
								followWantedRef.current = next
								setFollow(next)
							}}
						/>
						<span>follow</span>
					</label>
					{!follow && newSincePause > 0 ? (
						<button
							type="button"
							onClick={() => {
								followWantedRef.current = true
								setFollow(true)
							}}
							style={{
								fontFamily: MONO_FONT,
								fontSize: 12,
								cursor: 'pointer',
								background: 'rgba(59,130,246,0.18)',
								border: BORDER,
								borderRadius: 8,
								color: '#e2e8f0',
								padding: '2px 8px',
							}}
						>
							+{newSincePause} new
						</button>
					) : null}
				</div>

				<label style={{ cursor: 'pointer', userSelect: 'none', display: 'flex', gap: 6 }}>
					<input
						type="checkbox"
						checked={showCategory}
						onChange={(e) => setShowCategory(e.currentTarget.checked)}
					/>
					<span>category</span>
				</label>
				<label style={{ cursor: 'pointer', userSelect: 'none', display: 'flex', gap: 6 }}>
					<input
						type="checkbox"
						checked={ansi}
						onChange={(e) => setAnsi(e.currentTarget.checked)}
					/>
					<span>ansi</span>
				</label>

				<div style={{ opacity: 0.8 }}>
					{connected ? 'connected' : 'disconnected'}
					{meta ? ` · epoch=${meta.epoch} · tail=${meta.tailSeq}` : ''}
				</div>

				{!isFull && activeFilter.name ? (
					<div style={{ opacity: 0.8 }}>· filter={activeFilter.name}</div>
				) : null}

				<div style={{ flex: 1 }} />

				{/* Embedded pages: keep essential actions here */}
				{!isFull ? (
					<>
						<button
							type="button"
							onClick={clearLogs}
							style={{
								fontFamily: MONO_FONT,
								fontSize: 12,
								cursor: 'pointer',
								background: 'rgba(148,163,184,0.12)',
								border: BORDER,
								borderRadius: 8,
								color: '#e2e8f0',
								padding: '2px 8px',
							}}
						>
							clear
						</button>
						<button
							type="button"
							onClick={scrollToTail}
							style={{
								fontFamily: MONO_FONT,
								fontSize: 12,
								cursor: 'pointer',
								background: 'rgba(148,163,184,0.12)',
								border: BORDER,
								borderRadius: 8,
								color: '#e2e8f0',
								padding: '2px 8px',
							}}
						>
							tail
						</button>
					</>
				) : null}
			</div>

			<div style={{ display: 'flex', flex: 1, minHeight: 0, minWidth: 0, gap: 10 }}>
				<LogList
					store={ringRef.current}
					showCategory={showCategory}
					showName={showName}
					ansi={ansi}
					selectedSeq={selectedSeq}
					setSelectedSeq={setSelectedSeq}
					setSelectedLine={setSelectedLine}
					follow={follow}
					followRef={followRef}
					followWantedRef={followWantedRef}
					setFollow={setFollow}
					setNewSincePause={setNewSincePause}
					apiRef={listApiRef}
					metaCount={meta?.count}
				/>

				{showSidePanel ? (
					<div
						style={{
							width: 420,
							flex: '0 0 auto',
							minHeight: 0,
							overflow: 'hidden',
							display: 'flex',
							flexDirection: 'column',
							fontFamily: MONO_FONT,
							fontSize: 12,
							background: PANEL_BG,
							border: BORDER,
							borderRadius: 8,
							backdropFilter: 'blur(10px)',
						}}
					>
						<div
							style={{
								flex: '0 0 auto',
								padding: 10,
								background: 'rgba(2, 6, 23, 0.78)',
								borderBottom: BORDER,
								backdropFilter: 'blur(10px)',
							}}
						>
							{isFull ? (
								<>
									<div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
										<div style={{ color: '#e2e8f0' }}>query</div>
										<div style={{ flex: 1 }} />
										<button
											type="button"
											onClick={clearLogs}
											style={{
												fontFamily: MONO_FONT,
												fontSize: 12,
												cursor: 'pointer',
												background: 'rgba(148,163,184,0.12)',
												border: BORDER,
												borderRadius: 8,
												color: '#e2e8f0',
												padding: '2px 8px',
											}}
										>
											clear
										</button>
										<button
											type="button"
											onClick={scrollToTail}
											style={{
												fontFamily: MONO_FONT,
												fontSize: 12,
												cursor: 'pointer',
												background: 'rgba(148,163,184,0.12)',
												border: BORDER,
												borderRadius: 8,
												color: '#e2e8f0',
												padding: '2px 8px',
											}}
										>
											tail
										</button>
									</div>

									<div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
										<span style={{ opacity: 0.8 }}>stream</span>
										<input
											value={streamIdInput}
											onChange={(e) => setStreamIdInput(e.currentTarget.value)}
											list={streamDatalistId}
											spellCheck={false}
											style={{
												fontFamily: MONO_FONT,
												fontSize: 12,
												padding: '2px 8px',
												borderRadius: 8,
												border: BORDER,
												color: '#e2e8f0',
												background: 'rgba(15,23,42,0.55)',
												width: 220,
											}}
										/>
										<button
											type="button"
											onClick={() => void refreshStreams()}
											style={{
												fontFamily: MONO_FONT,
												fontSize: 12,
												cursor: 'pointer',
												background: 'rgba(148,163,184,0.12)',
												border: BORDER,
												borderRadius: 8,
												color: '#e2e8f0',
												padding: '2px 8px',
											}}
										>
											refresh
										</button>
										<datalist id={streamDatalistId}>
											{streams.map((s) => (
												<option key={s} value={s} />
											))}
										</datalist>
									</div>

									<div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
										<div
											style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}
										>
											<span style={{ opacity: 0.8 }}>filter</span>
											<input
												value={draftFilter.name ?? ''}
												onChange={(e) =>
													setDraftFilter((f) => ({
														...f,
														name: e.currentTarget.value || undefined,
													}))
												}
												onKeyDown={(e) => {
													if (e.key === 'Enter') applyNow()
												}}
												spellCheck={false}
												placeholder="name / pluginId / context"
												style={{
													fontFamily: MONO_FONT,
													fontSize: 12,
													padding: '2px 8px',
													borderRadius: 8,
													border: BORDER,
													color: '#e2e8f0',
													background: 'rgba(15,23,42,0.55)',
													width: 260,
												}}
											/>
											<input
												value={draftFilter.pluginId ?? ''}
												onChange={(e) =>
													setDraftFilter((f) => ({
														...f,
														pluginId: e.currentTarget.value || undefined,
													}))
												}
												onKeyDown={(e) => {
													if (e.key === 'Enter') applyNow()
												}}
												spellCheck={false}
												placeholder="pluginId"
												style={{
													fontFamily: MONO_FONT,
													fontSize: 12,
													padding: '2px 8px',
													borderRadius: 8,
													border: BORDER,
													color: '#e2e8f0',
													background: 'rgba(15,23,42,0.55)',
													width: 180,
												}}
											/>
											<input
												value={draftFilter.context ?? ''}
												onChange={(e) =>
													setDraftFilter((f) => ({
														...f,
														context: e.currentTarget.value || undefined,
													}))
												}
												onKeyDown={(e) => {
													if (e.key === 'Enter') applyNow()
												}}
												spellCheck={false}
												placeholder="context"
												style={{
													fontFamily: MONO_FONT,
													fontSize: 12,
													padding: '2px 8px',
													borderRadius: 8,
													border: BORDER,
													color: '#e2e8f0',
													background: 'rgba(15,23,42,0.55)',
													width: 180,
												}}
											/>
											<input
												value={draftFilter.category ?? ''}
												onChange={(e) =>
													setDraftFilter((f) => ({
														...f,
														category: e.currentTarget.value || undefined,
													}))
												}
												onKeyDown={(e) => {
													if (e.key === 'Enter') applyNow()
												}}
												spellCheck={false}
												placeholder="category (a.b.*)"
												style={{
													fontFamily: MONO_FONT,
													fontSize: 12,
													padding: '2px 8px',
													borderRadius: 8,
													border: BORDER,
													color: '#e2e8f0',
													background: 'rgba(15,23,42,0.55)',
													width: 260,
												}}
											/>
										</div>

										<div
											style={{
												display: 'flex',
												alignItems: 'center',
												gap: 8,
												flexWrap: 'wrap',
											}}
										>
											{dirty ? (
												<button
													type="button"
													onClick={applyNow}
													style={{
														fontFamily: MONO_FONT,
														fontSize: 12,
														cursor: 'pointer',
														background: 'rgba(59,130,246,0.18)',
														border: BORDER,
														borderRadius: 8,
														color: '#e2e8f0',
														padding: '2px 8px',
													}}
												>
													apply
												</button>
											) : null}
											<button
												type="button"
												onClick={() => {
													setDraftFilter(defaultsFilter)
													setActiveFilter(defaultsFilter)
												}}
												style={{
													fontFamily: MONO_FONT,
													fontSize: 12,
													cursor: 'pointer',
													background: 'rgba(148,163,184,0.12)',
													border: BORDER,
													borderRadius: 8,
													color: '#e2e8f0',
													padding: '2px 8px',
												}}
											>
												reset
											</button>
											<button
												type="button"
												onClick={() => {
													setDraftFilter({})
													setActiveFilter({})
												}}
												style={{
													fontFamily: MONO_FONT,
													fontSize: 12,
													cursor: 'pointer',
													background: 'rgba(148,163,184,0.12)',
													border: BORDER,
													borderRadius: 8,
													color: '#e2e8f0',
													padding: '2px 8px',
												}}
											>
												all
											</button>
											<div style={{ flex: 1 }} />
											<div style={{ opacity: 0.75 }}>
												{activeFilter.name ||
												activeFilter.pluginId ||
												activeFilter.context ||
												activeFilter.category
													? 'live'
													: 'no filter'}
												{dirty ? ' · (pending)' : ''}
											</div>
										</div>
									</div>
								</>
							) : null}

							{selectedLine ? (
								<div
									style={{
										display: 'flex',
										alignItems: 'center',
										gap: 8,
										marginTop: isFull ? 10 : 0,
									}}
								>
									<div style={{ color: '#e2e8f0' }}>details</div>
									<div style={{ color: '#94a3b8' }}>
										seq={selectedLine.seq} · level={selectedLine.level}
									</div>
									<div style={{ flex: 1 }} />
									{copied ? (
										<div style={{ color: '#94a3b8', opacity: 0.9 }}>
											{copied === 'line' ? 'copied line' : 'copied json'}
										</div>
									) : null}
									<button
										type="button"
										onClick={() => {
											void copyToClipboard(
												formatLineForCopy(selectedLine, { showCategory, showName }),
											).then((ok) => {
												if (ok) setCopied('line')
											})
										}}
										style={{
											fontFamily: MONO_FONT,
											fontSize: 12,
											cursor: 'pointer',
											background: 'rgba(148,163,184,0.12)',
											border: BORDER,
											borderRadius: 8,
											color: '#e2e8f0',
											padding: '2px 8px',
										}}
									>
										copy
									</button>
									<button
										type="button"
										onClick={() => {
											void copyToClipboard(JSON.stringify(selectedLine, null, 2)).then((ok) => {
												if (ok) setCopied('json')
											})
										}}
										style={{
											fontFamily: MONO_FONT,
											fontSize: 12,
											cursor: 'pointer',
											background: 'rgba(148,163,184,0.12)',
											border: BORDER,
											borderRadius: 8,
											color: '#e2e8f0',
											padding: '2px 8px',
										}}
									>
										json
									</button>
									<button
										type="button"
										onClick={() => {
											setSelectedSeq(null)
											setSelectedLine(null)
										}}
										style={{
											fontFamily: MONO_FONT,
											fontSize: 12,
											cursor: 'pointer',
											background: 'rgba(148,163,184,0.12)',
											border: BORDER,
											borderRadius: 8,
											color: '#e2e8f0',
											padding: '2px 8px',
										}}
									>
										close
									</button>
								</div>
							) : isFull ? (
								<div style={{ color: '#94a3b8', marginTop: 10 }}>
									(select a line to inspect props)
								</div>
							) : null}
						</div>

						<div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 10 }}>
							{selectedLine ? (
								<>
									{selectedLine.error ? (
										<pre style={{ margin: 0, padding: 0, color: '#fb7185' }}>
											{JSON.stringify(selectedLine.error, null, 2)}
										</pre>
									) : null}
									{selectedLine.props ? (
										<pre style={{ margin: 0, padding: 0, color: '#e2e8f0' }}>
											{JSON.stringify(selectedLine.props, null, 2)}
										</pre>
									) : (
										<div style={{ color: '#94a3b8' }}>(no props)</div>
									)}
									{selectedLine.raw ? (
										<pre style={{ marginTop: 10, padding: 0, color: '#94a3b8' }}>
											{JSON.stringify(selectedLine.raw, null, 2)}
										</pre>
									) : null}
								</>
							) : null}
						</div>
					</div>
				) : null}
			</div>
		</div>
	)
}
