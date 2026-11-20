import { useMutation, useQueryClient } from '@tanstack/react-query'
import { type PluginNodeAddress } from '@pluxel/core'
import {
	type ConfigValidationErrors,
	type ConfigResultOk,
} from '@pluxel/services/management/client'

import { type RuntimeManagementClient } from '../../../runtime'
import { notifyAndRecord } from '../../notifications/notifyBridge'
import { refreshPluginReadModels } from '../pluginReadModels'
import { commitPluginConfig, refreshPluginConfig } from './usePluginConfig'

type ConfigSaveResult = Awaited<ReturnType<RuntimeManagementClient['config']['patch']>>

type ConfigSaveVariables = {
	request: () => Promise<ConfigSaveResult>
	onValidation: (errors: ConfigValidationErrors) => void
	onSaved: (result: ConfigResultOk) => void
	sectionCount: number
	all: boolean
}

/** Owns the write lifecycle; callers retain responsibility for their submitted draft snapshots. */
export function useConfigSave({ owner }: { owner: PluginNodeAddress }) {
	const queryClient = useQueryClient()

	return useMutation({
		retry: false,
		mutationFn: ({ request }: ConfigSaveVariables) => request(),
		onSuccess: async (result, { onValidation, onSaved, sectionCount, all }) => {
			if (result.ok === false) {
				if (result.code === 'validation_failed') onValidation(result.errors)
				if (result.state === 'unknown' || result.code === 'revision_conflict') {
					await Promise.allSettled([
						refreshPluginConfig(queryClient, owner),
						refreshPluginReadModels(queryClient),
					])
				}
				notifyAndRecord({
					title: all ? '全部保存失败' : '提交失败',
					message: result.message ?? result.code ?? '未知错误',
					color: 'red',
				})
				return
			}

			commitPluginConfig(queryClient, owner, result)
			onSaved(result)
			// A failed read-model refresh must not turn an acknowledged write into a save failure.
			await Promise.allSettled([refreshPluginReadModels(queryClient)])
			const retention =
				result.persistence.status === 'confirmed' ? result.persistence.retention : undefined
			const persistenceMessage =
				retention === 'session' ? '仅本次会话有效。' : retention === 'unknown' ? '' : ''
			const shadowed = result.shadowedPaths.length > 0 ? '部分值被声明覆盖。' : ''
			const applicationMessage =
				result.application === 'saved-not-applied'
					? (result.applyFailure?.message ?? '插件尚未采用新配置。')
					: result.application === 'deferred'
						? '将在插件启动时生效。'
						: '已生效。'
			notifyAndRecord({
				title:
					result.persistence.status === 'unchanged'
						? '保存输入未改变'
						: retention === 'session'
							? '会话配置已更新'
							: result.application === 'saved-not-applied'
								? '配置已保存，但尚未应用'
								: all
									? `已保存 ${sectionCount} 个配置分区`
									: '配置已保存',
				message: [persistenceMessage, shadowed, applicationMessage].filter(Boolean).join(' '),
				color: result.application === 'saved-not-applied' || shadowed ? 'yellow' : 'green',
			})
		},
		onError: async (cause, { all }) => {
			await Promise.allSettled([
				refreshPluginConfig(queryClient, owner),
				refreshPluginReadModels(queryClient),
			])
			notifyAndRecord({
				title: all ? '全部保存失败' : '提交失败',
				message: cause instanceof Error ? cause.message : '无法连接运行时',
				color: 'red',
			})
		},
	})
}
