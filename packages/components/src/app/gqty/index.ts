/**
 * GQty: You can safely modify this file based on your needs.
 */

import { createReactClient } from '@gqty/react'
import { Cache, createClient, defaultResponseHandler, type QueryFetcher } from 'gqty'
import { getHmrWebClient } from '../../hmr/client'
import { type GeneratedSchema, generatedSchema, scalarsEnumsHash } from './schema.generated'

const hmr = getHmrWebClient()

const inflightGraphql = new Map<string, Promise<any>>()

function graphqlKey(input: {
	query?: unknown
	variables?: unknown
	operationName?: unknown
}): string {
	try {
		return JSON.stringify(input) ?? ''
	} catch {
		// Avoid throwing from key generation; fallback to query string only.
		return String((input as any)?.query ?? '')
	}
}

const queryFetcher: QueryFetcher = async ({ query, variables, operationName }, fetchOptions) => {
	const endpoint = hmr.transport.graphql

	const key = graphqlKey({ query, variables, operationName })
	const existing = inflightGraphql.get(key)
	if (existing) return existing

	const task = (async () => {
		const response = await hmr.fetch(endpoint, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				query,
				variables,
				operationName,
			}),
			mode: 'cors',
			...fetchOptions,
		})

		return await defaultResponseHandler(response)
	})()

	inflightGraphql.set(key, task)
	try {
		return await task
	} finally {
		inflightGraphql.delete(key)
	}
}

const cache = new Cache(
	undefined,
	/**
	 * Default option is immediate cache expiry but keep it for 5 minutes,
	 * allowing soft refetches in background.
	 */
	{
		maxAge: 60 * 1000,
		staleWhileRevalidate: 5 * 60 * 1000,
		normalization: true,
	},
)

export const client = createClient<GeneratedSchema>({
	schema: generatedSchema,
	scalars: scalarsEnumsHash,
	cache,
	fetchOptions: {
		fetcher: queryFetcher,
	},
})

// Core functions
export const { resolve, subscribe, schema } = client

// Legacy functions
export const { query, mutation, mutate, subscription, resolved, refetch, track } = client

export const {
	graphql,
	useQuery,
	usePaginatedQuery,
	useTransactionQuery,
	useLazyQuery,
	useRefetch,
	useMutation,
	useMetaState,
	prepareReactRender,
	useHydrateCache,
	prepareQuery,
} = createReactClient<GeneratedSchema>(client, {
	defaults: {
		// Enable Suspense, you can override this option for each hook.
		suspense: false,
	},
})

export * from './schema.generated'
