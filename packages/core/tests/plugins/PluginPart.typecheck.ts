import {
	BasePlugin,
	Plugin,
	PluginPart,
	type Context,
	type PluginContext,
	type PluginPartClass,
} from '@pluxel/core'
import { expectTypeOf } from 'vitest'

type FixtureContext = PluginContext & {
	readonly fixtureCapability: { readonly value: number }
}

@Plugin({ displayName: 'PluginPart author-surface type provider' })
class TypeProvider extends BasePlugin {}

class TypeLeaf extends PluginPart<TypeBranch, FixtureContext> {
	constructor(private readonly provider: TypeProvider) {
		super()
	}

	immediateHost(): TypeBranch {
		return this.host
	}

	capabilityValue(): number {
		return this.ctx.fixtureCapability.value
	}

	providerProjection(): TypeProvider {
		return this.provider
	}
}

class TypeBranch extends PluginPart<TypeOwner, FixtureContext> {
	readonly leaf = this.parts.use(TypeLeaf)

	protected exerciseAuthorDsl(): void {
		void this.ctx
		void this.host
		void this.parts
		void this.plugins
		void this.configs
	}

	status(): 'ready' {
		return 'ready'
	}

	protected override init() {}
}

@Plugin({ displayName: 'PluginPart author-surface type owner' })
class TypeOwner extends BasePlugin<FixtureContext> {
	readonly branch = this.parts.use(TypeBranch)

	ownerContext(): FixtureContext {
		return this.ctx
	}
}

// @ts-expect-error Arbitrary structural owners are not valid PluginPart hosts.
class InvalidStructuralHostPart extends PluginPart<{ readonly ctx: Context }> {}

expectTypeOf(TypeLeaf).toExtend<PluginPartClass<TypeLeaf>>()
expectTypeOf<TypeOwner['branch']>().toEqualTypeOf<TypeBranch>()
expectTypeOf<TypeBranch['leaf']>().toEqualTypeOf<TypeLeaf>()
expectTypeOf<ReturnType<TypeLeaf['immediateHost']>>().toEqualTypeOf<TypeBranch>()
expectTypeOf<ReturnType<TypeLeaf['capabilityValue']>>().toEqualTypeOf<number>()
expectTypeOf<ReturnType<TypeBranch['status']>>().toEqualTypeOf<'ready'>()
expectTypeOf<ReturnType<TypeOwner['ownerContext']>>().toEqualTypeOf<FixtureContext>()

const assertExternalSurface = () => {
	const part = null as unknown as TypeBranch
	const owner = null as unknown as TypeOwner

	part.status()
	owner.ownerContext()
	void owner.ctx

	// @ts-expect-error Part Context is available only inside its subclass.
	void part.ctx
	// @ts-expect-error The immediate host is available only inside its Part subclass.
	void part.host
	// @ts-expect-error Nested composition is available only inside its Part subclass.
	void part.parts
	// @ts-expect-error Optional bindings are available only inside its Part subclass.
	void part.plugins
	// @ts-expect-error Config declaration is available only inside its Part subclass.
	void part.configs
	// @ts-expect-error PluginPart lifecycle hooks remain protected.
	void part.init

	// @ts-expect-error Plugin Part declaration is an author-only subclass DSL.
	void owner.parts
	// @ts-expect-error Plugin optional bindings are an author-only subclass DSL.
	void owner.plugins
	// @ts-expect-error Plugin config declaration is an author-only subclass DSL.
	void owner.configs
}
void assertExternalSurface
void InvalidStructuralHostPart
