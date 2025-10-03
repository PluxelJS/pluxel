import { ActionIcon, Group, Tooltip } from '@mantine/core'
import { openConfirmModal } from '@mantine/modals'
import { notifications } from '@mantine/notifications'
import { IconPlayerPlay, IconRotateClockwise, IconSquareX } from '@tabler/icons-react'
import { useMemo } from 'react'
import {
	UpdatePluginStatusStatusInput,
	useMutation as useGqtyMutation,
} from '../gqty'
import type { PluginDependency, PluginScope } from '../gqty'

interface DependencySnapshot {
	name: string
	optional: boolean
	isRunning: boolean
}

const EMPTY_DEPS: DependencySnapshot[] = []

export interface ActionBarProps {
	scope?: PluginScope
	fallbackName: string
	onStatusUpdated?: () => Promise<void> | void
}

const ACTION_LABEL: Record<UpdatePluginStatusStatusInput, string> = {
	start: '启动',
	stop: '终止',
	restart: '重启',
}

export function ActionBar({ scope, fallbackName, onStatusUpdated }: ActionBarProps) {
	const pluginName = scope?.name ?? fallbackName
	const dependencies = useMemo<DependencySnapshot[]>(() => {
		const list = scope?.detail?.dependencies as PluginDependency[] | undefined
		if (!list?.length) return EMPTY_DEPS
		return list
			.filter(Boolean)
			.map((dep) => ({
				name: dep?.name ?? '',
				optional: Boolean(dep?.optional),
				isRunning: Boolean(dep?.isRunning),
			}))
	}, [scope?.detail?.dependencies])
	const isSelfRunning = Boolean(scope?.status?.isRunning)
	const [mutateStatus, mutationState] = useGqtyMutation(
		(mutation, args: { status: UpdatePluginStatusStatusInput; plugin: string }) => {
			const result = mutation.updatePluginStatus({
				name: args.plugin,
				status: args.status,
			})
			// 选择关键字段以生成完整的 GraphQL 语句
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
			const result = await mutateStatus({ args: { status, plugin: pluginName } })
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
			await onStatusUpdated?.()
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
					onClick={() => handleAction(UpdatePluginStatusStatusInput.stop)}
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
					onClick={() => handleAction(UpdatePluginStatusStatusInput.restart)}
					disabled={!canToggle || !isSelfRunning}
				>
					<IconRotateClockwise size={18} />
				</ActionIcon>
			</Tooltip>
		</Group>
	)
}
