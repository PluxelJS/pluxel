import { defineContextCapability, type ContextCapability } from '@pluxel/core/internal'
import type { RuntimeStateStore } from '../services/RuntimeStateStore'

/** Runtime host authority shared by route coordination and management use cases. */
export const RUNTIME_STATE_CAPABILITY: ContextCapability<RuntimeStateStore> =
	defineContextCapability('runtime.state')
