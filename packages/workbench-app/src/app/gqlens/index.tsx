import { GQLensProvider } from '@gqlens/react'
import type { ReactNode } from 'react'
import type { Fetcher } from '@gqlens/core'
import type {
	Plugin,
	PluginGroup,
	PluginGroupNode,
	PluginStatus,
	PluginSourceInfoKind as PluginSourceInfoKindType,
	PluginStatusLifecycleStage,
} from './types'
import type { PluginNodeAddressSnapshot } from '@pluxel/core'

import { getRuntimeTransportClient } from '../../runtime'
import { stringifyUnknown } from '../../utils/unknown'

export const PluginStatusEntryLifecycleStage = {
	running: 'running',
	stopped: 'stopped',
	disabled: 'disabled',
} as const
export type PluginStatusEntryLifecycleStage = PluginStatusLifecycleStage
export type PluginStatusEntry = PluginStatus &
	Pick<Plugin, 'id' | 'name' | 'rootExportName'> & {
		address: PluginNodeAddressSnapshot
	}
export type PluginGroupEntry = Omit<PluginGroup, 'nodes'> & {
	nodes: Array<Omit<PluginGroupNode, 'address'> & { address: PluginNodeAddressSnapshot }>
}
export type PluginDependency = Pick<Plugin, 'id' | 'name' | 'rootExportName'> & {
	address: PluginNodeAddressSnapshot
	isRunning: boolean
}

export const PluginSourceInfoKind = {
	hmr: 'hmr',
	package: 'package',
	unknown: 'unknown',
} as const
export type PluginSourceInfoKind = PluginSourceInfoKindType

const transport = getRuntimeTransportClient()
const inflightGraphql = new Map<string, Promise<unknown>>()

function graphqlKey(input: {
	query?: unknown
	variables?: unknown
	operationName?: unknown
}): string {
	try {
		return JSON.stringify(input) ?? ''
	} catch {
		return stringifyUnknown(input.query)
	}
}

export const graphqlFetcher: Fetcher = async (operation) => {
	const key = graphqlKey(operation)
	const existing = inflightGraphql.get(key)
	if (existing !== undefined) return existing

	const task = (async () => {
		const response = await transport.fetch(transport.links.graphql, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				query: operation.query,
				variables: operation.variables,
				operationName: operation.operationName,
			}),
			mode: 'cors',
		})
		const payload = (await response.json()) as {
			data?: unknown
			errors?: Array<{ message?: string }>
		}
		if (!response.ok || payload.errors?.length) {
			throw new Error(payload.errors?.[0]?.message ?? `GraphQL request failed: ${response.status}`)
		}
		return payload.data ?? {}
	})()

	inflightGraphql.set(key, task)
	try {
		return await task
	} finally {
		inflightGraphql.delete(key)
	}
}

export function PluxelGQLensProvider({ children }: { children?: ReactNode }) {
	return (
		<GQLensProvider
			config={{ fetcher: graphqlFetcher, query: { policy: 'cache-first', ttl: 30_000 } }}
		>
			{children}
		</GQLensProvider>
	)
}

export { useMutation } from '@gqlens/react'

export {
	useQuery,
	useLiveQuery,
	usePreparedQuery,
	defineInvalidation,
	defineSelection,
	gqlensSchema,
	api,
} from './accessor'
export type * from './types'
