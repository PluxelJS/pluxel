import type { YogaInitialContext } from 'graphql-yoga'
import type { Context as PluxelContext } from '@pluxel/runtime'
import { db } from './db.ts'
import { createCommercialServices } from './services.ts'

export interface CommercialContext {
	readonly request: Request
	readonly pluxel: PluxelContext
	readonly db: typeof db
	readonly services: ReturnType<typeof createCommercialServices>
	readonly actor: {
		readonly id: string
		readonly role: 'operator' | 'viewer'
	}
}

export async function createCommercialContext(
	initial: YogaInitialContext,
	pluxel: PluxelContext,
): Promise<CommercialContext> {
	return {
		request: initial.request,
		pluxel,
		db,
		services: createCommercialServices(db),
		actor: {
			id: initial.request.headers.get('x-demo-actor') ?? 'static-commercial-operator',
			role: 'operator',
		},
	}
}
