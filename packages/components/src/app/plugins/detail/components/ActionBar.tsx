// ActionBar.tsx

import { ActionIcon, Group, Switch, Tooltip } from '@mantine/core'
import { openConfirmModal } from '@mantine/modals'
import { IconPlayerPlay, IconRotateClockwise, IconSquareX } from '@tabler/icons-react'
import { useCallback, useRef, useState } from 'react'
import type { PluginStatusAction } from '@pluxel/runtime/web/ui'
import { ExtensionSlot } from '../../../../extension'
import { PluginStatusEntryLifecycleStage } from '../../../gqty'
import { useNotify } from '../../../hooks'
import { useHmrWebClient } from '../../../rpc'
import { buildStartPlan, executeStartPlan } from '../../actions'
import { invalidate } from '../../../data/invalidations'
import { usePluginScope } from '../context'

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
	const hmr = useHmrWebClient()
	const {
		pluginName,
		dependencies,
		knownPluginNames,
		isRunning,
		isEnabled,
		lifecycleStage,
		isSyncing,
		refetch,
		setStatusOverride,
	} = usePluginScope()

	// 乱序防护：只接受最后一次操作的结果
	const seqRef = useRef(0)
	const [isLoading, setIsLoading] = useState(false)

	const notify = useNotify()

	const applyOptimistic = useCallback(
		(action: PluginStatusAction) => {
			if (!pluginName) return
			if (!setStatusOverride) return
			const currentEnabled = Boolean(isEnabled)
			const currentRunning = Boolean(isRunning)
			let nextRunning = currentRunning
			let nextEnabled = currentEnabled
			let nextStage = lifecycleStage
			switch (action) {
				case 'start':
				case 'restart':
					nextRunning = true
					nextEnabled = true
					nextStage = PluginStatusEntryLifecycleStage.running
					break
				case 'stop':
					nextRunning = false
					nextStage = currentEnabled
						? PluginStatusEntryLifecycleStage.stopped
						: PluginStatusEntryLifecycleStage.disabled
					break
				case 'disable':
					nextRunning = false
					nextEnabled = false
					nextStage = PluginStatusEntryLifecycleStage.disabled
					break
				case 'enable':
					nextEnabled = true
					nextStage = currentRunning
						? PluginStatusEntryLifecycleStage.running
						: PluginStatusEntryLifecycleStage.stopped
					break
				default:
					break
			}
			setStatusOverride({
				isRunning: nextRunning,
				isEnabled: nextEnabled,
				lifecycleStage: nextStage,
			})
		},
		[pluginName, setStatusOverride, isEnabled, isRunning, lifecycleStage],
	)

	const syncAfterSuccess = useCallback(
		async (action: PluginStatusAction) => {
			await refetch()
			await onStatusUpdated?.()
			invalidate({ topic: 'plugin-status', pluginName, reason: action })
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
			const res = await hmr.withRpc((rpc) => rpc.plugin(pluginName).updateStatus(action))
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

	const cascadeStart = async (deps: string[], action: PluginStatusAction) => {
		if (!pluginName) return
		const mySeq = ++seqRef.current
		setIsLoading(true)

		try {
			const plan = await buildStartPlan([...deps, pluginName], {
				includeTargets: true,
				includeRunningTargets: action === 'restart',
				requireConfiguredFor: 'dependencies',
			})

			if (plan.missing.length) {
				notify({
					title: '部分依赖未找到',
					message: `已跳过：${plan.missing.join('，')}`,
					color: 'yellow',
				})
			}

			if (plan.blockedByConfig.length) {
				notify({
					title: '级联启动已取消',
					message: `以下依赖尚未配置：${plan.blockedByConfig.join('，')}`,
					color: 'yellow',
				})
				return
			}

			if (plan.order.length === 0) {
				if (plan.missing.length === 0) {
					notify({
						title: '依赖已就绪',
						message: '所有依赖均已运行，无需级联启动。',
						color: 'blue',
					})
				}
				return
			}

			const results = await executeStartPlan(plan.order, action === 'restart' ? 'restart' : 'start')
			if (mySeq !== seqRef.current) return
			const failed = results.filter((r) => !r.ok)
			if (failed.length) {
				notify({
					title: '部分依赖启动失败',
					message: failed.map((f) => f.name).join('，') || '启动失败',
					color: 'red',
				})
				await refetch()
				return
			}

			await syncAfterSuccess(action)
			notify({
				title: '已级联启动',
				message: `已按依赖顺序${ACTION_LABEL[action]}：${plan.order.join(' → ')}`,
				color: 'green',
			})
		} catch (e: any) {
			if (mySeq !== seqRef.current) return
			notify({
				title: '级联启动失败',
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
		const isKnownPlugin = (name: string) => {
			if (knownPluginNames.has(name)) return true
			const hash = name.lastIndexOf('#')
			return hash > 0 ? knownPluginNames.has(name.slice(0, hash)) : false
		}
		const missing = needsDependencyCheck
			? dependencies
					.filter((d) => !d.isRunning && !(d as any)?.optional)
					.map((d) => d.name)
					.filter((name): name is string => Boolean(name && isKnownPlugin(name)))
			: []

			const proceed = (): void => {
				void performAction(action)
			}

		if (missing.length) {
			openConfirmModal({
				title: '前置依赖未启动',
				children: (
					<div>
						<div>可尝试级联启动已配置的依赖链，然后启动当前插件。</div>
						<div style={{ marginTop: 10 }}>以下依赖尚未运行：{missing.join('，')}</div>
					</div>
				),
				labels: { confirm: '级联启动', cancel: '取消' },
				onConfirm: () => void cascadeStart(missing, action),
				closeOnConfirm: true,
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
