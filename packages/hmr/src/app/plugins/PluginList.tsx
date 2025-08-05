import type React from 'react'
import { Box, ScrollArea, Text } from '@mantine/core'
import { Link } from 'wouter'
import { useQuery } from '@tanstack/react-query'
import { showNotification } from '@mantine/notifications'
import { client } from '../rpc'
import {
	PluginOrganizer,
	type GroupConfig,
	type PluginStatus,
} from '@pluxel/components'

export const PluginList: React.FC = () => {
	// 插件运行状态
	const {
		data: statuses = [],
		isLoading: loadingStatuses,
		isError: errorStatuses,
	} = useQuery({
		queryKey: ['plugins'] as const,
		queryFn: async (): Promise<PluginStatus[]> => {
			const res = await client.plugins.$get()
			if (!res.ok) throw new Error(`拉取插件列表失败: ${res.status}`)
			return res.json()
		},
		staleTime: 60_000,
		refetchOnMount: false,
	})

	// 分组配置
	const {
		data: groups = [],
		isLoading: loadingGroups,
		isError: errorGroups,
	} = useQuery({
		queryKey: ['plugins', 'groups'] as const,
		queryFn: async (): Promise<GroupConfig[]> => {
			const res = await client.plugins.groups.$get({ json: [] })
			if (!res.ok) throw new Error(`拉取分组配置失败: ${res.status}`)
			return res.json()
		},
		staleTime: 60_000,
		refetchOnMount: false,
	})

	// 同步分组到后端
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
				message: error.message || '分组同步出错',
				color: 'red',
			})
		}
	}

	if (loadingStatuses || loadingGroups) {
		return <Text>加载中…</Text>
	}
	if (errorStatuses || errorGroups) {
		return <Text color="red">加载失败，请刷新页面</Text>
	}

	return (
		<Box style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
			<ScrollArea style={{ flex: 1 }}>
				<PluginOrganizer
					statuses={statuses}
					initialGroups={groups}
					onGroupsChange={handleChange}
					LinkComponent={Link}
				/>
			</ScrollArea>
		</Box>
	)
}
