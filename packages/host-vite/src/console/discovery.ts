import type { SCRIPT_PROTOCOL } from '@pluxel/host/agent'

/** Private local discovery metadata. Credentials never enter a receipt or public status. */
export type ProjectScriptInstance = Readonly<{
	protocol: typeof SCRIPT_PROTOCOL
	instanceId: string
	nonce: string
	pid: number
	root: string
	serviceId?: string
	profile?: string
	project?: string
	socketPath: string
	startedAt: string
}>
