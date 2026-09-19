import { ContextCapabilityMissingError, type Context } from '@pluxel/core'
import {
	readProductDescriptor,
	type HostApplicationMeta,
	type ProductDescriptor,
} from '@pluxel/management/product'
import type {
	AnyWorkbenchDefinition,
	WorkbenchPublishBindings,
	WorkbenchPrincipal,
} from '../workbench/definition.ts'
import type { WorkbenchSessionApi } from '../workbench/client-protocol.ts'
import {
	WorkbenchArtifactService,
	type WorkbenchArtifactLookup,
} from './workbench/WorkbenchArtifactService.ts'
import { WorkbenchArtifactCoordinator } from './workbench/WorkbenchArtifactCoordinator.ts'
import {
	WorkbenchContentArtifactService,
	type WorkbenchContentArtifactLookup,
} from './workbench/WorkbenchContentArtifactService.ts'
import { WorkbenchProducerStatusService } from './workbench/WorkbenchProducerStatusService.ts'
import { WorkbenchRegistry } from './workbench/WorkbenchRegistry.ts'
import {
	expireWorkbenchSession,
	WorkbenchSessionTarget,
	workbenchSessionSignal,
} from './workbench/WorkbenchSessionTarget.ts'
import { resolveContextCapability } from '@pluxel/core/host'
import { WorkbenchHost } from '../token'
import { loadPackagedWorkbenchDeployment } from './workbench/packaged-artifact.ts'

export type WorkbenchServerSession = Readonly<{
	target: WorkbenchSessionApi
	signal: AbortSignal
	dispose(): void
}>

export class WorkbenchBackend {
	readonly application: HostApplicationMeta
	readonly artifacts: WorkbenchArtifactService
	readonly content: WorkbenchContentArtifactService
	readonly artifactCoordinator: WorkbenchArtifactCoordinator
	readonly producerStatus: WorkbenchProducerStatusService
	readonly registry: WorkbenchRegistry
	private preparation?: Promise<void>

	constructor(
		root: Context,
		private readonly options: WorkbenchInstallOptions,
		registryArtifacts?: WorkbenchArtifactLookup,
		registryContent?: WorkbenchContentArtifactLookup,
	) {
		this.application = Object.freeze({
			product:
				options.product === undefined || options.product === null
					? null
					: readProductDescriptor(options.product, '[workbench] product'),
		})
		this.artifacts = new WorkbenchArtifactService(root)
		this.content = new WorkbenchContentArtifactService(root)
		this.artifactCoordinator = new WorkbenchArtifactCoordinator(root, this.artifacts, this.content)
		this.producerStatus = new WorkbenchProducerStatusService()
		this.registry = new WorkbenchRegistry(
			root,
			registryArtifacts ?? this.artifacts,
			registryContent ?? this.content,
			this.producerStatus,
		)
	}

	/** Loads the immutable production producer inventory before Plugin startup. */
	prepare(): Promise<void> {
		if (!this.options.artifacts?.root) return Promise.resolve()
		const existing = this.preparation
		if (existing) return existing
		let task!: Promise<void>
		task = loadPackagedWorkbenchDeployment(this.artifactCoordinator, this.options.artifacts.root)
			.then((): void => undefined)
			.catch((error: unknown) => {
				if (this.preparation === task) this.preparation = undefined
				throw error
			})
		this.preparation = task
		return task
	}

	publish<const Definition extends AnyWorkbenchDefinition>(
		owner: Context,
		definition: Definition,
		...bindings: WorkbenchPublishBindings<Definition>
	): void {
		this.registry.publish(owner, definition, ...bindings)
	}

	createSession(
		principal: WorkbenchPrincipal,
		invalidate: (cause: Error) => void,
	): WorkbenchServerSession {
		const identity = parsePrincipal(principal)
		let active = true
		let unsubscribeRegistry = (): void => {}
		let unsubscribeArtifacts = (): void => {}
		const target = new WorkbenchSessionTarget(this.registry, identity, () => {
			if (!active) return
			active = false
			unsubscribeRegistry()
			unsubscribeArtifacts()
		})
		const expire = (cause: Error) => {
			if (!active) return
			expireWorkbenchSession(target, cause)
			try {
				invalidate(cause)
			} catch {
				// Carrier cleanup remains authoritative if an observer itself fails.
			}
		}
		unsubscribeRegistry = this.registry.subscribe((_revision, cause) => {
			if (cause === 'producer-status') return
			expire(new Error('Workbench publication changed'))
		})
		unsubscribeArtifacts = this.artifactCoordinator.subscribe(() =>
			expire(new Error('Workbench artifact revision changed')),
		)

		return Object.freeze({
			target,
			signal: workbenchSessionSignal(target),
			dispose: () => target[Symbol.dispose](),
		})
	}
}

export type WorkbenchInstallOptions = Readonly<{
	product?: ProductDescriptor | null
	artifacts?: Readonly<{ root?: string }>
}>

/** @internal */
export function requireWorkbench(ctx: Context): WorkbenchBackend {
	if (ctx !== ctx.root) throw new TypeError('[workbench] backend requires root Context')
	return resolveContextCapability(ctx, WorkbenchHost)
}

/** Optional host detection preserves backend construction failures. */
export function optionalWorkbench(ctx: Context): WorkbenchBackend | undefined {
	try {
		return requireWorkbench(ctx)
	} catch (error) {
		if (error instanceof ContextCapabilityMissingError && error.capability === 'workbench.host')
			return undefined
		throw error
	}
}

function parsePrincipal(input: WorkbenchPrincipal): WorkbenchPrincipal {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError('[workbench] principal must be an object')
	}
	const keys = Object.keys(input).sort()
	if (
		keys.some((key) => !['displayName', 'provider', 'subject'].includes(key)) ||
		!keys.includes('provider') ||
		!keys.includes('subject')
	) {
		throw new TypeError('[workbench] principal has an invalid shape')
	}
	if (
		typeof input.provider !== 'string' ||
		!input.provider ||
		input.provider.length > 128 ||
		input.provider.trim() !== input.provider ||
		typeof input.subject !== 'string' ||
		!input.subject ||
		input.subject.length > 1_024 ||
		input.subject.trim() !== input.subject ||
		(input.displayName !== undefined &&
			(typeof input.displayName !== 'string' ||
				!input.displayName ||
				input.displayName.length > 256 ||
				input.displayName.trim() !== input.displayName))
	) {
		throw new TypeError('[workbench] principal has invalid fields')
	}
	return Object.freeze({
		provider: input.provider,
		subject: input.subject,
		...(input.displayName === undefined ? {} : { displayName: input.displayName }),
	})
}
