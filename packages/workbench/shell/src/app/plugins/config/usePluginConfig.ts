import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { type PluginNodeAddress } from '@pluxel/core'
import { type FieldNode } from 'valibot-form'
import type { ConfigResultOk, ConfigResultErr } from '@pluxel/services/management/client'
import { useRuntimeManagementClient, type RuntimeManagementClient } from '../../../runtime'
import { managementQueryKeys, refetchManagementQuery } from '../../managementQuery'
import { adaptConfigPresentationFields, applyConfigSources } from './presentationAdapter'

export type PluginConfigSection = Readonly<{
	path: readonly string[]
	fieldName: string
	fields: readonly FieldNode[]
}>
type PluginConfigPresentation = {
	fieldName: string
	fields: readonly FieldNode[]
	sections: readonly PluginConfigSection[]
}
export type PluginConfigSnapshot =
	| ConfigResultOk
	| Extract<ConfigResultErr, { code: 'validation_failed' }>
export type PluginConfigData = PluginConfigPresentation & { snapshot: PluginConfigSnapshot | null }
export type PluginConfigState = {
	data?: PluginConfigData
	loading: boolean
	error?: Error
	refetch: () => Promise<void>
}

async function readPresentation(
	client: RuntimeManagementClient,
	owner: PluginNodeAddress,
): Promise<PluginConfigPresentation> {
	const result = await client.config.presentation(owner)
	if (!result.ok) {
		if (result.code === 'presentation_not_found') return { fieldName: '', fields: [], sections: [] }
		throw new Error(result.message ?? result.code)
	}
	return {
		fieldName: result.plan.fieldName,
		fields: adaptConfigPresentationFields(result.plan.fields),
		sections: result.plan.sections.map((section) => ({
			path: section.path,
			fieldName: section.fieldName,
			fields: adaptConfigPresentationFields(section.fields),
		})),
	}
}
async function readConfig(
	client: RuntimeManagementClient,
	owner: PluginNodeAddress,
): Promise<PluginConfigSnapshot | null> {
	const result = await client.config.get(owner)
	if (!result.ok) {
		if (result.code === 'config_not_found') return null
		if (result.code === 'validation_failed') return result
		throw new Error(result.message)
	}
	return result
}
export function commitPluginConfig(
	queryClient: QueryClient,
	owner: PluginNodeAddress,
	snapshot: ConfigResultOk,
): void {
	queryClient.setQueryData(managementQueryKeys.pluginSavedConfig(owner), snapshot)
	queryClient.setQueryData(managementQueryKeys.configState(), { readonly: snapshot.readonly })
}
export async function refreshPluginConfig(
	queryClient: QueryClient,
	owner: PluginNodeAddress,
): Promise<void> {
	await refetchManagementQuery(queryClient, managementQueryKeys.pluginSavedConfig(owner))
}
export function usePluginConfig(owner: PluginNodeAddress | undefined): PluginConfigState {
	const client = useRuntimeManagementClient()
	const queryClient = useQueryClient()
	const presentation = useQuery({
		queryKey: owner
			? managementQueryKeys.pluginConfigPresentation(owner)
			: [...managementQueryKeys.pluginConfigPresentations(), 'inactive'],
		queryFn: () => readPresentation(client, requireOwner(owner)),
		enabled: owner !== undefined,
		staleTime: Number.POSITIVE_INFINITY,
	})
	const saved = useQuery({
		queryKey: owner
			? managementQueryKeys.pluginSavedConfig(owner)
			: [...managementQueryKeys.pluginSavedConfigs(), 'inactive'],
		queryFn: () => readConfig(client, requireOwner(owner)),
		enabled: owner !== undefined,
	})
	const error = presentation.error ?? saved.error
	const snapshot = saved.data
	const data =
		presentation.data && snapshot !== undefined
			? {
					...presentation.data,
					snapshot,
					fields: applyConfigSources(
						presentation.data.fields,
						snapshot?.sources ?? [],
						[],
						snapshot?.effectiveInput,
						snapshot?.ok ? snapshot.config : undefined,
					),
					sections: presentation.data.sections.map((section) => ({
						...section,
						fields: applyConfigSources(
							section.fields,
							snapshot?.sources ?? [],
							section.path,
							snapshot?.effectiveInput,
							snapshot?.ok ? snapshot.config : undefined,
						),
					})),
				}
			: undefined
	return {
		...(data ? { data } : {}),
		loading: owner !== undefined && (presentation.isPending || saved.isPending),
		...(error ? { error: error instanceof Error ? error : new Error('加载失败') } : {}),
		refetch: async () => {
			if (!owner) return
			await Promise.all([
				refetchManagementQuery(queryClient, managementQueryKeys.pluginConfigPresentation(owner)),
				refreshPluginConfig(queryClient, owner),
			])
		},
	}
}
function requireOwner(owner: PluginNodeAddress | undefined): PluginNodeAddress {
	if (!owner) throw new Error('Plugin config query requires an owner')
	return owner
}
