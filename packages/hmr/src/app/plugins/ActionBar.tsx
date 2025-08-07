import { ActionIcon, Tooltip, Group } from '@mantine/core'
import {
	IconPlayerPlay,
	IconSquareX,
	IconRotateClockwise,
} from '@tabler/icons-react'
import { client } from '../rpc'
import type { InferRequestType, InferResponseType } from 'hono/client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { notifications } from '@mantine/notifications'

export interface ActionBarProps {
	pluginName: string
	isRunning: boolean
}

export function ActionBar({ pluginName, isRunning }: ActionBarProps) {
	// 从 RPC 客户端取出 patch 方法
	const $patch = client.plugins.$patch

	// 自动推断请求体 & 返回类型
	type Payload = InferRequestType<typeof $patch>['json']
	type Response = InferResponseType<typeof $patch>

	const mutation = useMutation<Response, Error, Payload>({
		mutationFn: async (body) => {
			const res = await $patch({ json: body })
			if (!res.ok) {
				const err = await res.json()

				throw new Error(`${err.code}: ${err.error}`)
			}
			const data = await res.json()
			notifications.show({
				title: '更改插件状态成功。',
				message: data.changes.join('\n'),
			})
			return data
		},
	})

	const handleAction = (status: Payload['status']) => {
		mutation.mutate({ pluginName: pluginName, status })
	}

	const isEnableable = !mutation.isPending && isRunning

	return (
		<Group gap="xs" align="right">
			<Tooltip label="启动">
				<ActionIcon
					variant="light"
					size="lg"
					onClick={() => handleAction('start')}
					disabled={isEnableable}
				>
					<IconPlayerPlay size={18} />
				</ActionIcon>
			</Tooltip>

			<Tooltip label="终止">
				<ActionIcon
					variant="light"
					size="lg"
					color="red"
					onClick={() => handleAction('stop')}
					disabled={!isEnableable}
				>
					<IconSquareX size={18} />
				</ActionIcon>
			</Tooltip>

			<Tooltip label="重启">
				<ActionIcon
					variant="light"
					size="lg"
					color="green"
					onClick={() => handleAction('restart')}
					disabled={!isEnableable}
				>
					<IconRotateClockwise size={18} />
				</ActionIcon>
			</Tooltip>
		</Group>
	)
}
