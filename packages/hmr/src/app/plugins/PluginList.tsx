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
import { type GroupConfig, type PluginStatuses, PluginOrganizer } from '@pluxel/components'
import { IconSearch, IconX } from '@tabler/icons-react'
import { useCallback, useMemo, useState } from 'react'
import {
	useMutation as useGqtyMutation,
	useQuery as useGqtyQuery,
} from '../gqty'
import type { PluginGroup, PluginStatusEntry } from '../gqty'
import { WouterLinkAdapter } from '../WouterLinkAdapter'

interface PluginListProps {
	pluginName?: string
	onItemSelect?: () => void
}

const toStatusesMap = (entries: PluginStatusEntry[] | undefined): PluginStatuses => {
	if (!entries?.length) return {}
	return Object.fromEntries(
		entries
			.filter((item): item is PluginStatusEntry => Boolean(item?.name))
			.map((item) => {
				const id = item.name as string
				return [id, { id, name: item.name ?? id, isRunning: Boolean(item.isRunning) }]
			}),
	)
}

const toGroupConfigs = (groups: PluginGroup[] | undefined): GroupConfig[] =>
	(groups ?? [])
		.filter((group): group is PluginGroup => Boolean(group?.groupId))
		.map((group) => ({
			groupId: group.groupId as string,
			name: group.name ?? '',
			pluginIds: [...(group.pluginIds ?? [])],
		}))

export const PluginList: React.FC<PluginListProps> = ({ pluginName }) => {
	const [q, setQ] = useState('')
	const query = useGqtyQuery({ suspense: false })

	const pluginStatus = query.pluginStatus
	const pluginGroups = query.pluginGroups

	const statuses = useMemo(
		() => toStatusesMap(pluginStatus?.statuses as PluginStatusEntry[] | undefined),
		[pluginStatus?.statuses],
	)
	const groups = useMemo(
		() => toGroupConfigs(pluginGroups as PluginGroup[] | undefined),
		[pluginGroups],
	)

	const total = pluginStatus?.summary?.total ?? 0
	const totalRunnings = pluginStatus?.summary?.running ?? 0

	const { isLoading, error } = query.$state
	const isInitialLoading = isLoading && !Object.keys(statuses).length && groups.length === 0

	const [mutateGroups] = useGqtyMutation(
		(mutation, args: { groups: GroupConfig[] }) => {
			const updated = mutation.updatePluginGroups({
				groups: args.groups.map((group) => ({
					groupId: group.groupId,
					name: group.name,
					pluginIds: [...group.pluginIds],
				})),
			})
			updated?.forEach((group) => {
				group?.groupId
				group?.name
				group?.pluginIds?.length
			})
			return updated
		},
		{ suspense: false },
	)

	const handleChange = useCallback(
		async (next: GroupConfig[]) => {
			try {
				await mutateGroups({ args: { groups: next } })
			} catch (err: any) {
				showNotification({
					title: '同步失败',
					message: err?.message || '分组同步出错',
					color: 'red',
				})
			}
		},
		[mutateGroups],
	)

	const clearBtn = useMemo(
		() =>
			q ? (
				<ActionIcon size="sm" variant="subtle" onClick={() => setQ('')}>
					<IconX size={14} />
				</ActionIcon>
			) : undefined,
		[q],
	)

	return (
		<Stack gap="sm">
			<Group justify="space-between" align="center">
				<Title order={6} fw={600} c="dimmed">
					浏览与分组
				</Title>
				{!isInitialLoading && !error && (
					<Group gap="xs">
						<Badge variant="light" size="sm" suppressHydrationWarning>
							共 {total}
						</Badge>
						<Badge variant="light" size="sm" color="green" suppressHydrationWarning>
							运行中 {totalRunnings}
						</Badge>
					</Group>
				)}
			</Group>

			<TextInput
				placeholder="搜索插件（名称 / ID）"
				value={q}
				onChange={(e) => setQ(e.currentTarget.value)}
				leftSection={<IconSearch size={14} />}
				rightSection={clearBtn}
				size="xs"
			/>

			<Divider />

			{isInitialLoading ? (
				<>
					<Skeleton height={16} />
					<Skeleton height={16} width="85%" />
					<Skeleton height={16} width="70%" />
					<Skeleton height={120} />
				</>
			) : error ? (
				<Text c="red">{error.message || '加载失败，请稍后重试'}</Text>
			) : (
				<PluginOrganizer
					statuses={statuses}
					initialGroups={groups}
					activeId={pluginName}
					onGroupsChange={handleChange}
					filterQuery={q}
					LinkComponent={WouterLinkAdapter}
				/>
			)}
		</Stack>
	)
}
