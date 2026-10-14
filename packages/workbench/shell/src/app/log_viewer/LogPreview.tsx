import { Button, Stack, Text } from '@mantine/core'
import type { PluginNodeAddress } from '@pluxel/core'
import { useSyncExternalStore } from 'react'
import { LogRow } from './LogRow'
import { useLogStream } from './useLogStream'

/** The inspector owns this reader; hiding it releases the subscription. */
export function LogPreview({ owner }: { owner: PluginNodeAddress }) {
	const { store, status, error, retry } = useLogStream({
		streamId: 'default',
		filter: { plugin: owner },
		capacity: 10,
		historyLimit: 10,
	})
	useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion)
	return (
		<Stack gap="xs" role="region" aria-label="最近插件日志" style={{ minWidth: 0 }}>
			{error && (
				<>
					<Text size="xs" c="red" role="alert">
						{error}
					</Text>
					<Button size="compact-xs" variant="default" onClick={retry}>
						重试
					</Button>
				</>
			)}
			{!store.length && !error && (
				<Text size="xs" c="dimmed">
					{status === 'loading' ? '正在读取日志…' : '暂无日志'}
				</Text>
			)}
			<ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
				{store.toArray().map((line, index) => (
					<li key={`${line.epoch}:${line.seq}`}>
						<LogRow line={line} preview striped={index % 2 === 1} />
					</li>
				))}
			</ol>
		</Stack>
	)
}
