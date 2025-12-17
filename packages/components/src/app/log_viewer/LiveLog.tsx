// src/components/LiveLog.tsx

import { useElementSize } from '@mantine/hooks'
import { LazyLog, ScrollFollow } from '@melloware/react-logviewer'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { sse } from '../rpc'
import { createPrettyPrinter } from './pretty'

const pretty = createPrettyPrinter({
	forceColor: true,
	ignoreKeys: ['caller'],
	withDate: true,
	withMillis: true,
	withIcons: false,
	extrasStyle: 'kv',
	extrasMaxLen: 120,
	nameMax: 24,
})

interface Props {
	module?: string
}

const SNAPSHOT_MAX = 1000 // 首屏最多加载多少行历史
const RAW_RING_CAP = 4000 // 原始环容量（原始行）
const VIEW_RING_CAP = 4000 // 展示环容量（wrap 后的行）
const FLUSH_MS = 80 // 合批最迟刷新间隔
const SEEN_TTL_MS = 3000 // 去重时间窗：快照与首段 SSE 重叠
const RECONNECT_MIN = 800 // SSE 最小重连间隔
const RECONNECT_MAX = 10_000 // SSE 最大重连间隔

/* ================= 等宽字符宽度测量（更稳的平均法） ================= */
const MONO_FONT = '13px ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'
const LOG_SIDE_PADDING = 32 // LazyLog 视图左右内边距（估算用于列数换算）
const MIN_COLS = 8

function measureMonoCharWidth(): number {
	if (typeof document === 'undefined') return 7
	const canvas = document.createElement('canvas')
	const ctx = canvas.getContext('2d')!
	ctx.font = MONO_FONT
	const sample = '00000000000000000000000000000000000000000000000000' // 50
	return ctx.measureText(sample).width / sample.length
}

/* ================= ANSI 安全硬换行（CJK 宽字符适配） ================= */
function isFullwidthCP(cp: number): boolean {
	return (
		(cp >= 0x1100 && cp <= 0x115f) ||
		(cp >= 0x2e80 && cp <= 0xa4cf) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe10 && cp <= 0xfe6f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6)
	)
}
function hardWrapAnsi(line: string, cols: number): string[] {
	if (cols <= 0 || line.length === 0) return [line]
	const out: string[] = []
	let buf = ''
	let col = 0
	const len = line.length

	for (let i = 0; i < len; ) {
		const ch = line.charCodeAt(i)

		// ANSI CSI: \x1b[ ... <final>
		if (ch === 0x1b && i + 1 < len && line.charCodeAt(i + 1) === 0x5b) {
			let j = i + 2
			while (j < len) {
				const c = line.charCodeAt(j)
				if (c >= 0x40 && c <= 0x7e) {
					j++
					break
				}
				j++
			}
			buf += line.slice(i, j)
			i = j
			continue
		}

		// 普通字符（含代理对）
		let cp = ch
		let step = 1
		if (ch >= 0xd800 && ch <= 0xdbff && i + 1 < len) {
			const ch2 = line.charCodeAt(i + 1)
			if (ch2 >= 0xdc00 && ch2 <= 0xdfff) {
				cp = (ch - 0xd800) * 0x400 + (ch2 - 0xdc00) + 0x10000
				step = 2
			}
		}
		const char = line.substr(i, step)
		const w = isFullwidthCP(cp) ? 2 : 1
		if (col + w > cols) {
			out.push(buf)
			buf = ''
			col = 0
		}
		buf += char
		col += w
		i += step
	}
	if (buf) out.push(buf)
	return out
}

/* ================= 轻量环形缓冲（O(1) push + 有序遍历） ================= */
function createRing(cap = 2000) {
	const buf = new Array<string>(cap)
	let start = 0
	let len = 0
	return {
		clear() {
			start = 0
			len = 0
		},
		push(s: string) {
			if (len < cap) {
				buf[(start + len) % cap] = s
				len++
			} else {
				buf[start] = s
				start = (start + 1) % cap
			}
		},
		toArray(): string[] {
			if (len === 0) return []
			if (start + len <= cap) return buf.slice(start, start + len)
			return buf.slice(start).concat(buf.slice(0, (start + len) % cap))
		},
		join(sep = '\n'): string {
			if (len === 0) return ''
			if (start + len <= cap) return buf.slice(start, start + len).join(sep)
			return buf
				.slice(start)
				.concat(buf.slice(0, (start + len) % cap))
				.join(sep)
		},
	}
}

