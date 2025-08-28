// src/queryClient.ts

import { notifications } from '@mantine/notifications'
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient({
	// 拦截所有 useQuery 抛出的错误
	queryCache: new QueryCache({
		onError: (error, query) => {
			const msg = error instanceof Error ? error.message : '数据加载失败，请稍后重试'
			notifications.show({
				title: '加载失败',
				message: msg,
				color: 'red',
			})
		},
	}),
	// 拦截所有 useMutation 抛出的错误
	mutationCache: new MutationCache({
		onError: (error, mutation) => {
			const msg = error instanceof Error ? error.message : '操作失败，请稍后重试'
			notifications.show({
				title: '请求出错',
				message: msg,
				color: 'red',
			})
		},
	}),
})
