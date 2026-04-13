export type ConfigIssuePath = Array<string | number>

export interface ConfigIssue {
	message: string
	path: ConfigIssuePath
}

export type ConfigValidationErrors = Record<
	string,
	Record<string, Array<{ message: string; path: string[] }>>
>

export class ConfigValidationError extends Error {
	constructor(
		message: string,
		public readonly errors: ConfigValidationErrors,
	) {
		super(message)
		this.name = 'ConfigValidationError'
	}
}

export type SafeParseResult =
	| { success: true; output: unknown }
	| { success: false; issues: ConfigIssue[] }
