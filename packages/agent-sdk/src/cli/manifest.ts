import { define, isCommandNotFoundError, lazy, type SubCommandable } from 'gunshi'

// Gunshi resolves selected lazy loaders even for help; import command bodies only when run.

export const scriptConnectionArgs = {
	'credentials-file': {
		type: 'string',
		description: 'Private JSON file containing password, code or session cookie',
	},
} as const
const receiptFileArg = {
	type: 'string',
	description: 'Save the original receipt to a new private file before submitting the operation',
} as const

export const scriptRunArgs = {
	...scriptConnectionArgs,
	file: {
		type: 'positional',
		required: true,
		description: 'Portable TypeScript module to compile and upload',
	},
	endpoint: {
		type: 'string',
		required: true,
		description: 'HTTP(S) origin or runtime session WebSocket URL',
	},
	export: { type: 'string', default: 'default', description: 'Exported function to call' },
	input: { type: 'string', description: 'Explicit JSON input' },
	'input-file': { type: 'string', description: 'Read explicit JSON input from this file' },
	timeout: {
		type: 'string',
		default: '30000',
		description: 'Cooperative execution deadline in milliseconds (1–300000)',
	},
	detach: {
		type: 'boolean',
		default: false,
		description: 'Return after admission without waiting for settlement',
	},
	'receipt-file': receiptFileArg,
} as const
export const scriptReceiptArgs = {
	...scriptConnectionArgs,
	receipt: {
		type: 'positional',
		required: false,
		description: 'Complete receipt returned by script run, dev run or dev hmr',
	},
	'receipt-file': {
		type: 'string',
		description: 'Read the original receipt from this file instead of the positional receipt',
	},
} as const
export const scriptRunDefinition = {
	name: 'run',
	description: 'Compile and execute a trusted script on an explicitly enabled Host',
	args: scriptRunArgs,
} as const
export const scriptSyncArgs = {
	...scriptConnectionArgs,
	endpoint: {
		type: 'string',
		required: true,
		description: 'Authenticated HTTP(S) origin or runtime session WebSocket URL',
	},
	out: {
		type: 'string',
		default: '.pluxel/control',
		description:
			'Tool-owned Plugin contract directory; import each definition using its returned module path',
	},
} as const
export const scriptSyncDefinition = {
	name: 'sync',
	description: 'Download and verify committed Plugin contracts without enabling code execution',
	args: scriptSyncArgs,
} as const
export const scriptResultDefinition = {
	name: 'result',
	description: 'Query the original script owner without resubmitting',
	args: scriptReceiptArgs,
} as const
export const scriptCancelDefinition = {
	name: 'cancel',
	description: 'Request cooperative cancellation at the original script owner',
	args: scriptReceiptArgs,
} as const
export const scriptCommand = define({
	name: 'script',
	description:
		'Read Plugin contracts and execute trusted TypeScript on an authenticated deployment',
	args: {},
	subCommands: new Map<string, SubCommandable>([
		[
			'sync',
			lazy(
				() => (ctx) => import('./script-sync').then((module) => module.scriptSyncCommand.run!(ctx)),
				scriptSyncDefinition,
			),
		],
		[
			'run',
			lazy(
				() => (ctx) => import('./script').then((module) => module.scriptRunCommand.run!(ctx)),
				scriptRunDefinition,
			),
		],
		[
			'result',
			lazy(
				() => (ctx) => import('./script').then((module) => module.scriptResultCommand.run!(ctx)),
				scriptResultDefinition,
			),
		],
		[
			'cancel',
			lazy(
				() => (ctx) => import('./script').then((module) => module.scriptCancelCommand.run!(ctx)),
				scriptCancelDefinition,
			),
		],
	]),
	async run(ctx) {
		const { validateCommandOptions } = await import('./options')
		const { printCommandFailure } = await import('./output')
		try {
			await validateCommandOptions(ctx)
			throw new Error('Choose a script command; use pluxel script --help')
		} catch (error) {
			await printCommandFailure(ctx.log, error, true)
		}
	},
})

