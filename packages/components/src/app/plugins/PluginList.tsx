import {
	ActionIcon,
	Badge,
	Divider,
	Group,
	Skeleton,
	Stack,
	Text,
	TextInput,
	Title,
} from '@mantine/core'
import { showNotification } from '@mantine/notifications'
import { IconSearch, IconX } from '@tabler/icons-react'
import { useCallback, useMemo, useState } from 'react'
import { type GroupConfig, PluginOrganizer, type PluginStatuses } from '~/components'
import {
	type PluginGroup,
	type PluginStatusEntry,
	useMutation as useGqtyMutation,
	useQuery,
} from '../gqty'
import { WouterLinkAdapter } from '../WouterLinkAdapter'

interface PluginListProps {
	pluginName?: string
	onItemSelect?: () => void
}

type OverviewSnapshot = {
	statuses: PluginStatuses
	groups: GroupConfig[]
	total: number
	running: number
}

const EMPTY_OVERVIEW: OverviewSnapshot = Object.freeze({
	statuses: Object.freeze({}) as PluginStatuses,
	groups: Object.freeze([]) as GroupConfig[],
	total: 0,
	running: 0,
})

const toStatuses = (entries: Array<PluginStatusEntry | null | undefined> | undefined) => {
	if (!entries?.length) return EMPTY_OVERVIEW.statuses

	const snapshot: PluginStatuses = Object.create(null)
	for (const entry of entries) {
		const name = entry?.name
		if (!name) continue
		snapshot[name] = Object.freeze({
			id: name,
			name,
			isRunning: Boolean(entry?.isRunning),
		})
	}
	return Object.freeze(snapshot) as PluginStatuses
}

const toGroups = (groups: Array<PluginGroup | null | undefined> | undefined) => {
	if (!groups?.length) return EMPTY_OVERVIEW.groups

	return Object.freeze(
		groups.map((group) => ({
			groupId: group?.groupId ?? '',
			name: group?.name ?? '',
			pluginIds: Object.freeze([...(group?.pluginIds ?? [])]) as string[],
		})),
	)
}

const buildOverview = (args: {
	statuses: Array<PluginStatusEntry | null | undefined> | undefined
	groups: Array<PluginGroup | null | undefined> | undefined
	summary?: { total?: number | null; running?: number | null } | null
}) => {
	const { statuses, groups, summary } = args
	const summaryStatuses = toStatuses(statuses)
	let computedRunning = 0
	for (const entry of Object.values(summaryStatuses)) if (entry?.isRunning) computedRunning += 1

	const total =
		typeof summary?.total === 'number' ? summary.total : Object.keys(summaryStatuses).length
	const running = typeof summary?.running === 'number' ? summary.running : computedRunning

	return Object.freeze({
		statuses: summaryStatuses,
		groups: toGroups(groups),
		total,
		running,
	}) satisfies OverviewSnapshot
}

export const PluginList: React.FC<PluginListProps> = ({ pluginName }) => {
	const [search, setSearch] = useState('')

	const query = useQuery({
		suspense: false,
		operationName: 'PluginOverview',
		notifyOnNetworkStatusChange: true,
		refetchOnReconnect: false,
		refetchOnWindowVisible: false,
		fetchInBackground: true,
	})

	const overview = useMemo(() => {
		try {
			return buildOverview({
				statuses: query.pluginStatus?.statuses,
				groups: query.pluginGroups,
				summary: query.pluginStatus?.summary,
			})
		} catch (error) {
			console.error('[PluginList] Failed to build overview snapshot', error)
			return EMPTY_OVERVIEW
		}
	}, [query.pluginGroups, query.pluginStatus?.statuses, query.pluginStatus?.summary])

	const [mutateGroups] = useGqtyMutation(
		(mutation, variables: { args: { groups: GroupConfig[] } }) => {
			const { groups } = variables.args
			const result = mutation.updatePluginGroups({
				groups: groups.map((group) => ({
					groupId: group.groupId,
					name: group.name,
					pluginIds: [...group.pluginIds],
				})),
			})
			result?.length
			return result
		},
		{ suspense: false },
	)

	const handleGroupsChange = useCallback(
		async (next: GroupConfig[]) => {
			try {
				await mutateGroups({ args: { groups: next } })
				await query.$refetch(true)
			} catch (error: any) {
				showNotification({
					title: '同步失败',
					message: error?.message || '分组同步出错',
					color: 'red',
				})
			}
		},
		[mutateGroups, query],
	)

	const clearBtn = useMemo(
		() =>
			search ? (
				<ActionIcon size="sm" variant="subtle" onClick={() => setSearch('')}>
					<IconX size={14} />
				</ActionIcon>
			) : undefined,
		[search],
	)

	const loading = query.$state.isLoading
	const errorMessage = query.$state.error?.message

	return (
		<Stack gap="sm">
			<Group justify="space-between" align="center">
				<Title order={6} fw={600} c="dimmed">
					浏览与分组
				</Title>
				{!loading && !errorMessage && (
					<Group gap="xs">
						<Badge variant="light" size="sm" suppressHydrationWarning>
							共 {overview.total}
						</Badge>
						<Badge variant="light" size="sm" color="green" suppressHydrationWarning>
							运行中 {overview.running}
						</Badge>
					</Group>
				)}
			</Group>

			<TextInput
				placeholder="搜索插件（名称 / ID）"
				value={search}
				onChange={(e) => setSearch(e.currentTarget.value)}
				leftSection={<IconSearch size={14} />}
				rightSection={clearBtn}
				size="xs"
			/>

			<Divider />

			{loading ? (
				<>
					<Skeleton height={16} />
					<Skeleton height={16} width="85%" />
					<Skeleton height={16} width="70%" />
					<Skeleton height={120} />
				</>
			) : errorMessage ? (
				<Text c="red">{errorMessage}</Text>
			) : overview.total > 0 ? (
				<PluginOrganizer
					statuses={overview.statuses}
					initialGroups={overview.groups as any}
					activeId={pluginName}
					onGroupsChange={handleGroupsChange}
					filterQuery={search}
					LinkComponent={WouterLinkAdapter}
				/>
			) : (
				<Text c="dimmed">暂无插件</Text>
			)}
		</Stack>
	)
}
