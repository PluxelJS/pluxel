// src/plugins/PluginsLayout.tsx
import type React from 'react'
import { useMemo } from 'react'
import { Flex, Center, Text } from '@mantine/core'
import { useRoute } from 'wouter'
import { PluginList } from './PluginList'
import { Plugin } from './Plugin'

export const PluginsLayout: React.FC = () => {
	const [match, params] = useRoute<{ name?: string }>('/plugins/:name')
	const pluginName = match ? params.name : undefined

	// 只有 pluginName 变了才重建详情组件
	const pluginPane = useMemo(() => {
		if (!pluginName) {
			return (
				<Center style={{ flex: 1 }}>
					<Text color="dimmed" size="lg">
						请选择一个插件以查看详情
					</Text>
				</Center>
			)
		}
		return <Plugin pluginName={pluginName} />
	}, [pluginName])

	return (
		<Flex h="100%" gap="md" direction="row">
			<PluginList />
			{pluginPane}
		</Flex>
	)
}
