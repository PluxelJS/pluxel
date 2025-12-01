// ActionBar.tsx

import { ActionIcon, Group, Switch, Tooltip } from '@mantine/core'
import { openConfirmModal } from '@mantine/modals'
import { IconPlayerPlay, IconRotateClockwise, IconSquareX } from '@tabler/icons-react'
import { useCallback, useRef, useState } from 'react'
import { PluginStatusEntryLifecycleStage } from '../../gqty'
import { createRpcClient } from '../../rpc'
import type { PluginStatusAction } from '../../../../../../hmr/src/api/hono/rpc/types'
import { ExtensionSlot } from '../../../extension'
import { usePluginScope } from './context'
import { useNotify } from '../../hooks'
import { emitPluginStatusEvent } from '../statusEvents'

export interface ActionBarProps {
	onStatusUpdated?: () => Promise<void> | void
}

const ACTION_LABEL: Record<PluginStatusAction, string> = {
	start: '启动',
	stop: '终止',
	restart: '重启',
	enable: '启用',
	disable: '禁用',
}

export function ActionBar({ onStatusUpdated }: ActionBarProps) {
	const {
		pluginName,
		dependencies,
		isRunning,
		isEnabled,
		isSyncing,
		refetch,
		write,
	} = usePluginScope()

	// 乱序防护：只接受最后一次操作的结果
	const seqRef = useRef(0)
	const [isLoading, setIsLoading] = useState(false)

	const notify = useNotify()

	const applyOptimistic = useCallback(
		(action: PluginStatusAction) => {
			if (!pluginName) return
			write((q) => {
				const p = q.plugin({ name: pluginName })
				if (!p) return
				const currentEnabled = Boolean(p.status.isEnabled)
				switch (action) {
					case 'start':
					case 'restart':
						p.status.isRunning = true
						p.status.isEnabled = true
						p.status.lifecycleStage = PluginStatusEntryLifecycleStage.running
						break
					case 'stop':
						p.status.isRunning = false
						p.status.lifecycleStage = currentEnabled
							? PluginStatusEntryLifecycleStage.stopped
							: PluginStatusEntryLifecycleStage.disabled
						break
					case 'disable':
						p.status.isRunning = false
						p.status.isEnabled = false
						p.status.lifecycleStage = PluginStatusEntryLifecycleStage.disabled
						break
					case 'enable':
						p.status.isEnabled = true
						p.status.lifecycleStage = p.status.isRunning
							? PluginStatusEntryLifecycleStage.running
							: PluginStatusEntryLifecycleStage.stopped
						break
					default:
						break
				}
			})
		},
		[pluginName, write],
	)

	const syncAfterSuccess = useCallback(
		async (action: PluginStatusAction) => {
			await refetch()
			await onStatusUpdated?.()
			emitPluginStatusEvent({ pluginName, action })
		},
		[onStatusUpdated, pluginName, refetch],
	)

	const performAction = async (action: PluginStatusAction) => {
		if (!pluginName) return
		const mySeq = ++seqRef.current

		// ① 全局乐观：立即写入运行/同步态
		applyOptimistic(action)
		setIsLoading(true)

		try {
			using rpc = createRpcClient()
			const res = await rpc.plugin(pluginName).updateStatus(action)
			if (mySeq !== seqRef.current) return

			if (res.ok === false) {
				notify({
					title: '插件状态更新失败',
					message: res.error || res.code || '操作失败，请稍后重试',
					color: 'red',
				})
				// 失败直接以真实数据为准（无需手写回滚）：拉齐一次
				await refetch()
				return
			}

			// ② 成功：让返回覆盖乐观态，再进行一次精准对齐
			await syncAfterSuccess(action)

			notify({
				title: '插件状态已更新',
				message: `${pluginName} ${ACTION_LABEL[action]}成功`,
				color: 'green',
			})
		} catch (e: any) {
			if (mySeq !== seqRef.current) return
			notify({
				title: '插件状态更新失败',
				message: e?.message ?? '操作失败，请稍后重试',
				color: 'red',
			})
			await refetch()
		} finally {
			setIsLoading(false)
		}
	}

	const handleAction = (action: PluginStatusAction) => {
		const needsDependencyCheck = action === 'start' || action === 'restart'
		const missing = needsDependencyCheck
			? dependencies.filter((d) => !d.isRunning && !d.optional).map((d) => d.name)
			: []

		const proceed = () => void performAction(action)

		if (missing.length) {
			openConfirmModal({
				title: '前置依赖未启动',
				children: (
					<div>
						请确认是否强制{ACTION_LABEL[action]}。
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

	const busy = isLoading || isSyncing
	const canToggle = !busy
	const persistDisabled = busy

	return (
		<Group gap="xs" align="right">
			<ExtensionSlot point="plugin:actions" fallback={null} />

			<Tooltip
				label={
					busy ? '同步中…' : isEnabled ? '禁用后将停止运行并移除持久启用' : '启用后可持久保留该插件'
				}
			>
				<Switch
					size="md"
					checked={isEnabled}
					onLabel="启用"
					offLabel="禁用"
					disabled={persistDisabled}
					onChange={(event) =>
						void performAction(event.currentTarget.checked ? 'enable' : 'disable')
					}
				/>
			</Tooltip>

			<Tooltip label={busy ? '同步中…' : '启动'}>
				<ActionIcon
					variant="light"
					size="lg"
					onClick={() => handleAction('start')}
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
					onClick={() => handleAction('stop')}
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
					onClick={() => handleAction('restart')}
					disabled={!canToggle || !isRunning}
				>
					<IconRotateClockwise size={18} />
				</ActionIcon>
			</Tooltip>
		</Group>
	)
}
