import type React from 'react'
import {
	Stack,
	Text,
	Skeleton,
	Title,
	Divider,
	Group,
	Badge,
	TextInput,
	ActionIcon,
} from '@mantine/core'
import { IconSearch, IconX } from '@tabler/icons-react'
import { Link } from 'wouter'
import { useQuery } from '@tanstack/react-query'
import { showNotification } from '@mantine/notifications'
import { useState, useMemo } from 'react'
import { client } from '../rpc'
import {
	PluginOrganizer,
	type GroupConfig,
	type PluginStatus,
} from '@pluxel/components'

interface PluginListProps {
	onItemSelect?: () => void
}

export const PluginList: React.FC<PluginListProps> = ({ onItemSelect }) => {
	const [q, setQ] = useState('')

	const statusesQ = useQuery<PluginStatus[], Error>({
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

	const total = statusesQ.data?.length ?? 0
	const running =
		statusesQ.data?.reduce((n, s) => n + (s.isRunning ? 1 : 0), 0) ?? 0

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
						<Badge variant="light" size="sm">
							共 {total}
						</Badge>
						<Badge variant="light" size="sm" color="green">
							运行中 {running}
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
					statuses={statusesQ.data}
					initialGroups={groupsQ.data}
					onGroupsChange={handleChange}
					filterQuery={q}
					LinkComponent={(props) => <Link {...props} onClick={onItemSelect} />}
				/>
			) : null}
		</Stack>
	)
}
