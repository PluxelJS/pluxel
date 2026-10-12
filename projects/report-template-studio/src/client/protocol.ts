import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { rpcError } from '../rpc/errors.js'

export const STUDIO_PROTOCOL_VERSION = 1
export const HANDSHAKE_TIMEOUT_MS = 1500
export const DESCRIPTOR_MAX_BYTES = 16 * 1024

/** A discovered, selected instance; credentials remain inside the private descriptor. */
export interface StudioInstance {
	instanceId: string
	root: string
	pid: number
	platform: NodeJS.Platform
	address: string
	protocolVersion: number
	discoveryDirectory: string
}
export interface StudioDescriptor extends Omit<StudioInstance, 'discoveryDirectory'> {
	token: string
}
export interface DiscoverStudioOptions {
	discoveryDirectory?: string
}

export function studioUserKey(): string {
	const user = userInfo()
	return createHash('sha256')
		.update(`${process.platform}:${user.uid >= 0 ? user.uid : user.username}`)
		.digest('hex')
		.slice(0, 20)
}

export function studioDiscoveryDirectory(directory?: string): string {
	return directory === undefined
		? join(tmpdir(), `pluxel-report-template-studio-${studioUserKey()}`, 'instances')
		: resolve(directory)
}

const runFile = promisify(execFile)
async function windowsPrivatePath(path: string, created: boolean): Promise<void> {
	// Windows ACLs, rather than chmod, establish the current-user boundary.
	const script = `
$ErrorActionPreference = 'Stop'
$path = $env:STUDIO_PRIVATE_DIRECTORY
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($env:STUDIO_PRIVATE_DIRECTORY_CREATED -eq 'yes') {
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $path -AclObject $acl
}
$acl = Get-Acl -LiteralPath $path
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Studio discovery directory has a different owner' }
foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -ne $sid.Value) { throw 'Studio discovery directory grants access to another identity' }
}
`
	try {
		await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
			env: {
				...process.env,
				STUDIO_PRIVATE_DIRECTORY: path,
				STUDIO_PRIVATE_DIRECTORY_CREATED: created ? 'yes' : 'no',
			},
			timeout: 10000,
			maxBuffer: 4096,
		})
	} catch {
		throw rpcError(
			'INVALID_DISCOVERY_DIRECTORY',
			'Studio discovery directory must grant access only to the current Windows user',
		)
	}
}

export async function checkPrivateDirectory(path: string, create = false): Promise<string> {
	let created = false
	if (create) {
		try {
			created = (await mkdir(path, { recursive: true, mode: 0o700 })) !== undefined
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
		}
	}
	const stat = await lstat(path)
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw rpcError(
			'INVALID_DISCOVERY_DIRECTORY',
			'Studio discovery directory must be a real directory',
		)
	if (process.platform === 'win32') await windowsPrivatePath(path, created)
	else if (stat.uid !== userInfo().uid || (stat.mode & 0o077) !== 0)
		throw rpcError(
			'INVALID_DISCOVERY_DIRECTORY',
			'Studio discovery directory must be owned by the current user with mode 0700',
		)
	return realpath(path)
}

export function validInstanceId(value: unknown): value is string {
	return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
}

export function descriptorFile(directory: string, instanceId: string): string {
	if (!validInstanceId(instanceId))
		throw rpcError('INSTANCE_CHANGED', 'Studio instance identity is invalid; discover again')
	return join(directory, `${instanceId}.json`)
}

export async function readDescriptor(
	directory: string,
	instanceId: string,
): Promise<StudioDescriptor> {
	const file = descriptorFile(directory, instanceId)
	const before = await lstat(file)
	if (!before.isFile() || before.isSymbolicLink())
		throw rpcError(
			'INVALID_DISCOVERY_RECORD',
			'Studio descriptor must be a regular file without symbolic links',
		)
	if (process.platform === 'win32') await windowsPrivatePath(file, false)
	const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
	try {
		const stat = await handle.stat()
		if (
			!stat.isFile() ||
			stat.dev !== before.dev ||
			stat.ino !== before.ino ||
			stat.size > DESCRIPTOR_MAX_BYTES ||
			(process.platform !== 'win32' && (stat.uid !== userInfo().uid || (stat.mode & 0o077) !== 0))
		)
			throw rpcError(
				'INVALID_DISCOVERY_RECORD',
				'Studio descriptor is not a private, bounded regular file',
			)
		const buffer = Buffer.alloc(DESCRIPTOR_MAX_BYTES + 1)
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
		if (bytesRead > DESCRIPTOR_MAX_BYTES)
			throw rpcError('INVALID_DISCOVERY_RECORD', 'Studio descriptor is too large')
		let value: unknown
		try {
			value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))
		} catch {
			// JSON.parse messages can quote the offending bytes, including a credential.
			throw rpcError('INVALID_DISCOVERY_RECORD', 'Studio descriptor contains invalid JSON')
		}
		if (!value || typeof value !== 'object') throw new Error('Invalid record')
		const record = value as Record<string, unknown>
		const localAddress =
			typeof record.address === 'string' &&
			(process.platform === 'win32'
				? record.address.startsWith('\\\\.\\pipe\\pluxel-report-template-studio-')
				: isAbsolute(record.address) && Buffer.byteLength(record.address) <= 100)
		if (
			record.instanceId !== instanceId ||
			!validInstanceId(record.instanceId) ||
			typeof record.root !== 'string' ||
			!isAbsolute(record.root) ||
			!Number.isSafeInteger(record.pid) ||
			Number(record.pid) <= 0 ||
			record.platform !== process.platform ||
			record.protocolVersion !== STUDIO_PROTOCOL_VERSION ||
			!localAddress ||
			typeof record.token !== 'string' ||
			!/^[0-9a-f]{64}$/.test(record.token)
		)
			throw rpcError(
				'INVALID_DISCOVERY_RECORD',
				'Studio descriptor has an invalid protocol or identity',
			)
		return record as unknown as StudioDescriptor
	} finally {
		await handle.close()
	}
}

export function publicInstance(
	record: StudioDescriptor,
	discoveryDirectory: string,
): StudioInstance {
	return {
		instanceId: record.instanceId,
		root: record.root,
		pid: record.pid,
		platform: record.platform,
		address: record.address,
		protocolVersion: record.protocolVersion,
		discoveryDirectory,
	}
}

export function sameInstance(
	a: Omit<StudioInstance, 'discoveryDirectory'>,
	b: Omit<StudioInstance, 'discoveryDirectory'>,
): boolean {
	return (
		a.instanceId === b.instanceId &&
		a.root === b.root &&
		a.pid === b.pid &&
		a.platform === b.platform &&
		a.address === b.address &&
		a.protocolVersion === b.protocolVersion
	)
}
