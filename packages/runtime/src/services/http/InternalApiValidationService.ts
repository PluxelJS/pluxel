import {
	formatPluginNodeReference,
	type Context as PluxelContext,
	Injectable,
	type PluginNodeAddress,
} from '@pluxel/core'

const serviceName = 'internalApiValidation' as const

declare module '@pluxel/core' {
	namespace Context {
		interface Services {
			[serviceName]: InternalApiValidationService
		}
	}
}

export type InternalApiValidationContext = {
	path: string
	method: string
	url: string
	headers: Headers
	request: Request
}

export type InternalApiValidator = (ctx: InternalApiValidationContext) => Promise<boolean> | boolean

export type InternalApiValidationResult =
	| { allow: true }
	| {
			allow: false
			owner: PluginNodeAddress | null
	  }

type ActiveValidator = {
	owner: PluginNodeAddress | null
	validate: InternalApiValidator
	removeFromScope: () => void
}

@Injectable({ key: serviceName })
export class InternalApiValidationService {
	private readonly validators = new Set<ActiveValidator>()
	private readonly logger: NonNullable<PluxelContext['logger']>

	constructor(public ctx: PluxelContext) {
		this.logger = ctx.logger!
		this.validators.add({
			owner: null,
			removeFromScope: () => {},
			validate: ({ url, headers }) => {
				const site = (headers.get('sec-fetch-site') ?? '').trim().toLowerCase()
				if (site) return site !== 'cross-site'

				const origin = headers.get('origin')
				if (!origin) return true
				try {
					const u = new URL(url)
					const expected = `${u.protocol}//${u.host}`
					return origin === expected
				} catch {
					return true
				}
			},
		})
	}

	hasValidators(): boolean {
		return this.validators.size > 0
	}

	register(validate: InternalApiValidator): () => void {
		if (typeof validate !== 'function') {
			throw new TypeError('[InternalApiValidationService] register(validate) is required.')
		}

		const owner = this.ctx.pluginInfo?.nodeAddress
		if (!owner) throw new Error('[InternalApiValidationService] Plugin node owner is required')

		const active: ActiveValidator = {
			owner,
			validate,
			removeFromScope: () => {},
		}

		const guard = this.ctx.effects.defer(() => this.remove(active))
		active.removeFromScope = () => guard.cancel()
		this.validators.add(active)

		return () => this.remove(active)
	}

	async check(input: InternalApiValidationContext): Promise<InternalApiValidationResult> {
		if (this.validators.size === 0) return { allow: true }

		for (const v of this.validators) {
			try {
				const ok = await v.validate(input)
				if (!ok) {
					return { allow: false, owner: v.owner }
				}
			} catch (error) {
				this.logger.error('Internal API validator threw', {
					error,
					plugin: v.owner ? formatPluginNodeReference(v.owner) : 'runtime',
					path: input.path,
					method: input.method,
				})
				return { allow: false, owner: v.owner }
			}
		}

		return { allow: true }
	}

	private remove(expected: ActiveValidator) {
		if (!this.validators.has(expected)) return
		this.validators.delete(expected)

		expected.removeFromScope()
		expected.removeFromScope = () => {}
	}
}
