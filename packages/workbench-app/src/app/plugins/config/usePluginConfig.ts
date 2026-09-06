import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { PluginNodeAddress } from '@pluxel/core'
import type { FieldNode } from 'valibot-form'

import { useRuntimeManagementClient, type RuntimeManagementClient } from '../../../runtime'
import { managementQueryKeys, refetchManagementQuery } from '../../managementQuery'
import { adaptConfigPresentationFields } from './presentationAdapter'

export type PluginConfigData = {
	fieldName: string
	fields: readonly FieldNode[]
	defaults: Record<string, unknown>
	savedConfig: Record<string, unknown>
	sections: readonly PluginConfigSection[]
}

export type PluginConfigSection = Readonly<{
	path: readonly string[]
	fieldName: string
	fields: readonly FieldNode[]
	defaults: Record<string, unknown>
}>

export type PluginConfigState = {
	data?: PluginConfigData
	loading: boolean
	error?: Error
	refetch: () => Promise<void>
}

type PluginConfigPresentation = Omit<PluginConfigData, 'savedConfig'>

async function readPresentation(
	client: RuntimeManagementClient,
	owner: PluginNodeAddress,
): Promise<PluginConfigPresentation> {
	const result = await client.config.presentation(owner)
	if (result.ok === false) {
		if (result.code === 'presentation_not_found') {
			return { fieldName: '', fields: [], defaults: {}, sections: [] }
		}
		throw new Error(result.message ?? result.code)
	}
	const presentation = result.plan
	return {
		fieldName: presentation.fieldName,
		fields: adaptConfigPresentationFields(presentation.fields),
		defaults: { ...presentation.defaults },
		sections: presentation.sections.map((section) => ({
			path: section.path,
			fieldName: section.fieldName,
			fields: adaptConfigPresentationFields(section.fields),
			defaults: { ...section.defaults },
		})),
	}
}

async function readSavedConfig(
	client: RuntimeManagementClient,
	owner: PluginNodeAddress,
): Promise<Record<string, unknown>> {
	const result = await client.config.get(owner)
	if (result.ok === false) {
		// A Plugin without a config declaration has no persisted config to read. The
		// presentation query reports that as an empty form, so keep both reads in
		// agreement instead of turning the Config tab into a load failure.
		if (result.code === 'config_not_found') return {}
		throw new Error(result.message ?? result.code ?? '配置加载失败')
	}
	return result.config ?? {}
}

export function commitPluginConfig(
	queryClient: QueryClient,
	owner: PluginNodeAddress,
	savedConfig: Record<string, unknown>,
): void {
	queryClient.setQueryData(managementQueryKeys.pluginSavedConfig(owner), savedConfig)
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
		queryFn: () => readSavedConfig(client, requireOwner(owner)),
		enabled: owner !== undefined,
	})
	const error = presentation.error ?? saved.error
	const data =
		presentation.data && saved.data ? { ...presentation.data, savedConfig: saved.data } : undefined

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
