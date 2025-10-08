// ActionBar.tsx

import { ActionIcon, Group, Tooltip } from '@mantine/core'
import { openConfirmModal } from '@mantine/modals'
import { notifications } from '@mantine/notifications'
import { IconPlayerPlay, IconRotateClockwise, IconSquareX } from '@tabler/icons-react'
import { useCallback, useRef } from 'react'
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
	const { pluginName, dependencies, isRunning, isSyncing, refetch, write } = usePluginScope()

	// 乱序防护：只接受最后一次操作的结果
	const seqRef = useRef(0)

	const [mutateStatus, mutationState] = useGqtyMutation(
		(mutation, args: { plugin: string; status: UpdatePluginStatusStatusInput }) => {
			const { plugin, status } = args
			const result = mutation.updatePluginStatus({ name: plugin, status })
			// 选择关键字段，成功时覆盖乐观态
			result.code
			result.error
			result.isRunning
			return result
		},
		{ suspense: false },
	)

	const applyOptimistic = useCallback(
		(status: UpdatePluginStatusStatusInput) => {
			if (!pluginName) return
			write((q) => {
				const p = q.plugin({ name: pluginName })
				if (!p) return
				// 同步至缓存中的运行态（仅本地）
				if (status === 'start') {
					p.status.isRunning = true
				} else if (status === 'stop') {
					p.status.isRunning = false
				} else {
					// restart
					p.status.isRunning = true
				}
			})
		},
		[pluginName, write],
	)

	const syncAfterSuccess = useCallback(async () => {
		await refetch()
		await onStatusUpdated?.()
	}, [onStatusUpdated, refetch])

	const performAction = async (status: UpdatePluginStatusStatusInput) => {
		if (!pluginName) return
		const mySeq = ++seqRef.current

		// ① 全局乐观：立即写入运行/同步态
		applyOptimistic(status)

		try {
			const res = await mutateStatus({ args: { plugin: pluginName, status } })
			if (mySeq !== seqRef.current) return

			if (!res || res.code !== 'success') {
				notifications.show({
					title: '插件状态更新失败',
					message: res?.error || res?.code || '操作失败，请稍后重试',
					color: 'red',
				})
				// 失败直接以真实数据为准（无需手写回滚）：拉齐一次
				await refetch()
				return
			}

			// ② 成功：让返回覆盖乐观态，再进行一次精准对齐
			await syncAfterSuccess()

			notifications.show({
				title: '插件状态已更新',
				message: `${pluginName} ${ACTION_LABEL[status]}成功`,
				color: 'green',
			})
		} catch (e: any) {
			if (mySeq !== seqRef.current) return
			notifications.show({
				title: '插件状态更新失败',
				message: e?.message ?? '操作失败，请稍后重试',
				color: 'red',
			})
			await refetch()
		} finally {
			// 同步状态由 query/config 的 loading 推导，无需手动清理
		}
	}

	const handleAction = (status: UpdatePluginStatusStatusInput) => {
		const missing = dependencies.filter((d) => !d.isRunning && !d.optional).map((d) => d.name)

		const proceed = () => void performAction(status)

		if (missing.length) {
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

	const busy = mutationState.isLoading || isSyncing
	const canToggle = !busy

	return (
		<Group gap="xs" align="right">
			<Tooltip label={busy ? '同步中…' : '启动'}>
				<ActionIcon
					variant="light"
					size="lg"
					onClick={() => handleAction(UpdatePluginStatusStatusInput.start)}
					disabled={!canToggle || isRunning}
				>
					<IconPlayerPlay size={18} />
				</ActionIcon>
			</Tooltip>

			<Tooltip label={busy ? '同步中…' : '终止'}>
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

			<Tooltip label={busy ? '同步中…' : '重启'}>
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
