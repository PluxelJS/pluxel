import { Box, Button, Checkbox, Group, Menu, Stack, Text } from '@mantine/core'
import { parsePluginNodeReference, pluginNodeAddressEqual } from '@pluxel/core'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { RuntimeLogLine } from '../../runtime'
import { usePluginOverview } from '../plugins/pluginOverview'
import { buildLogsHref, type LogsSearch } from '../router/logsSearch'
import { useWorkbenchNavigation } from '../workbench/context'
import { LogDetails } from './LogDetails'
import { LogFilters } from './LogFilters'
import { LogList } from './LogList'
import { LogPolicyPopover } from './LogPolicyPopover'
import { useLogStream } from './useLogStream'

/** URL changes remount only the reader, keeping navigation inside the active document. */
export function LogsPage({ search }: { search: LogsSearch }) {
	return <LogDocument key={buildLogsHref(search)} search={search} />
}
function LogDocument({ search }: { search: LogsSearch }) {
	const navigation = useWorkbenchNavigation()
	const owner = useMemo(
		() => (search.plugin ? parsePluginNodeReference(search.plugin) : undefined),
		[search.plugin],
	)
	const { overview } = usePluginOverview()
	const label = owner
		? (overview?.status.statuses.find((entry) => pluginNodeAddressEqual(entry.address, owner))
				?.label ?? search.plugin)
		: '全部日志'
	const { store, status, error, meta, clear, retry } = useLogStream({
		streamId: search.stream ?? 'default',
		filter: {
			plugin: owner,
			context: search.context,
			displayName: search.displayName,
			category: search.category,
		},
		capacity: 50_000,
		historyLimit: 1500,
	})
	const version = useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion)
	const [follow, setFollow] = useState(true)
	const [pausedVersion, setPausedVersion] = useState(version)
	const [selected, setSelected] = useState<RuntimeLogLine>()
	useEffect(() => setSelected(undefined), [meta?.bootId, meta?.epoch])
	const [showName, setShowName] = useState(!owner)
	const [showCategory, setShowCategory] = useState(false)
	const [ansi, setAnsi] = useState(true)
	const changeFollow = (value: boolean) => {
		setFollow(value)
		setPausedVersion(version)
	}
	const apply = (next: LogsSearch) => navigation.navigate(buildLogsHref(next))
	return (
		<Stack gap={0} h="100%" style={{ minHeight: 0, minWidth: 0 }}>
			<Group gap="xs" p="xs" wrap="wrap" style={{ borderBottom: '1px solid var(--plx-border)' }}>
				<Text size="sm" fw={600} title={search.plugin} truncate style={{ maxWidth: '100%' }}>
					{label}
				</Text>
				{owner && <LogPolicyPopover owner={owner} />}
				<Text size="xs" c={error ? 'red' : 'dimmed'} role="status">
					{status === 'loading'
						? '正在读取…'
						: status === 'error'
							? '读取失败'
							: follow
								? '实时跟随'
								: '已暂停跟随'}{' '}
					· {store.length.toLocaleString()} 条
				</Text>
				<Group gap="xs" wrap="wrap" ml="auto">
					<Button
						size="compact-xs"
						variant={follow ? 'default' : 'light'}
						onClick={() => changeFollow(!follow)}
					>
						{follow ? '暂停跟随' : version !== pausedVersion ? '回到最新 · 有新日志' : '回到最新'}
					</Button>
					<LogFilters search={search} onApply={apply} />
					<Menu closeOnItemClick={false} position="bottom-end">
						<Menu.Target>
							<Button size="compact-xs" variant="default">
								显示
							</Button>
						</Menu.Target>
						<Menu.Dropdown>
							{[
								{ label: '显示名称', value: showName, set: setShowName },
								{ label: '显示分类', value: showCategory, set: setShowCategory },
								{ label: 'ANSI 颜色', value: ansi, set: setAnsi },
							].map((option) => (
								<Menu.Item
									key={option.label}
									onClick={() => option.set(!option.value)}
									leftSection={<Checkbox.Indicator checked={option.value} />}
								>
									{option.label}
								</Menu.Item>
							))}
						</Menu.Dropdown>
					</Menu>
					<Button
						size="compact-xs"
						variant="subtle"
						onClick={() => {
							clear()
							setSelected(undefined)
							setPausedVersion(store.getVersion())
						}}
					>
						清空显示
					</Button>
				</Group>
			</Group>
			{(owner || search.stream || search.context || search.category || search.displayName) && (
				<Group
					gap="xs"
					px="xs"
					py={4}
					wrap="wrap"
					style={{ borderBottom: '1px solid var(--plx-border)' }}
				>
					{owner && (
						<Button
							size="compact-xs"
							variant="subtle"
							onClick={() => apply({ ...search, plugin: undefined })}
						>
							清除插件筛选
						</Button>
					)}
					{search.stream && (
						<Text size="xs" c="dimmed">
							日志流：{search.stream}
						</Text>
					)}
					{search.displayName && (
						<Text size="xs" c="dimmed">
							名称：{search.displayName}
						</Text>
					)}
					{search.context && (
						<Text size="xs" c="dimmed">
							上下文：{search.context}
						</Text>
					)}
					{search.category && (
						<Text size="xs" c="dimmed">
							分类：{search.category}
						</Text>
					)}
				</Group>
			)}
			{error && (
				<Group p="xs">
					<Text size="sm" c="red" role="alert" style={{ overflowWrap: 'anywhere', minWidth: 0 }}>
						{error}
					</Text>
					<Button size="compact-xs" variant="default" onClick={retry}>
						重试
					</Button>
				</Group>
			)}
			<LogList
				store={store}
				selected={selected}
				onSelect={(line) =>
					setSelected((current) =>
						current?.streamId === line.streamId &&
						current?.epoch === line.epoch &&
						current?.seq === line.seq
							? undefined
							: line,
					)
				}
				follow={follow}
				onFollowChange={changeFollow}
				showName={showName}
				showCategory={showCategory}
				ansi={ansi}
			/>
			{selected && (
				<Box
					p="sm"
					style={{
						flex: '0 1 auto',
						minHeight: 0,
						maxHeight: '45%',
						overflow: 'auto',
						borderTop: '1px solid var(--plx-border)',
						background: 'var(--mantine-color-body)',
					}}
				>
					<LogDetails
						line={selected}
						onClose={() => setSelected(undefined)}
						showName={showName}
						showCategory={showCategory}
					/>
				</Box>
			)}
		</Stack>
	)
}
