type RuntimeGlobals = typeof globalThis & {
	process?: { env?: { NODE_ENV?: string } }
	__DEV__?: boolean
}

export function isDevelopmentEnvironment(): boolean {
	const runtime = globalThis as RuntimeGlobals
	const nodeEnv = runtime.process?.env?.NODE_ENV
	if (nodeEnv) return nodeEnv !== 'production'
	if (runtime.__DEV__ !== undefined) return runtime.__DEV__
	return true
}
