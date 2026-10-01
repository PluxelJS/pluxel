export type Logger = {
	trace: (...arguments_: unknown[]) => void
	debug: (...arguments_: unknown[]) => void
	info: (...arguments_: unknown[]) => void
	warn: (...arguments_: unknown[]) => void
	error: (...arguments_: unknown[]) => void
	fatal: (...arguments_: unknown[]) => void
}

const bindConsoleMethod = (
	method: ((...arguments_: unknown[]) => void) | undefined,
) => (method ?? console.log).bind(console)

export const defaultLogger: Logger = {
	info: console.info.bind(console),
	warn: console.warn.bind(console),
	error: console.error.bind(console),
	debug: bindConsoleMethod(console.debug),
	trace: bindConsoleMethod(console.trace),
	fatal: console.error.bind(console),
}
