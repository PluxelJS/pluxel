import { Text } from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
// app/plugin.tsx
import React from 'react'
import { useParams } from 'wouter'

// 与 server.ts 中的 fetchPluginData 保持一致
async function fetchPluginData(name: string) {
	return { name, desc: `这是插件 ${name} 的服务端描述` }
}

export const Plugin = () => {
	const { name } = useParams<{ name: string }>()
	const { data, isLoading, isError } = useQuery(
		['plugin', name],
		() => fetchPluginData(name!),
		{
			// Hydration 后不再自动 refetch
			staleTime: 1000 * 60,
			refetchOnMount: false,
		},
	)

	if (isLoading) return <Text>加载中…</Text>
	if (isError || !data) return <Text color="red">加载失败</Text>

	return (
		<>
			<Text size="xl">插件：{data.name}</Text>
			<Text mt="md">{data.desc}</Text>
		</>
	)
}
