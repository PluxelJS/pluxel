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
