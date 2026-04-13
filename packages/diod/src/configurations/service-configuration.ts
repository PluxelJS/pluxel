import type { ServiceData } from '../internal-types'
import { ScopeType } from '../types'
import type { AliasKey, BuildOptions, ConfigurableRegistration } from '../types/types'

export abstract class ServiceConfiguration<T> implements ConfigurableRegistration {
	protected abstract scope: ScopeType
	protected isPrivate = false
	protected tags: string[] = []
	protected alias: AliasKey[] = []

	protected constructor(protected readonly onMutate?: () => void) {}

	public public(): this {
		this.isPrivate = false
		this.onMutate?.()
		return this
	}

	public private(): this {
		this.isPrivate = true
		this.onMutate?.()
		return this
	}

	public addTag(tag: string): this {
		this.tags.push(tag)
		this.onMutate?.()
		return this
	}

	public addAlias(alias: AliasKey): this {
		this.alias.push(alias)
		this.onMutate?.()
		return this
	}

	protected abstract build(options: BuildOptions): ServiceData<T>

	protected asTransient(): this {
		this.scope = ScopeType.Transient
		this.onMutate?.()
		return this
	}

	protected asSingleton(): this {
		this.scope = ScopeType.Singleton
		this.onMutate?.()
		return this
	}

	protected asInstancePerRequest(): this {
		this.scope = ScopeType.Request
		this.onMutate?.()
		return this
	}

	protected asBuilderSingleton(): this {
		this.scope = ScopeType.Builder_Singleton
		this.onMutate?.()
		return this
	}
}