/* ================== LiveLog ================== */
export function LiveLog({ module }: Props) {
	const { ref, height, width } = useElementSize()
	const [text, setText] = useState('')

	// —— 列数估算（与组件换行解耦） —— //
	const [cols, setCols] = useState<number>(0)
	const charWRef = useRef<number>(0)
	useEffect(() => {
		if (!charWRef.current) charWRef.current = measureMonoCharWidth()
		const gutter = LOG_SIDE_PADDING
		const cw = charWRef.current || 7
		const nextCols = Math.max(MIN_COLS, Math.floor(Math.max(0, width - gutter) / cw))
		setCols((prev) => (prev === nextCols ? prev : nextCols))
	}, [width])

	// —— 两层环：原始行（raw）与展示行（view） —— //
	const rawRingRef = useRef(createRing(RAW_RING_CAP))
	const viewRingRef = useRef(createRing(VIEW_RING_CAP))

	// —— 去重 TTL（快照+首段 SSE 重叠；严格模式重复副作用） —— //
	const seenRef = useRef(new Map<string, number>())
	const sweepSeen = (now: number) => {
		for (const [k, exp] of seenRef.current) if (exp <= now) seenRef.current.delete(k)
	}

	// —— 合批刷入（把“展示行”批量落入 viewRing，再 setText） —— //
	const pendingViewRef = useRef<string[]>([])
	const rafRef = useRef<number | null>(null)
	const flushTimerRef = useRef<number | ReturnType<typeof setTimeout> | null>(null)
	const flush = () => {
		rafRef.current = null
		if (flushTimerRef.current) {
			clearTimeout(flushTimerRef.current as any)
			flushTimerRef.current = null
		}
		if (pendingViewRef.current.length === 0) return
		const v = viewRingRef.current
		for (let i = 0; i < pendingViewRef.current.length; i++) v.push(pendingViewRef.current[i])
		pendingViewRef.current.length = 0
		setText(v.join())
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
	const pushRaw = (rawLine: string) => {
		const now = Date.now()
		sweepSeen(now)
		if (seenRef.current.has(rawLine)) return
		seenRef.current.set(rawLine, now + SEEN_TTL_MS)

		rawRingRef.current.push(rawLine)

		const prettyLine = pretty.formatLine(rawLine)
		const lines = cols > 0 ? hardWrapAnsi(prettyLine, cols) : [prettyLine]
		for (let i = 0; i < lines.length; i++) pendingViewRef.current.push(lines[i])
		scheduleFlush()
	}

	// —— 列数变化时，仅“本地重排展示环”，不触发网络/重连 —— //
	const rebuildIdleRef = useRef<number | null>(null)
	useEffect(() => {
		// 取消上一个重排
		if (rebuildIdleRef.current != null) {
			const cancelIdle = (window as any).cancelIdleCallback
			cancelIdle ? cancelIdle(rebuildIdleRef.current) : clearTimeout(rebuildIdleRef.current as any)
			rebuildIdleRef.current = null
		}
		// 重新 wrap raw → view
		const run = () => {
			const raw = rawRingRef.current.toArray()
			const view = viewRingRef.current
			view.clear()
			for (let i = 0; i < raw.length; i++) {
				const prettyLine = pretty.formatLine(raw[i])
				const lines = cols > 0 ? hardWrapAnsi(prettyLine, cols) : [prettyLine]
				for (let j = 0; j < lines.length; j++) view.push(lines[j])
			}
			setText(view.join())
		}
		const ric = (window as any).requestIdleCallback as
			| ((cb: (dl: any) => void, opts?: { timeout?: number }) => number)
			| undefined
		if (ric) {
			rebuildIdleRef.current = ric(() => run(), { timeout: 200 })
		} else {
			rebuildIdleRef.current = window.setTimeout(run, 0)
		}
		return () => {
			if (rebuildIdleRef.current != null) {
				const cancelIdle = (window as any).cancelIdleCallback
				cancelIdle
					? cancelIdle(rebuildIdleRef.current)
					: clearTimeout(rebuildIdleRef.current as any)
				rebuildIdleRef.current = null
			}
		}
	}, [cols])

	// —— 快照 + SSE（仅跟随 module 变化；不受 cols 影响） —— //
	const streamRef = useRef<ReturnType<typeof sse> | null>(null)
	const abortRef = useRef<AbortController | null>(null)
	const didInitRef = useRef(false) // dev 下规避严格模式二次执行

	useEffect(() => {
		if (process.env.NODE_ENV !== 'production') {
			if (didInitRef.current) return
			didInitRef.current = true
		}

		// reset state
		if (abortRef.current) {
			abortRef.current.abort()
			abortRef.current = null
		}
		if (streamRef.current) {
			streamRef.current.close()
			streamRef.current = null
		}
		rawRingRef.current.clear()
		viewRingRef.current.clear()
		pendingViewRef.current.length = 0
		seenRef.current.clear()
		setText('')

		// —— 拉快照 —— //
		const params = new URLSearchParams()
		if (module) params.set('name', module)
		const ac = new AbortController()
		abortRef.current = ac

		fetch(`/api/logs/latest?${params.toString()}`, { signal: ac.signal })
			.then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
			.then((t) => {
				const lines = t.split('\n').filter(Boolean)
				const start = Math.max(0, lines.length - SNAPSHOT_MAX)
				for (let i = start; i < lines.length; i++) pushRaw(lines[i])
			})
			.catch(() => {})
			.finally(() => {
				abortRef.current = null
			})

		// —— 连接 SSE —— //
		const stream = sse({
			namespaces: ['logs'],
			params: module ? { name: module } : undefined,
			retry: { min: RECONNECT_MIN, max: RECONNECT_MAX },
		})
		streamRef.current = stream
		const off = stream.logs.on((msg) => {
			if (msg.event !== 'log') return
			const payload = msg.payload as any
			const enriched =
				payload && typeof payload === 'object'
					? { level: 'info', time: new Date().toISOString(), ...payload }
					: { level: 'info', time: new Date().toISOString(), msg: String(payload ?? '') }
			try {
				pushRaw(JSON.stringify(enriched))
			} catch {
				// ignore
			}
		})

		return () => {
			if (abortRef.current) {
				abortRef.current.abort()
				abortRef.current = null
			}
			off()
			if (streamRef.current) {
				streamRef.current.close()
				streamRef.current = null
			}
			if (process.env.NODE_ENV !== 'production') {
				didInitRef.current = false
			}
		}
	}, [module])

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
							key={module ?? 'all'}
							height={logHeight}
							text={text}
							external
							follow={follow}
							onScroll={onScroll}
							selectableLines
							wrapLines={false} // 自己做了硬换行
							rowHeight={20}
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
								overflowX: 'hidden',
							}}
						/>
					)}
				/>
			</div>
		</div>
	)
}
