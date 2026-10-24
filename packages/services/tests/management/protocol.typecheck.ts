import { expectTypeOf } from 'vitest'
import type {
	PluginDependencyGraphEdge,
	PluginDependencyGraphSnapshot,
	RuntimeManagementClient,
} from '@pluxel/services/management/client'
import type {
	ConfigResult,
	ConfigPresentationResult,
	EnsureForkResult,
	PluginDependencyMutationResult,
	PluginControlMutationResult,
	PluginLifecycleCommand,
	RemoveForkResult,
} from '../../src/management/web/protocol'

expectTypeOf<PluginLifecycleCommand>().toEqualTypeOf<'start' | 'stop' | 'restart'>()

type ControlResult =
	| ConfigResult
	| ConfigPresentationResult
	| EnsureForkResult
	| PluginDependencyMutationResult
	| PluginControlMutationResult
	| RemoveForkResult
expectTypeOf<Extract<ControlResult, { ok: false; code: 'internal_error' }>>().toEqualTypeOf<never>()

expectTypeOf<ReturnType<RuntimeManagementClient['dependencies']['graph']>>().toEqualTypeOf<
	Promise<PluginDependencyGraphSnapshot>
>()
expectTypeOf<
	Extract<PluginDependencyGraphEdge, { mode: 'optional'; resolution: { state: 'unresolved' } }>
>().toEqualTypeOf<never>()
expectTypeOf<
	Extract<PluginDependencyGraphEdge, { resolution: { state: 'unresolved' }; effective: true }>
>().toEqualTypeOf<never>()
