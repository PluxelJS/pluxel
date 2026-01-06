type ProcessLike = {
	env?: Record<string, string | undefined>
	cwd?: () => string
}

function getProcessLike(): ProcessLike | undefined {
	return (globalThis as unknown as { process?: ProcessLike }).process
}

export function readEnv(name: string): string | undefined {
	return getProcessLike()?.env?.[name]
}

export function readBoolEnv(name: string): boolean | undefined {
	const raw = readEnv(name)
	if (raw === undefined) return undefined
	return raw !== '0'
}

export function tryGetCwd(): string | undefined {
	return getProcessLike()?.cwd?.()
}
