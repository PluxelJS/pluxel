import { type ArgValues, define } from 'gunshi'
import { resolve } from 'pathe'

const securityRootArgs = {
	root: {
		type: 'string',
		description: 'Workspace root',
		default: '.',
	},
} as const

const verificationModeArgs = {
	...securityRootArgs,
	mode: {
		type: 'positional',
		description: 'Verification mode: enforce or bypass',
	},
} as const

const verificationMethodArgs = {
	...securityRootArgs,
	method: {
		type: 'positional',
		description: 'Verification method: password, otp, or passkey',
	},
} as const

const verificationUserArgs = {
	...securityRootArgs,
	username: {
		type: 'positional',
		description: 'Verification username',
	},
} as const

const verificationUserSetArgs = {
	...verificationUserArgs,
	password: {
		type: 'string',
		description: 'Verification password',
	},
} as const

const verificationResetArgs = {
	...securityRootArgs,
	mode: {
		type: 'string',
		description: 'Reset mode (default: bypass)',
		default: 'bypass',
	},
} as const

type SecurityRootValues = ArgValues<typeof securityRootArgs>
type VerificationModeValues = ArgValues<typeof verificationModeArgs>
type VerificationMethodValues = ArgValues<typeof verificationMethodArgs>
type VerificationUserValues = ArgValues<typeof verificationUserArgs>
type VerificationUserSetValues = ArgValues<typeof verificationUserSetArgs>
type VerificationResetValues = ArgValues<typeof verificationResetArgs>
type RuntimeSecurityServices = typeof import('@pluxel/runtime/services')
type LocalVerificationSnapshot = import('@pluxel/runtime/services').LocalVerificationSnapshot

let runtimeSecurityServicesPromise: Promise<RuntimeSecurityServices> | null = null

function resolveRootDir(values: SecurityRootValues): string {
	return resolve(process.cwd(), values.root || '.')
}

function assertMode(value: string | undefined): 'enforce' | 'bypass' {
	if (value === 'enforce' || value === 'bypass') return value
	throw new Error('Mode must be "enforce" or "bypass".')
}

function assertMethod(value: string | undefined): 'password' | 'otp' | 'passkey' {
	if (value === 'password' || value === 'otp' || value === 'passkey') return value
	throw new Error('Method must be "password", "otp", or "passkey".')
}

async function loadRuntimeSecurityServices(): Promise<RuntimeSecurityServices> {
	if (!runtimeSecurityServicesPromise) {
		runtimeSecurityServicesPromise = import('@pluxel/runtime/services')
	}
	return await runtimeSecurityServicesPromise
}

function printSnapshot(
	log: (...args: unknown[]) => void,
	snapshot: LocalVerificationSnapshot,
) {
	log(`identity: ${snapshot.path}`)
	log(`mode: ${snapshot.mode}`)
	log(`method: ${snapshot.method}`)
	log(`users: ${snapshot.users.length > 0 ? snapshot.users.map((user) => user.username).join(', ') : '(none)'}`)
}

const verificationShowCommand = define({
	name: 'show',
	description: 'Show offline verification identity state',
	toKebab: true,
	args: securityRootArgs,
	async run(ctx) {
		const runtimeSecurity = await loadRuntimeSecurityServices()
		printSnapshot(
			ctx.log,
			await runtimeSecurity.describeLocalVerification(resolveRootDir(ctx.values as SecurityRootValues)),
		)
	},
})

const verificationModeCommand = define({
	name: 'mode',
	description: 'Set offline verification mode',
	toKebab: true,
	args: verificationModeArgs,
	async run(ctx) {
		const values = ctx.values as VerificationModeValues
		const runtimeSecurity = await loadRuntimeSecurityServices()
		const snapshot = await runtimeSecurity.setLocalVerificationMode(
			resolveRootDir(values),
			assertMode(values.mode),
		)
		printSnapshot(ctx.log, snapshot)
	},
})

const verificationMethodCommand = define({
	name: 'method',
	description: 'Set offline verification method (clears incompatible users)',
	toKebab: true,
	args: verificationMethodArgs,
	async run(ctx) {
		const values = ctx.values as VerificationMethodValues
		const runtimeSecurity = await loadRuntimeSecurityServices()
		const snapshot = await runtimeSecurity.setLocalVerificationMethod(
			resolveRootDir(values),
			assertMethod(values.method),
		)
		printSnapshot(ctx.log, snapshot)
	},
})

const verificationUserSetCommand = define({
	name: 'set',
	description: 'Create or replace an offline password verification user',
	toKebab: true,
	args: verificationUserSetArgs,
	async run(ctx) {
		const values = ctx.values as VerificationUserSetValues
		if (!values.username) throw new Error('Please provide a username.')
		if (!values.password) throw new Error('Please provide --password.')
		const runtimeSecurity = await loadRuntimeSecurityServices()
		const snapshot = await runtimeSecurity.upsertLocalVerificationPasswordUser(resolveRootDir(values), {
			username: values.username,
			password: values.password,
		})
		printSnapshot(ctx.log, snapshot)
	},
})

const verificationUserDeleteCommand = define({
	name: 'delete',
	description: 'Delete an offline verification user',
	toKebab: true,
	args: verificationUserArgs,
	async run(ctx) {
		const values = ctx.values as VerificationUserValues
		if (!values.username) throw new Error('Please provide a username.')
		const runtimeSecurity = await loadRuntimeSecurityServices()
		const snapshot = await runtimeSecurity.deleteLocalVerificationUser(
			resolveRootDir(values),
			values.username,
		)
		printSnapshot(ctx.log, snapshot)
	},
})

const verificationUserCommand = define({
	name: 'user',
	description: 'Manage offline verification users',
	toKebab: true,
	args: securityRootArgs,
	subCommands: new Map([
		['set', verificationUserSetCommand],
		['delete', verificationUserDeleteCommand],
	]),
	async run() {
		throw new Error('Use `pluxel security verification user set|delete`.')
	},
})

const verificationResetCommand = define({
	name: 'reset',
	description: 'Clear all offline verification users and set a recovery mode',
	toKebab: true,
	args: verificationResetArgs,
	async run(ctx) {
		const values = ctx.values as VerificationResetValues
		const runtimeSecurity = await loadRuntimeSecurityServices()
		const snapshot = await runtimeSecurity.resetLocalVerification(
			resolveRootDir(values),
			assertMode(values.mode),
		)
		printSnapshot(ctx.log, snapshot)
	},
})

const verificationCommand = define({
	name: 'verification',
	description: 'Manage offline verification identity data',
	toKebab: true,
	args: securityRootArgs,
	subCommands: new Map([
		['show', verificationShowCommand],
		['mode', verificationModeCommand],
		['method', verificationMethodCommand],
		['user', verificationUserCommand],
		['reset', verificationResetCommand],
	]),
	async run(ctx) {
		const runtimeSecurity = await loadRuntimeSecurityServices()
		printSnapshot(
			ctx.log,
			await runtimeSecurity.describeLocalVerification(resolveRootDir(ctx.values as SecurityRootValues)),
		)
	},
})

export const securityCommand = define({
	name: 'security',
	description: 'Offline security identity management',
	toKebab: true,
	args: securityRootArgs,
	subCommands: new Map([['verification', verificationCommand]]),
	async run() {
		throw new Error('Use `pluxel security verification ...`.')
	},
})
