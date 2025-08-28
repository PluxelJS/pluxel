import { ActionIcon, Group, Tooltip } from '@mantine/core'
import { openConfirmModal } from '@mantine/modals'
import { notifications } from '@mantine/notifications'
import { IconPlayerPlay, IconRotateClockwise, IconSquareX } from '@tabler/icons-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import React from 'react'
import type { InferRequestType, InferSuccessResponse } from '../rpc'
import { client } from '../rpc'
import type { Dependencies } from './Plugin'
export interface ActionBarProps {
	pluginName: string
	isSelfRunning: boolean
	/** 前置依赖列表及其运行状态与可选标记 */
	dependencies?: Dependencies
}

export function ActionBar({ pluginName, isSelfRunning, dependencies = [] }: ActionBarProps) {
	// RPC 更新方法
	const $post = client.plugins[':name'].status.$post

	// 请求体 & 响应类型
	type Payload = InferRequestType<typeof $post>['json']
	type Response = InferSuccessResponse<typeof $post>

	// Mutation
	const qc = useQueryClient()
	const mutation = useMutation<Response, Error, Payload>({
		mutationFn: async (body) => {
			const res = await $post({ param: { name: pluginName }, json: body })
			if (!res.ok) {
				const err = await res.json()
				throw new Error(`${err.code}: ${err.error}`)
			}
			const data = await res.json()
			notifications.show({
				title: '插件状态已更新',
				message: '更新成功',
			})
			return data
		},

		onSuccess: (r) => {
			qc.setQueryData(['plugin', pluginName, 'status'], (old: any) => ({
				...old,
				isRunning: r.isRunning,
			}))
		},
	})

	// 处理动作，带依赖确认
	const handleAction = (status: Payload['status']) => {
		const missing = dependencies
			.filter((dep) => !dep?.isRunning && !dep?.optional)
			.map((i) => i?.name)
		const proceed = () => mutation.mutate({ status })

		if (missing.length > 0) {
			openConfirmModal({
				title: '前置依赖未启动',
				children: (
					<div>
						请确认是否强制
						{status === 'start' ? '启动' : status === 'stop' ? '终止' : '重启'}。
						<div style={{ marginTop: 10 }}>以下依赖尚未运行：{missing.join('，')}</div>
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
					disabled={!canToggle || isSelfRunning}
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
					disabled={!canToggle || !isSelfRunning}
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
					disabled={!canToggle || !isSelfRunning}
				>
					<IconRotateClockwise size={18} />
				</ActionIcon>
			</Tooltip>
		</Group>
	)
}
