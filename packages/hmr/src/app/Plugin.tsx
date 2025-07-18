import { Card, Text } from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
// app/plugin.tsx
import React from 'react'
import { useParams } from 'wouter'
import { client } from '../rpc'

export const Plugin = () => {
	const { name } = useParams<{ name: string }>()
	const { data, isLoading, isError } = useQuery(
		['plugins', name],
		async () => {
			const res = await client.plugins[':name'].$get({ param: { name } })
			if (res.ok) return await res.json()
			throw new Error('not found')
		},
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
			<Card></Card>
		</>
	)
}
