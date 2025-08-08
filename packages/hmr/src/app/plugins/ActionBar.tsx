import React from 'react'
import { ActionIcon, Tooltip, Group } from '@mantine/core'
import {
	IconPlayerPlay,
	IconSquareX,
	IconRotateClockwise,
} from '@tabler/icons-react'
import { client } from '../rpc'
import type { InferRequestType, InferResponseType } from 'hono/client'
import { useMutation, useQuery } from '@tanstack/react-query'
import { notifications } from '@mantine/notifications'
import { openConfirmModal } from '@mantine/modals'
import type { PluginResponse } from './Plugin'
import type { Dependency } from './DependencyList'

export interface ActionBarProps {
	pluginName: string
	isRunning: boolean
	/** 前置依赖列表及其运行状态与可选标记 */
	dependencies?: Dependency[]
}

export function ActionBar({
	pluginName,
	isRunning,
	dependencies = [],
}: ActionBarProps) {
	// RPC 更新方法
	const $patch = client.plugins.$patch

	// 请求体 & 响应类型
	type Payload = InferRequestType<typeof $patch>['json']
	type Response = InferResponseType<typeof $patch>

	// Mutation
	const mutation = useMutation<Response, Error, Payload>({
		mutationFn: async (body) => {
			const res = await $patch({ json: body })
			if (!res.ok) {
				const err = await res.json()
				throw new Error(`${err.code}: ${err.error}`)
			}
			const data = await res.json()
			notifications.show({
				title: '插件状态已更新',
				message: data.changes.join('\n'),
			})
			return data
		},
	})

	// 处理动作，带依赖确认
	const handleAction = (status: Payload['status']) => {
		const missing = dependencies
			.filter((dep) => !dep?.isRunning && !dep?.optional)
			.map((i) => i?.name)
		const proceed = () => mutation.mutate({ pluginName, status })

		if (missing.length > 0) {
			openConfirmModal({
				title: '前置依赖未启动',
				children: (
					<div>
						请确认是否强制
						{status === 'start' ? '启动' : status === 'stop' ? '终止' : '重启'}
						。
						<div style={{ marginTop: 10 }}>
							以下依赖尚未运行：{missing.join('，')}
						</div>
					</div>
				),
				labels: { confirm: '继续', cancel: '取消' },
				onConfirm: proceed,
			})
		} else {
			proceed()
		}
	}

	const canToggle = !mutation.isPending

	return (
		<Group gap="xs" align="right">
			<Tooltip label="启动">
				<ActionIcon
					variant="light"
					size="lg"
					onClick={() => handleAction('start')}
					disabled={!canToggle || isRunning}
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
					disabled={!canToggle || !isRunning}
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
					disabled={!canToggle || !isRunning}
				>
					<IconRotateClockwise size={18} />
				</ActionIcon>
			</Tooltip>
		</Group>
	)
}
