import React, { useEffect, useState } from 'react'
import { LazyLog, ScrollFollow } from '@melloware/react-logviewer'
import { useElementSize } from '@mantine/hooks'
import { prettyLine } from './pretty'

interface Props {
	module?: string
}

/**
 * 行为：
 * 1) 先请求 /api/logs/latest 作为初始快照；
 * 2) 再连接 /api/logs/stream 持续追加；
 * 3) 使用父容器高度（flex:1 + minHeight:0）测量后传给 LazyLog，确保吃满剩余空间。
 */
export function LiveLog({ module }: Props) {
	const [logs, setLogs] = useState<string[]>([])
	const [error, setError] = useState<string | null>(null)
	const { ref, height } = useElementSize()

	useEffect(() => {
		let cancelled = false
		setLogs([])
		setError(null)

		const params = new URLSearchParams()
		if (module) params.set('name', module)

		// 1) 快照
		fetch(`/api/logs/latest?${params.toString()}`)
			.then((r) =>
				r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)),
			)
			.then((text) => {
				if (cancelled) return
				const base = text
					.split('\n')
					.filter(Boolean)
					.map((l) => prettyLine(l))
				setLogs(base.slice(-1000)) // 限流，最多 1000 行初始
			})
			.catch(() => {
				// 快照失败不致命，继续监听流
			})

		// 2) SSE
		const es = new EventSource(`/api/logs/stream?${params.toString()}`)
		es.onmessage = (e) => {
			if (cancelled) return
			setLogs((prev) => {
				const next = [...prev, prettyLine(e.data)]
				// 滚动窗口，避免无限增长
				return next.length > 2000 ? next.slice(-2000) : next
			})
		}
		es.onerror = () => {
			if (cancelled) return
			setError('日志流中断')
			es.close()
		}

		return () => {
			cancelled = true
			es.close()
		}
	}, [module])

	if (error) {
		return (
			<div style={{ color: 'var(--mantine-color-red-6)' }}>
				加载日志出错：{error}
			</div>
		)
	}

	return (
		// 由父层决定“剩余空间”，这里把高度 100% 交给测量钩子
		<div ref={ref} style={{ height: '100%' }}>
			<ScrollFollow
				startFollowing
				render={({ follow, onScroll }) => (
					<LazyLog
						// 关键：传入**数字**高度，保证可见
						height={Math.max(120, height || 0)}
						text={logs.join('\n')}
						external
						stream={false}
						follow={follow}
						onScroll={onScroll}
						selectableLines
						format="ansi"
						wrapLines
					/>
				)}
			/>
		</div>
	)
}
