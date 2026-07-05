import type { YogaInitialContext } from 'graphql-yoga'
import type { Context as PluxelContext } from '@pluxel/runtime'
import type { CommercialServices } from './services.ts'

export interface CommercialContext {
	readonly request: Request
	readonly pluxel: PluxelContext
	readonly services: CommercialServices
	readonly actor: {
		readonly id: string
		readonly role: 'operator' | 'viewer'
	}
}

export async function createCommercialContext(
	initial: YogaInitialContext,
	pluxel: PluxelContext,
	services: CommercialServices,
): Promise<CommercialContext> {
	return {
		request: initial.request,
		pluxel,
		services,
		actor: {
			id: initial.request.headers.get('x-demo-actor') ?? 'static-commercial-operator',
			role: 'operator',
		},
	}
}
