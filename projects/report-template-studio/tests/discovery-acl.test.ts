import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkPrivateDirectory, readDescriptor } from '../src/client/protocol.js'

const platform = process.platform
const runFile = promisify(execFile)
const cleanup: string[] = []
// Preserve this owner's integration-test budget when using the root Vite config.
const testTimeout = 60000

afterEach(async () => {
	vi.unstubAllGlobals()
	while (cleanup.length > 0) await rm(cleanup.pop()!, { recursive: true, force: true })
})

async function sandbox() {
	const directory = await mkdtemp(join(tmpdir(), 'studio-discovery-acl-'))
	cleanup.push(directory)
	return directory
}

describe('private discovery directory boundaries', () => {
	it(
		'creates a private directory and accepts it again without recreation',
		async () => {
			const directory = join(await sandbox(), 'instances')
			expect(await checkPrivateDirectory(directory, true)).toBe(await realpath(directory))
			expect(await checkPrivateDirectory(directory)).toBe(await realpath(directory))
		},
		testTimeout,
	)

	it(
		'accepts a descriptor that inherits the private directory access boundary',
		async () => {
			const directory = await checkPrivateDirectory(join(await sandbox(), 'instances'), true)
			const instanceId = randomUUID()
			const descriptor = {
				instanceId,
				root: join(directory, 'state'),
				pid: process.pid,
				platform,
				protocolVersion: 1,
				token: '0'.repeat(64),
				address:
					platform === 'win32'
						? `\\\\.\\pipe\\pluxel-report-template-studio-${instanceId}`
						: '/tmp/studio-discovery-acl.sock',
			}
			await writeFile(join(directory, `${instanceId}.json`), JSON.stringify(descriptor), {
				mode: 0o600,
			})
			expect(await readDescriptor(directory, instanceId)).toEqual(descriptor)
		},
		testTimeout,
	)

	it.skipIf(platform === 'win32')(
		'rejects an existing public directory without repairing its mode',
		async () => {
			const directory = join(await sandbox(), 'instances')
			await mkdir(directory)
			await chmod(directory, 0o755)
			await expect(checkPrivateDirectory(directory, true)).rejects.toMatchObject({
				code: 'INVALID_DISCOVERY_DIRECTORY',
			})
			const after = await stat(directory)
			expect(after.mode & 0o777).toBe(0o755)
		},
	)

	it.skipIf(platform === 'win32')(
		'retains the actual child exit code and stderr as the validation error cause',
		async () => {
			const directory = await sandbox()
			const executables = join(directory, 'bin')
			await mkdir(executables)
			await writeFile(
				join(executables, 'powershell.exe'),
				'#!/bin/sh\nprintf "discovery ACL child failure\\n" >&2\nexit 7\n',
				{ mode: 0o700 },
			)
			vi.stubGlobal('process', {
				...process,
				platform: 'win32',
				env: { ...process.env, PATH: executables },
			})
			await expect(checkPrivateDirectory(join(directory, 'instances'), true)).rejects.toMatchObject(
				{
					code: 'INVALID_DISCOVERY_DIRECTORY',
					cause: { code: 7, stderr: 'discovery ACL child failure\n' },
				},
			)
		},
	)

	it.runIf(platform === 'win32')(
		'rejects an existing ACL granting another identity access without rewriting it',
		async () => {
			const directory = join(await sandbox(), 'instances')
			await mkdir(directory)
			const script = `
$ErrorActionPreference = 'Stop'
$path = $env:STUDIO_ACL_TEST_DIRECTORY
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$owner = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($owner)
$everyone = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')
$reader = New-Object System.Security.AccessControl.FileSystemAccessRule($everyone, 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($reader)
Set-Acl -LiteralPath $path -AclObject $acl
(Get-Acl -LiteralPath $path).Sddl
`
			const options = {
				env: { ...process.env, STUDIO_ACL_TEST_DIRECTORY: directory },
				timeout: 10000,
				maxBuffer: 4096,
			}
			const before = await runFile(
				'powershell.exe',
				['-NoProfile', '-NonInteractive', '-Command', script],
				options,
			)
			await expect(checkPrivateDirectory(directory, true)).rejects.toMatchObject({
				code: 'INVALID_DISCOVERY_DIRECTORY',
				cause: {
					stderr: expect.stringContaining(
						'Studio discovery directory grants access to another identity',
					),
				},
			})
			const after = await runFile(
				'powershell.exe',
				[
					'-NoProfile',
					'-NonInteractive',
					'-Command',
					'(Get-Acl -LiteralPath $env:STUDIO_ACL_TEST_DIRECTORY).Sddl',
				],
				options,
			)
			expect(after.stdout.trim()).toBe(before.stdout.trim())
		},
		testTimeout,
	)
})
