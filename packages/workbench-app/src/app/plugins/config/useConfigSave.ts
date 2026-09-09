import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { PluginNodeAddress } from '@pluxel/core'
import type { ConfigValidationErrors } from '@pluxel/runtime/web'

import type { RuntimeManagementClient } from '../../../runtime'
import { useNotify } from '../../hooks/useNotify'
import { refreshPluginReadModels } from '../pluginReadModels'
import { commitPluginConfig, refreshPluginConfig } from './usePluginConfig'

type ConfigSaveResult = Awaited<ReturnType<RuntimeManagementClient['config']['patch']>>

type ConfigSaveVariables = {
	request: () => Promise<ConfigSaveResult>
	onValidation: (errors: ConfigValidationErrors) => void
	onSaved: () => void
	sectionCount: number
	all: boolean
}

/** Owns the write lifecycle; callers retain responsibility for their submitted draft snapshots. */
export function useConfigSave({ owner }: { owner: PluginNodeAddress }) {
	const queryClient = useQueryClient()
	const notify = useNotify()

	return useMutation({
		retry: false,
		mutationFn: ({ request }: ConfigSaveVariables) => request(),
		onSuccess: async (result, { onValidation, onSaved, sectionCount, all }) => {
			if (result.ok === false) {
				if (result.code === 'validation_failed') onValidation(result.errors)
				if (result.state === 'unknown') {
					await Promise.allSettled([
						refreshPluginConfig(queryClient, owner),
						refreshPluginReadModels(queryClient),
					])
				}
				notify({
					title: all ? '全部保存失败' : '提交失败',
					message: result.message ?? result.code ?? '未知错误',
					color: 'red',
				})
				return
			}

			commitPluginConfig(queryClient, owner, result.config)
			onSaved()
			// A failed read-model refresh must not turn an acknowledged write into a save failure.
			await Promise.allSettled([refreshPluginReadModels(queryClient)])
			if (result.application === 'saved-not-applied') {
				notify({
					title: '配置已保存，但尚未应用',
					message:
						result.saved === true ? result.applyFailure.message : '运行中的插件尚未应用当前配置。',
					color: 'yellow',
				})
			} else {
				notify({
					title: all ? '全部保存成功' : '提交成功',
					message:
						result.application === 'deferred'
							? '配置已保存，将在插件启动时应用'
							: all
								? `已保存 ${sectionCount} 个配置分区`
								: '配置已保存并应用',
					color: 'green',
				})
			}
		},
		onError: async (cause, { all }) => {
			await Promise.allSettled([
				refreshPluginConfig(queryClient, owner),
				refreshPluginReadModels(queryClient),
			])
			notify({
				title: all ? '全部保存失败' : '提交失败',
				message: cause instanceof Error ? cause.message : '无法连接运行时',
				color: 'red',
			})
		},
	})
}
