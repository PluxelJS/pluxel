import { Text } from '@mantine/core'
import { useSyncExternalStore } from 'react'
import { RouterLinkAdapter } from '../router/RouterLinkAdapter'
import { LogRow } from '../log_viewer/LogRow'
import { useLogStream } from '../log_viewer/useLogStream'

const RECENT = 8

/** The newest runtime log lines across all plugins, following live. */
export function HomeLogs() {
	const { store, status, error } = useLogStream({
		streamId: 'default',
		filter: {},
		capacity: RECENT,
		historyLimit: RECENT,
	})
	useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion)
	const lines = store.toArray().toReversed()
	return (
		<section aria-labelledby="plx-home-logs-title" className="plx-home__logs">
			<div className="plx-home__sectionHeader">
				<h2 id="plx-home-logs-title" className="plx-home__sectionTitle">
					最近日志
				</h2>
				<Text component={RouterLinkAdapter} to="/logs" size="xs" className="plx-home__allLink">
					全部日志
				</Text>
			</div>
			<div className="plx-home__logList">
				{error ? (
					<Text size="xs" c="red" className="plx-home__logEmpty">
						{error}
					</Text>
				) : lines.length === 0 ? (
					<Text size="xs" c="dimmed" className="plx-home__logEmpty">
						{status === 'loading' ? '正在读取…' : '暂无日志'}
					</Text>
				) : (
					lines.map((line) => <LogRow key={`${line.epoch}:${line.seq}`} line={line} showName />)
				)}
			</div>
		</section>
	)
}
