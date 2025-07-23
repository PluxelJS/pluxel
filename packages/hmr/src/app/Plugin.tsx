// src/plugin.tsx
import React from 'react'
import { Card, Text } from '@mantine/core'
import { useParams } from 'wouter'
import { useQuery } from '@tanstack/react-query'
import { client } from '../rpc'
import { ConfigForm } from './ConfigForm'

export const Plugin = () => {
  const { name } = useParams<{ name: string }>()

  const { data, isLoading, isError } = useQuery({
    queryKey: ['plugins', name],
    enabled: Boolean(name),
    staleTime: 60_000,          // 1 分钟内认为新鲜
    refetchOnMount: false,      // hydration 后不再 refetch
    queryFn: async () => {
      const res = await client.plugins[':name'].$get({
        param: { name },
      })
      if (!res.ok) {
        throw new Error(`插件「${name}」不存在`)
      }
      return res.json()
    },
  })

  if (isLoading) {
    return <Text>加载中…</Text>
  }
  if (isError || !data) {
    return <Text color="red">加载失败</Text>
  }

  return (
    <>
      {/* 标题与描述 */}
      <Text size="xl">插件：{data.name}</Text>
      <Text mt="md">{data.desc}</Text>

      {/* 配置表单 */}
      <Card mt="md">
		<ConfigForm pluginName={data.name} configs={data.config} />
      </Card>
    </>
  )
}
