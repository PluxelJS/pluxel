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
import { type GroupConfig, PluginOrganizer } from '@pluxel/components'
import { IconSearch, IconX } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import type React from 'react'
import { useMemo, useState } from 'react'
import { client } from '../rpc'
import { WouterLinkAdapter } from '../WouterLinkAdapter'

interface PluginListProps {
	pluginName?: string
	onItemSelect?: () => void
}

export const PluginList: React.FC<PluginListProps> = ({ pluginName, onItemSelect }) => {
	const [q, setQ] = useState('')

	const statusesQ = useQuery({
		queryKey: ['plugins'] as const,
		queryFn: async () => {
			const res = await client.plugins.$get()
			if (!res.ok) throw new Error(`拉取插件列表失败: ${res.status}`)
			return res.json()
		},
		staleTime: 60_000,
		refetchOnMount: false,
		refetchOnWindowFocus: false,
	})

	const groupsQ = useQuery<GroupConfig[], Error>({
		queryKey: ['plugins', 'groups'] as const,
		queryFn: async () => {
			const res = await client.plugins.groups.$get({ json: [] })
			if (!res.ok) throw new Error(`拉取分组配置失败: ${res.status}`)
			return res.json()
		},
		staleTime: 60_000,
		refetchOnMount: false,
		refetchOnWindowFocus: false,
	})

	const loading = statusesQ.isPending || groupsQ.isPending
	const errored = statusesQ.isError || groupsQ.isError

	const handleChange = async (next: GroupConfig[]) => {
		try {
			const res = await client.plugins.groups.$post({ json: next })
			if (!res.ok) {
				const text = await res.text()
				throw new Error(text || `同步分组失败: ${res.status}`)
			}
		} catch (error: any) {
			showNotification({
				title: '同步失败',
				message: error?.message || '分组同步出错',
				color: 'red',
			})
		}
	}

	const total = statusesQ.data?.summary.total
	const totalRunnings = statusesQ.data?.summary.running

	// 清除按钮
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
				{!loading && !errored && (
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

			{loading ? (
				<>
					<Skeleton height={16} />
					<Skeleton height={16} width="85%" />
					<Skeleton height={16} width="70%" />
					<Skeleton height={120} />
				</>
			) : errored ? (
				<Text c="red">加载失败，请稍后重试</Text>
			) : statusesQ.isSuccess && groupsQ.isSuccess ? (
				<PluginOrganizer
					statuses={statusesQ.data.statuses}
					initialGroups={groupsQ.data}
					activeId={pluginName}
					onGroupsChange={handleChange}
					filterQuery={q}
					LinkComponent={WouterLinkAdapter}
				/>
			) : null}
		</Stack>
	)
}
