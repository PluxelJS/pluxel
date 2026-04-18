import { createNodeFsServiceBackend } from '../fs/FsService'
import {
	DEFAULT_VERIFICATION_METHOD,
	deleteVerificationUser,
	listVerificationUsers,
	normalizeVerificationUsername,
	requireVerificationPassword,
	resolveVerificationConfig,
	setVerificationConfigMethod,
	setVerificationConfigMode,
	upsertPasswordUser,
} from '../verification/model'
import { hashPasswordScrypt } from '../verification/password'
import type {
	VerificationConfig,
	VerificationMethod,
	VerificationMode,
	VerificationUser,
} from '../verification/types'
import {
	readSecurityIdentity,
	securityIdentityPath,
	updateSecurityIdentity,
} from './identity'

const nodeFs = createNodeFsServiceBackend()

export type LocalVerificationSnapshot = {
	path: string
	mode: VerificationMode
	method: VerificationMethod
	users: VerificationUser[]
}

function toSnapshot(
	rootDir: string,
	verification?: VerificationConfig | {
		mode?: VerificationMode
		method?: VerificationMethod
		users?: unknown[]
	},
): LocalVerificationSnapshot {
	const config = resolveVerificationConfig(verification)
	return {
		path: securityIdentityPath(rootDir),
		mode: config.mode,
		method: config.method,
		users: listVerificationUsers(config),
	}
}

async function updateLocalVerification(
	rootDir: string,
	update: (config: VerificationConfig) => VerificationConfig,
): Promise<LocalVerificationSnapshot> {
	const next = await updateSecurityIdentity(
		nodeFs,
		(current) => ({
			...current,
			verification: update(resolveVerificationConfig(current.verification)),
		}),
		rootDir,
	)
	return toSnapshot(rootDir, next.verification)
}

export async function describeLocalVerification(
	rootDir: string,
): Promise<LocalVerificationSnapshot> {
	const identity = await readSecurityIdentity(nodeFs, rootDir)
	return toSnapshot(rootDir, identity.verification)
}

export async function setLocalVerificationMode(
	rootDir: string,
	mode: VerificationMode,
): Promise<LocalVerificationSnapshot> {
	return await updateLocalVerification(rootDir, (config) => setVerificationConfigMode(config, mode))
}

export async function setLocalVerificationMethod(
	rootDir: string,
	method: VerificationMethod,
): Promise<LocalVerificationSnapshot> {
	return await updateLocalVerification(rootDir, (config) => setVerificationConfigMethod(config, method))
}

export async function upsertLocalVerificationPasswordUser(
	rootDir: string,
	input: { username: string; password: string },
): Promise<LocalVerificationSnapshot> {
	const username = normalizeVerificationUsername(input.username)
	const password = requireVerificationPassword(input.password)
	if (!username) throw new Error('Username is required.')

	return await updateLocalVerification(rootDir, (config) =>
		upsertPasswordUser(setVerificationConfigMethod(config, DEFAULT_VERIFICATION_METHOD), {
			username,
			passwordHash: hashPasswordScrypt(password),
		}),
	)
}

export async function deleteLocalVerificationUser(
	rootDir: string,
	usernameInput: string,
): Promise<LocalVerificationSnapshot> {
	const username = normalizeVerificationUsername(usernameInput)
	if (!username) throw new Error('Username is required.')

	return await updateLocalVerification(rootDir, (config) => deleteVerificationUser(config, username))
}

export async function resetLocalVerification(
	rootDir: string,
	mode: VerificationMode = 'bypass',
): Promise<LocalVerificationSnapshot> {
	return await updateLocalVerification(rootDir, (config) => ({
		...config,
		mode,
		users: [],
	}))
}