export const devCommonArgs = {
	profile: {
		type: 'string',
		description: 'Named pluxel.dev profile; defaults to configured default or the sole profile',
	},
	root: {
		type: 'string',
		description:
			'Project directory from which to find dev profiles (defaults to current directory)',
	},
	instance: {
		type: 'string',
		description: 'Exact running instance when a Vite root has multiple consoles',
	},
} as const

/** Gunshi routes raw positionals before resolving option values on commands with children. */
export function normalizeDevArgs(argv: string[]): string[] {
	if (argv[0] !== 'dev') return argv
	const normalized: string[] = []
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index]!
		if (argument === '--') return [...normalized, ...argv.slice(index)]
		const next = argv[index + 1]
		if (
			argument.startsWith('--') &&
			Object.hasOwn(devCommonArgs, argument.slice(2)) &&
			next !== undefined &&
			!next.startsWith('-')
		) {
			normalized.push(`${argument}=${next}`)
			index++
		} else normalized.push(argument)
	}
	return normalized
}

export const devInstancesDefinition = {
	name: 'instances',
	description: 'Discover running consoles in the selected Vite root',
	args: devCommonArgs,
} as const

const devExecutionArgs = {
	detach: { type: 'boolean', default: false, description: 'Return the receipt without waiting' },
	'receipt-file': receiptFileArg,
	timeout: {
		type: 'string',
		default: '30000',
		description: 'Cooperative operation deadline in milliseconds (1–300000)',
	},
} as const

export const devHmrArgs = {
	...devCommonArgs,
	...devExecutionArgs,
	action: { type: 'positional', required: true, description: 'pause, apply or resume' },
} as const

export const devHmrDefinition = {
	name: 'hmr',
	description: 'Control Host HMR batches without loading project code; return an operation receipt',
	args: devHmrArgs,
} as const

export const devRunArgs = {
	...devCommonArgs,
	...devExecutionArgs,
	file: {
		type: 'positional',
		required: true,
		description:
			'TypeScript module inside the selected Vite root; path is relative to current directory',
	},
	export: { type: 'string', default: 'default', description: 'Exported function to call' },
	input: { type: 'string', description: 'JSON input passed to the execution context' },
	'input-file': { type: 'string', description: 'Read JSON input from this file' },
} as const

export const devRunDefinition = {
	name: 'run',
	description:
		'Execute in a running application; print final JSON and a receipt pinned to the original instance',
	toKebab: true,
	args: devRunArgs,
} as const
export const devSyncArgs = {
	...devCommonArgs,
	out: {
		type: 'string',
		description:
			'Tool-owned contract directory; defaults to the selected Vite root .pluxel/control',
	},
} as const
export const devSyncDefinition = {
	name: 'sync',
	description: 'Download committed Plugin contracts from the selected development console',
	args: devSyncArgs,
} as const

export const devSubCommands = new Map<string, SubCommandable>([
	[
		'sync',
		lazy(
			() => (ctx) => import('./dev-sync').then((module) => module.devSyncCommand.run!(ctx)),
			devSyncDefinition,
		),
	],
	[
		'instances',
		lazy(
			() => (ctx) => import('./dev').then((module) => module.devInstancesCommand.run!(ctx)),
			devInstancesDefinition,
		),
	],
	[
		'hmr',
		lazy(
			() => (ctx) => import('./dev').then((module) => module.devHmrCommand.run!(ctx)),
			devHmrDefinition,
		),
	],
	[
		'run',
		lazy(
			() => (ctx) => import('./dev').then((module) => module.devRunCommand.run!(ctx)),
			devRunDefinition,
		),
	],
])

/** The script family and mounted dev operations promise one final control JSON envelope. */
export function isControlCommandPath(path: readonly string[], validationError?: unknown): boolean {
	if (path[0] === 'script') return true
	if (path[0] !== 'dev') return false
	if (path.length === 1) {
		const errors =
			validationError instanceof AggregateError ? validationError.errors : [validationError]
		return errors.some(isCommandNotFoundError)
	}
	// Status is mounted by CLI because it also queries services without a script Host.
	return path.length === 2 && (path[1] === 'status' || devSubCommands.has(path[1]!))
}
