// src/plugins/Plugin.tsx
import React from 'react'
import {
	Container,
	Grid,
	Card,
	Text,
	Center,
	LoadingOverlay,
} from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
import { client } from '../rpc'
import { ConfigForm } from './ConfigForm'
import { ActionBar } from './ActionBar'

export interface PluginDetail {
	name: string
	desc?: string
	isRunning: boolean
	config?: Record<string, any>
}

interface PluginProps {
	pluginName: string
}

const PluginDetailComponent: React.FC<PluginProps> = ({ pluginName }) => {
	// Plugin.tsx

	const { data, isLoading, isError, error } = useQuery({
		queryKey: ['plugin', pluginName] as const,
		queryFn: async (): Promise<PluginDetail> => {
			const res = await client.plugins[':name'].$get({
				param: { name: pluginName },
			})
			if (!res.ok) throw new Error(`插件「${pluginName}」不存在`)
			return res.json()
		},
		staleTime: 60_000,
		refetchOnMount: false,
	})

	if (!pluginName) {
		return (
			<Center style={{ height: '100%' }}>
				<Text color="dimmed" size="lg">
					请选择一个插件以查看详情
				</Text>
			</Center>
		)
	}

	return (
		<Container
			size="lg"
			style={{
				position: 'relative',
				height: '100%',
				display: 'flex',
				flexDirection: 'column',
			}}
		>
			<LoadingOverlay visible={isLoading} />

			{isError && !isLoading && (
				<Center style={{ flex: 1 }}>
					<Text color="red">
						{(error as Error)?.message ?? '加载失败，请重试'}
					</Text>
				</Center>
			)}

			{data && !isLoading && !isError && (
				<Grid mt="md">
					<Grid.Col span={4}>
						<Card shadow="sm" p="md" withBorder>
							<ActionBar pluginName={data.name} isRunning={data.isRunning} />
							<Text size="xl" w={500} mt="sm">
								插件：{data.name}
							</Text>
							{data.desc && (
								<Text mt="sm" color="dimmed">
									{data.desc}
								</Text>
							)}
						</Card>
					</Grid.Col>

					<Grid.Col span={8}>
						{data.config ? (
							<Card shadow="sm" p="md" withBorder>
								<ConfigForm pluginName={data.name} configs={data.config} />
							</Card>
						) : (
							<Center style={{ height: '100%' }}>
								<Text color="dimmed">该插件暂无可配置项</Text>
							</Center>
						)}
					</Grid.Col>
				</Grid>
			)}
		</Container>
	)
}

// 只有 pluginName 变了才重新渲染
export const Plugin = React.memo(
	PluginDetailComponent,
	(prev, next) => prev.pluginName === next.pluginName,
)
