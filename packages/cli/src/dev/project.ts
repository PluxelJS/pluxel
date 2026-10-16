import { execFile, spawn } from 'node:child_process'
import { access, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { DevClientError, resolveDevRoot, selectDevInstance } from './client'

const exec = promisify(execFile)
// eslint-disable-next-line no-control-regex -- Configuration and service metadata must not contain control characters.
const controlCharacters = /[\u0000-\u001f]/
const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value)

export type DevSelection = { root?: string; profile?: string; instance?: string }
export type DevProject = { workspace: string; root: string } & (
	| { profile: string; command: string; pitchfork?: never; console?: true }
	| { profile: string; pitchfork: string; command?: never; console?: boolean }
	| { profile?: never; command?: never; pitchfork?: never; console?: true }
)
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

async function exists(path: string): Promise<boolean> {
	try {
		await access(path)
		return true
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
		throw error
	}
}

/** Nearest declaration wins; never cross a repository/workspace boundary. */
export async function resolveDevProject(options: {
	root?: string
	profile?: string
}): Promise<DevProject> {
	const start = await realpath(resolve(options.root ?? process.cwd()))
	let directory = start
	let nearestPackage: string | undefined
	for (;;) {
		const manifest = resolve(directory, 'package.json')
		if (await exists(manifest)) {
			nearestPackage ??= directory
			let value: unknown
			try {
				value = JSON.parse(await readFile(manifest, 'utf8'))
			} catch {
				invalid(`Cannot read package.json at ${directory}`)
			}
			if (object(value) && object(value.pluxel) && 'dev' in value.pluxel) {
				const profiles = value.pluxel.dev
				if (!object(profiles) || Object.keys(profiles).length === 0)
					invalid(`${manifest}: pluxel.dev must contain named development profiles`)
				const names = Object.keys(profiles).filter((name) => name !== 'default')
				if (names.length === 0) invalid(`${manifest}: pluxel.dev must contain at least one profile`)
				if (
					profiles.default !== undefined &&
					(typeof profiles.default !== 'string' || !names.includes(profiles.default))
				)
					invalid(`${manifest}: pluxel.dev.default must name an existing profile`)
				for (const [name, config] of Object.entries(profiles)) {
					if (name === 'default') continue
					const label = `${manifest}: pluxel.dev.${name}`
					if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name)) invalid(`${label}: invalid profile name`)
					if (
						!object(config) ||
						Object.keys(config).some(
							(key) => !['root', 'command', 'pitchfork', 'console'].includes(key),
						)
					)
						invalid(`${label} accepts only root, command, pitchfork and console`)
					if (config.console !== undefined && typeof config.console !== 'boolean')
						invalid(`${label}.console must be a boolean`)
					if (config.console === false && config.pitchfork === undefined)
						invalid(`${label}: console: false requires a Pitchfork service`)
					for (const key of ['root', 'command', 'pitchfork']) {
						const field = config[key]
						if (
							field !== undefined &&
							(typeof field !== 'string' || !field.trim() || controlCharacters.test(field))
						)
							invalid(`${label}.${key} must be a nonempty string without control characters`)
					}
					if ((config.command === undefined) === (config.pitchfork === undefined))
						invalid(`${label}: declare exactly one command or pitchfork service`)
					if (
						typeof config.pitchfork === 'string' &&
						(!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(config.pitchfork) ||
							config.pitchfork.includes('..') ||
							config.pitchfork.includes('--'))
					)
						invalid(`${label}.pitchfork must be a short Pitchfork service name`)
					if (typeof config.root === 'string' && isAbsolute(config.root))
						invalid(`${label}.root must be relative to this package`)
				}
				const profile =
					options.profile ??
					(profiles.default as string | undefined) ??
					(names.length === 1 ? names[0] : undefined)
				if (!profile) invalid(`Choose --profile from: ${names.join(', ')}`)
				if (!names.includes(profile))
					invalid(`Unknown dev profile ${profile}; choose from: ${names.join(', ')}`)
				const config = profiles[profile] as {
					root?: string
					command?: string
					pitchfork?: string
					console?: boolean
				}
				const root = await resolveDevRoot(resolve(directory, config.root ?? '.'))
				const path = relative(directory, root)
				if (path === '..' || path.startsWith('../') || path.startsWith('..\\') || isAbsolute(path))
					invalid(`${manifest}: pluxel.dev.${profile}.root must stay inside the declaring package`)
				if (config.command !== undefined)
					return { workspace: directory, root, profile, command: config.command }
				return {
					workspace: directory,
					root,
					profile,
					pitchfork: config.pitchfork!,
					...(config.console === false ? { console: false } : {}),
				}
			}
		}
		if (
			(await exists(resolve(directory, '.git'))) ||
			(await exists(resolve(directory, 'pnpm-workspace.yaml')))
		)
			break
		const parent = dirname(directory)
		if (parent === directory) break
		directory = parent
	}
	if (options.profile !== undefined) invalid(`No pluxel.dev profiles found from ${start}`)
	const root = options.root === undefined ? (nearestPackage ?? start) : start
	return { workspace: nearestPackage ?? start, root }
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

export async function resolveDevSelection(options: DevSelection) {
	const project = await resolveDevProject(options)
	return {
		root: project.root,
		instance: options.instance,
		project,
		...(project.pitchfork
			? { service: project.pitchfork }
			: project.profile
				? { profile: project.profile, projectRoot: project.workspace }
				: {}),
	}
}

export async function connectDevProject(options: DevSelection) {
	const selection = await resolveDevSelection(options)
	requireDevConsole(selection.project)
	return selectDevInstance(selection)
}

export function requireDevConsole(project: DevProject): void {
	if (project.console === false)
		throw new DevClientError(
			'unsupported_console',
			`Profile ${project.profile} has no Pluxel development console.`,
			{
				hint: 'Use dev status for service state, or select an application profile for console operations.',
			},
		)
}
