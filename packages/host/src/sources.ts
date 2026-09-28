import type { Context } from '@pluxel/core'

export type PluginSourceRequirement =
	| Readonly<{ kind: 'file'; path: string }>
	| Readonly<{ kind: 'directory'; path: string; include: readonly string[] }>

export type PluginSourceChange = Readonly<{ type: 'add' | 'change' | 'unlink'; path: string }>

export type PluginSourceOpenOptions = Readonly<{
	root: string
	onChange(change: PluginSourceChange): void
	onError(error: unknown): void
	/** Aborting stops admission; callers must still await close to drain owned resources. */
	signal?: AbortSignal
}>

/** A side-effect-free source description. Each open owns an independent discovery session. */
export interface PluginSource {
	/** Source implementation-generated structural identity. Omission uses object identity for session reuse. */
	readonly key?: string
	covers(options: { root: string; requirement: PluginSourceRequirement }): boolean
	/** Begins watching and captures initial entries. close is idempotent and stops event admission. */
	open(options: PluginSourceOpenOptions): Promise<
		Readonly<{
			entries: readonly string[]
			close(): Promise<void>
		}>
	>
}

export class PluginSourceRequiredError extends Error {
	constructor(public readonly code: 'SOURCE_REQUIRED' | 'SOURCE_NOT_DECLARED') {
		super(
			code === 'SOURCE_REQUIRED'
				? 'Host has no Plugin sources'
				: 'Required Plugin source is not declared by this host',
		)
		this.name = 'PluginSourceRequiredError'
	}
}

const sourcesByRoot = new WeakMap<
	Context['root'],
	Readonly<{ root: string; sources: readonly PluginSource[] }>
>()

/** @internal Install the application declaration before activating any producer Plugin. */
export function installPluginSources(
	ctx: Context,
	options: { root: string; sources: readonly PluginSource[] },
): void {
	if (sourcesByRoot.has(ctx.root)) throw new Error('[host] Plugin sources are already installed')
	sourcesByRoot.set(
		ctx.root,
		Object.freeze({ root: options.root, sources: Object.freeze([...options.sources]) }),
	)
	ctx.root.effects.defer(
		() => {
			sourcesByRoot.delete(ctx.root)
		},
		{ tag: 'PluginSources', phase: 'shutdown' },
	)
}

/** Resolve a producer's requirement against the application's explicitly declared sources. */
export function assertPluginSource(ctx: Context, requirement: PluginSourceRequirement): void {
	const config = sourcesByRoot.get(ctx.root)
	if (!config || config.sources.length === 0) throw new PluginSourceRequiredError('SOURCE_REQUIRED')
	const source = config.sources.find((candidate) =>
		candidate.covers({ root: config.root, requirement }),
	)
	if (!source) throw new PluginSourceRequiredError('SOURCE_NOT_DECLARED')
}
