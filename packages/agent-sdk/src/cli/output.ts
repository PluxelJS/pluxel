type Log = (value: string) => void
type RunState = Readonly<{ state: string }>

export const isTerminalRun = (run: RunState): boolean =>
	['succeeded', 'failed', 'cancelled'].includes(run.state)

export function printValue(log: Log, value: unknown): void {
	log(JSON.stringify({ ok: true, value }))
}

export function printFailure(log: Log, error: object, receipt?: string): void {
	log(JSON.stringify({ ok: false, error: { ...error, ...(receipt ? { receipt } : {}) } }))
	process.exitCode = 1
}

/** Execution success and a script's returned domain Result remain distinct. */
export function printRun(log: Log, receipt: string, run: RunState, detached = false): void {
	printValue(log, { receipt, run })
	process.exitCode =
		run.state === 'failed' || run.state === 'cancelled'
			? 1
			: !detached && !isTerminalRun(run)
				? 2
				: 0
}

export function printRunProgress(stage: 'prepared' | 'accepted', receipt: string): void {
	process.stderr.write(JSON.stringify({ stage, receipt }) + '\n')
}

/** Render an operational parser failure before Gunshi's default text decorator. */
export async function printCommandFailure(
	log: Log,
	error: unknown,
	invalidInput: boolean,
): Promise<void> {
	const { scriptFailure } = await import('@pluxel/host/internal/agent/runtime')
	printFailure(log, scriptFailure(error, invalidInput ? 'invalid_input' : 'command_failed'))
}

/** Shared by agent dev commands and CLI-owned service status. */
export async function printDevFailure(log: Log, error: unknown): Promise<void> {
	const { HostClientError } = await import('../client/contracts')
	if (error instanceof HostClientError) {
		printFailure(log, error.failure, error.receipt)
		return
	}
	const { withDevContext } = await import('../client/dev')
	const failure = withDevContext(error, {})
	const context = failure.context
	printFailure(log, {
		code: failure.code,
		message: failure.message.slice(0, 8192),
		...(failure.runId ? { runId: failure.runId } : {}),
		...(context && Object.keys(context).length > 0 ? { context } : {}),
		...(failure.hint ? { hint: failure.hint } : {}),
		...(failure.candidates ? { candidates: failure.candidates } : {}),
	})
}
