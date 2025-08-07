import React from 'react'
import { LazyLog, ScrollFollow } from '@melloware/react-logviewer'

/** 可选：把 JSON 字符串“美化”一下 */
function prettyLine(line: string) {
	try {
		const obj = JSON.parse(line)
		return JSON.stringify(obj, null, 2)
	} catch {
		return line
	}
}

/** 静态快照 */
export function LogSnapshot({
	module,
	limit = 10,
}: { module?: string; limit?: number }) {
	const query = module
		? `?name=${encodeURIComponent(module)}&limit=${limit}`
		: `?limit=${limit}`

	return (
		<div style={{ height: 300, width: '100%' }}>
			<LazyLog
				url={`/api/logs/latest${query}`}
				selectableLines
				transformLog={prettyLine}
				onError={console.error}
				// extraLines 确保空行分隔
				extraLines={1}
			/>
		</div>
	)
}

/** 实时流式（SSE） */
export function LiveLog({ module }: { module?: string }) {
	const query = module ? `?name=${encodeURIComponent(module)}` : ''

	return (
		<div style={{ height: '100%', width: '100%' }}>
			<ScrollFollow
				startFollowing
				render={({ follow, onScroll }) => (
					<LazyLog
						url={`/api/logs/stream${query}`}
						stream // ← 关键：启用 SSE 模式
						follow={follow}
						onScroll={onScroll}
						selectableLines
						transformLog={prettyLine}
						onError={console.error}
						extraLines={1}
					/>
				)}
			/>
		</div>
	)
}
