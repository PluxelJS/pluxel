import { ActionIcon, Group, Tooltip } from '@mantine/core'
import { openConfirmModal } from '@mantine/modals'
import { notifications } from '@mantine/notifications'
import { IconPlayerPlay, IconRotateClockwise, IconSquareX } from '@tabler/icons-react'
import { useCallback } from 'react'
import { UpdatePluginStatusStatusInput, useMutation as useGqtyMutation } from '../../../gqty'
import { usePluginScope } from '../context'

export interface ActionBarProps {
	onStatusUpdated?: () => Promise<void> | void
}

const ACTION_LABEL: Record<UpdatePluginStatusStatusInput, string> = {
	start: '启动',
	stop: '终止',
	restart: '重启',
}

export function ActionBar({ onStatusUpdated }: ActionBarProps) {
	const { pluginName, dependencies, isRunning, refetch } = usePluginScope()

	const handleStatusUpdated = useCallback(async () => {
		await refetch()
		await onStatusUpdated?.()
	}, [onStatusUpdated, refetch])

	const [mutateStatus, mutationState] = useGqtyMutation(
		(mutation, variables: { args: { plugin: string; status: UpdatePluginStatusStatusInput } }) => {
			const { plugin, status } = variables.args
			const result = mutation.updatePluginStatus({
				name: plugin,
				status,
			})
			result.code
			result.error
			result.isRunning
			return result
		},
		{ suspense: false },
	)

	const performAction = async (status: UpdatePluginStatusStatusInput) => {
		if (!pluginName) return
		try {
			const result = await mutateStatus({ args: { plugin: pluginName, status } })
			if (!result) return
			if (result.code !== 'success') {
				notifications.show({
					title: '插件状态更新失败',
					message: result.error || result.code,
					color: 'red',
				})
				return
			}

			notifications.show({
				title: '插件状态已更新',
				message: `${pluginName} ${ACTION_LABEL[status]}成功`,
				color: 'green',
			})
			await handleStatusUpdated()
		} catch (error: any) {
			notifications.show({
				title: '插件状态更新失败',
				message: error?.message || '操作失败，请稍后重试',
				color: 'red',
			})
		}
	}

	const handleAction = (status: UpdatePluginStatusStatusInput) => {
		const missing = dependencies
			.filter((dep) => !dep?.isRunning && !dep?.optional)
			.map((dep) => dep?.name)
		const proceed = () => {
			void performAction(status)
		}

		if (missing.length > 0) {
			openConfirmModal({
				title: '前置依赖未启动',
				children: (
					<div>
						请确认是否强制{ACTION_LABEL[status]}。
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

	const canToggle = !mutationState.isLoading

	return (
		<Group gap="xs" align="right">
			<Tooltip label="启动">
				<ActionIcon
					variant="light"
					size="lg"
					onClick={() => handleAction(UpdatePluginStatusStatusInput.start)}
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
					onClick={() => handleAction(UpdatePluginStatusStatusInput.stop)}
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
					onClick={() => handleAction(UpdatePluginStatusStatusInput.restart)}
					disabled={!canToggle || !isRunning}
				>
					<IconRotateClockwise size={18} />
				</ActionIcon>
			</Tooltip>
		</Group>
	)
}
