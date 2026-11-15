import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { DevClientError, type DevProject } from '@pluxel/agent-sdk/internal/client'
const exec = promisify(execFile)
// eslint-disable-next-line no-control-regex -- Service metadata must not contain control characters.
const controlCharacters = /[\u0000-\u001f]/
const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value)
export type DevService = {
	id: string
	status: string
	url?: string | null
	proxy_url?: string | null
	[key: string]: unknown
}

function invalid(message: string): never {
	throw new DevClientError('invalid_project', message)
}

/** Read Pitchfork state for managed startup or a service-only profile's status. */
export async function readDevService(project: DevProject): Promise<DevService> {
	if (!project.pitchfork) invalid('No Pitchfork service is configured for this project')
	let output: string
	try {
		const result = await exec('pitchfork', ['status', project.pitchfork, '--json'], {
			cwd: project.workspace,
			maxBuffer: 1024 * 1024,
		})
		output = result.stdout
	} catch (error) {
		throw new DevClientError(
			'service_unavailable',
			`Could not resolve Pitchfork service ${project.pitchfork}: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
	let value: unknown
	try {
		value = JSON.parse(output)
	} catch {
		invalid('Pitchfork status returned invalid JSON')
	}
	if (
		!object(value) ||
		typeof value.id !== 'string' ||
		value.id.trim() !== value.id ||
		!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.id) ||
		value.id.split('/')[1] !== project.pitchfork ||
		typeof value.status !== 'string' ||
		!value.status ||
		controlCharacters.test(value.status)
	)
		invalid('Pitchfork status did not identify the requested service')
	for (const key of ['url', 'proxy_url']) {
		const url = value[key]
		if (url === undefined || url === null) continue
		if (
			typeof url !== 'string' ||
			controlCharacters.test(url) ||
			!URL.canParse(url) ||
			!['http:', 'https:'].includes(new URL(url).protocol)
		)
			invalid(`Pitchfork status returned an invalid ${key}`)
	}
	return value as DevService
}

/** Process ownership and readiness remain with Pitchfork. */
export function startDevService(project: DevProject, service: DevService): Promise<number> {
	return new Promise((resolveExit, reject) => {
		const child = spawn('pitchfork', ['start', service.id, '--quiet'], {
			cwd: project.workspace,
			stdio: 'inherit',
		})
		child.once('error', reject)
		child.once('exit', (code, signal) => {
			if (signal) reject(new Error(`Pitchfork start terminated by ${signal}`))
			else resolveExit(code ?? 1)
		})
	})
}
