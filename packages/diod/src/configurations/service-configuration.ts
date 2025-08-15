import type { ServiceData } from '../internal-types'
import { ScopeType } from '../types'
import type {
	AliasKey,
	BuildOptions,
	ConfigurableRegistration,
} from '../types/types'

export abstract class ServiceConfiguration<T>
	implements ConfigurableRegistration
{
	protected abstract scope: ScopeType
	protected isPrivate = false
	protected tags: string[] = []
	protected alias: AliasKey[] = []

	public public(): this {
		this.isPrivate = false
		return this
	}

	public private(): this {
		this.isPrivate = true
		return this
	}

	public addTag(tag: string): this {
		this.tags = [...this.tags, tag]
		return this
	}

	public addAlias(alias: AliasKey) {
		this.alias = [...this.alias, alias]
		return this
	}

	protected abstract build(options: BuildOptions): ServiceData<T>

	protected asTransient(): this {
		this.scope = ScopeType.Transient
		return this
	}

	protected asSingleton(): this {
		this.scope = ScopeType.Singleton
		return this
	}

	protected asInstancePerRequest(): this {
		this.scope = ScopeType.Request
		return this
	}

	protected asBuilderSingleton(): this {
		this.scope = ScopeType.Builder_Singleton
		return this
	}
}
