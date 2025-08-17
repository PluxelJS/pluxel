import React, { useEffect, useRef, useState } from 'react'
import { LazyLog, ScrollFollow } from '@melloware/react-logviewer'
import { useElementSize } from '@mantine/hooks'
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

const SNAPSHOT_MAX = 1000
const RING_CAP = 2000
const FLUSH_MS = 80

/* ========= 关键①：等宽字符宽度测量 + 列数推导 ========= */
const MONO_FONT =
	'13px ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'

function measureMonoCharWidth(): number {
	const canvas = document.createElement('canvas')
	const ctx = canvas.getContext('2d')!
	ctx.font = MONO_FONT
	// 用一段长串取平均更稳
	const sample = '0'.repeat(100)
	return ctx.measureText(sample).width / sample.length
}

/* ========= 关键②：ANSI 安全硬换行（不依赖组件换行） ========= */
/** 检测 CJK 全角字符（宽度≈2 列） */
function isFullwidthCP(cp: number): boolean {
	// 简化版（覆盖主流 CJK 和全角块）
	return (
		(cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
		(cp >= 0x2e80 && cp <= 0xa4cf) || // CJK Radicals..Yi
		(cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
		(cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
		(cp >= 0xfe10 && cp <= 0xfe6f) || // Vertical forms, Small form variants
		(cp >= 0xff00 && cp <= 0xff60) || // 全角 ASCII 等
		(cp >= 0xffe0 && cp <= 0xffe6)
	)
}

/** 把一行带 ANSI 的文本按列数硬换行，返回多行 */
function hardWrapAnsi(line: string, cols: number): string[] {
	if (cols <= 0 || line.length === 0) return [line]

	const out: string[] = []
	let buf = ''
	let col = 0
	const len = line.length

	for (let i = 0; i < len; ) {
		const ch = line.charCodeAt(i)

		// 处理 ANSI CSI 序列：\x1b[ ... <final>
		if (ch === 0x1b /* ESC */ && i + 1 < len) {
			const next = line.charCodeAt(i + 1)
			if (next === 0x5b /* '[' */) {
				// 吞掉直到 @-~ 结束符
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
		}

		// 普通字符（考虑代理对）
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

		// 如果放不下了，换行（不打断 ANSI，因为上面已处理）
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

/* ========= 一个很小的环形缓冲（O(1) push） ========= */
function createRing(cap = RING_CAP) {
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
		toString() {
			if (len === 0) return ''
			if (start + len <= cap) return buf.slice(start, start + len).join('\n')
			return buf
				.slice(start)
				.concat(buf.slice(0, (start + len) % cap))
				.join('\n')
		},
	}
}

export function LiveLog({ module }: Props) {
	const [text, setText] = useState('')
	const { ref, height, width } = useElementSize()
	const ringRef = useRef(createRing())
	const rafRef = useRef<number | null>(null)
	const flushTimerRef = useRef<number | ReturnType<typeof setTimeout> | null>(
		null,
	)
	const esRef = useRef<EventSource | null>(null)
	const abortRef = useRef<AbortController | null>(null)

	// —— 列数：由容器可用宽度 / 等宽字符宽度 估算 —— //
	const [cols, setCols] = useState<number>(0)
	const charWRef = useRef<number>(0)

	useEffect(() => {
		if (!charWRef.current) charWRef.current = measureMonoCharWidth()
		const gutter = 16 /* 预留滚动条/内边距像素 */
		const cw = charWRef.current || 7
		const nextCols = Math.max(20, Math.floor(Math.max(0, width - gutter) / cw))
		setCols(nextCols)
	}, [width])

	// —— 批量刷新 —— //
	const pendingRef = useRef<string[]>([])
	const flush = () => {
		rafRef.current = null
		if (flushTimerRef.current) {
			clearTimeout(flushTimerRef.current as any)
			flushTimerRef.current = null
		}
		if (pendingRef.current.length === 0) return
		const ring = ringRef.current
		// 逐条入环
		for (let i = 0; i < pendingRef.current.length; i++)
			ring.push(pendingRef.current[i])
		pendingRef.current.length = 0
		setText(ring.toString())
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

	// —— 统一的“加入一条 pretty 后的行（带硬换行）” —— //
	const pushPretty = (rawLine: string) => {
		const prettyLine = pretty.formatLine(rawLine)
		const lines = cols > 0 ? hardWrapAnsi(prettyLine, cols) : [prettyLine]
		// 批量放入待刷队列
		for (let i = 0; i < lines.length; i++) pendingRef.current.push(lines[i])
		scheduleFlush()
	}

	// —— 拉取快照 + SSE —— //
	useEffect(() => {
		// reset
		if (abortRef.current) {
			abortRef.current.abort()
			abortRef.current = null
		}
		if (esRef.current) {
			esRef.current.close()
			esRef.current = null
		}
		if (rafRef.current != null) {
			cancelAnimationFrame(rafRef.current)
			rafRef.current = null
		}
		if (flushTimerRef.current) {
			clearTimeout(flushTimerRef.current as any)
			flushTimerRef.current = null
		}
		ringRef.current.clear()
		pendingRef.current.length = 0
		setText('')

		const params = new URLSearchParams()
		if (module) params.set('name', module)

		// 1) 快照
		const ac = new AbortController()
		abortRef.current = ac
		fetch(`/api/logs/latest?${params.toString()}`, { signal: ac.signal })
			.then((r) =>
				r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)),
			)
			.then((text) => {
				const lines = text.split('\n').filter(Boolean)
				const start = Math.max(0, lines.length - SNAPSHOT_MAX)
				for (let i = start; i < lines.length; i++) pushPretty(lines[i])
			})
			.catch(() => {})
			.finally(() => {
				abortRef.current = null
			})

		// 2) SSE
		const es = new EventSource(`/api/logs/stream?${params.toString()}`)
		esRef.current = es
		es.onmessage = (e) => pushPretty(e.data)
		es.onerror = () => {
			es.close()
			esRef.current = null
		}

		return () => {
			if (abortRef.current) {
				abortRef.current.abort()
				abortRef.current = null
			}
			if (esRef.current) {
				esRef.current.close()
				esRef.current = null
			}
			if (rafRef.current != null) {
				cancelAnimationFrame(rafRef.current)
				rafRef.current = null
			}
			if (flushTimerRef.current) {
				clearTimeout(flushTimerRef.current as any)
				flushTimerRef.current = null
			}
		}
	}, [module, cols]) // 列数变化时，重新拼接更合适的换行
	// ↑ 如果不想因列数变化重放流，可只在快照后重排：把 [cols] 从依赖里拿掉，改成在 cols 变化时对 ring 重新 wrap 一次。

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
							height={Math.max(120, height || 0)}
							text={text}
							external
							follow={follow}
							onScroll={onScroll}
							selectableLines
							/* 关闭组件内部换行，使用我们“硬换行”后的文本 */
							wrapLines={false}
							rowHeight={20}
						/>
					)}
				/>
			</div>
		</div>
	)
}
