import { Text } from '@mantine/core'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { RuntimeLogLine } from '../../runtime'
import { LogRow, LOG_ROW_HEIGHT } from './LogRow'
import type { LogStreamStore } from './logStreamStore'

export interface LogListProps {
	store: LogStreamStore
	selected?: RuntimeLogLine
	onSelect(line: RuntimeLogLine): void
	follow: boolean
	onFollowChange(follow: boolean): void
	showName?: boolean
	showCategory?: boolean
	ansi?: boolean
}
/** Reads only the visible range; stream ownership and buffered records belong to the caller. */
export function LogList({
	store,
	selected,
	onSelect,
	follow,
	onFollowChange,
	showName,
	showCategory,
	ansi,
}: LogListProps) {
	const version = useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion)
	const scrollRef = useRef<HTMLDivElement>(null)
	const virtualizer = useVirtualizer({
		count: store.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => LOG_ROW_HEIGHT,
		overscan: 12,
	})
	useEffect(() => {
		if (follow && store.length) virtualizer.scrollToIndex(store.length - 1, { align: 'end' })
	}, [follow, version, store, virtualizer])
	return (
		<div
			ref={scrollRef}
			aria-label="日志列表"
			onScroll={(event) => {
				const element = event.currentTarget
				if (
					follow &&
					element.scrollHeight - element.scrollTop - element.clientHeight > LOG_ROW_HEIGHT * 2
				)
					onFollowChange(false)
			}}
			style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: 'auto' }}
		>
			{!store.length && (
				<Text size="sm" c="dimmed" p="sm">
					暂无日志
				</Text>
			)}
			<div style={{ position: 'relative', height: virtualizer.getTotalSize(), width: '100%' }}>
				{virtualizer.getVirtualItems().map((item) => {
					const line = store.get(item.index)
					if (!line) return null
					return (
						<div
							key={`${line.streamId}:${line.epoch}:${line.seq}`}
							style={{
								position: 'absolute',
								top: 0,
								left: 0,
								width: '100%',
								height: item.size,
								transform: `translateY(${item.start}px)`,
							}}
						>
							<LogRow
								line={line}
								striped={item.index % 2 === 1}
								selected={
									selected?.streamId === line.streamId &&
									selected?.epoch === line.epoch &&
									selected?.seq === line.seq
								}
								onSelect={onSelect}
								showName={showName}
								showCategory={showCategory}
								ansi={ansi}
							/>
						</div>
					)
				})}
			</div>
		</div>
	)
}
