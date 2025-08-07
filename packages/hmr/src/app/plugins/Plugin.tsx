// src/plugins/Plugin.tsx
import React from 'react'
import {
	Flex,
	Card,
	CardSection,
	Text,
	Center,
	LoadingOverlay,
} from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
import { client } from '../rpc'
import { ConfigForm } from './ConfigForm'
import { ActionBar } from './ActionBar'
import { showNotification } from '@mantine/notifications'
import { LiveLog } from '../LogViewer'

interface PluginProps {
	pluginName: string
}

const PluginDetailComponent: React.FC<PluginProps> = ({ pluginName }) => {
	const { data, isLoading, isError, error } = useQuery({
		queryKey: ['plugin', pluginName] as const,
		queryFn: async () => {
			const res = await client.plugins[':name'].$get({
				param: { name: pluginName },
			})
			if (!res.ok) {
				throw new Error(`插件「${pluginName}」不存在`)
			}
			return res.json()
		},
		staleTime: 60_000,
		refetchOnMount: false,
	})

	if (!pluginName) {
		return (
			<Center h="100%">
				<Text color="dimmed" size="lg">
					请选择一个插件以查看详情
				</Text>
			</Center>
		)
	}

	if (isError && !isLoading) {
		return (
			<Center h="100%">
				<Text color="red">
					{(error as Error).message || '加载失败，请重试'}
				</Text>
			</Center>
		)
	}

	return (
		<Flex h="100vh" gap="md">
			{/* 左侧：固定 600px，竖直排列 */}
			<Flex direction="column" style={{ width: 600 }} h="100%">
				<Card
					shadow="sm"
					withBorder
					style={{ flex: 1, display: 'flex', flexDirection: 'column' }}
				>
					<CardSection withBorder px="md" py="sm">
						<ActionBar pluginName={data?.name!} isRunning={data?.isRunning!} />
						<Text size="xl" mt="sm">
							插件：{data?.name}
						</Text>
						{data?.desc && (
							<Text color="dimmed" mt="xs">
								{data.desc}
							</Text>
						)}
					</CardSection>

					<CardSection style={{ flex: 1, overflow: 'auto' }} px="md" py="sm">
						<LiveLog />
					</CardSection>
				</Card>
			</Flex>

			{/* 右侧：剩余空间 */}
			<Flex direction="column" style={{ flex: 1, minWidth: 600 }} h="100%">
				{data?.config ? (
					<Card
						shadow="sm"
						withBorder
						style={{ flex: 1, display: 'flex', flexDirection: 'column' }}
					>
						<CardSection style={{ flex: 1, overflow: 'auto' }} px="md" py="sm">
							<ConfigForm
								pluginName={data.name}
								configs={data.config}
								existConfigs={data.existConfig}
							/>
						</CardSection>
					</Card>
				) : (
					<Center h="100%">
						<Text color="dimmed">该插件暂无可配置项</Text>
					</Center>
				)}
			</Flex>

			<LoadingOverlay visible={isLoading} overlayProps={{ zIndex: 1000 }} />
		</Flex>
	)
}

export const Plugin = React.memo(
	PluginDetailComponent,
	(prev, next) => prev.pluginName === next.pluginName,
)
