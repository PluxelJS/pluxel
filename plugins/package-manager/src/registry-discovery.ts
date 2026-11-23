import { createRequire } from 'node:module'
import { realpath, stat } from 'node:fs/promises'
import { relative, resolve, isAbsolute, sep } from 'node:path'
import { resolveExports, type PathConditions } from 'resolve-pkg-maps'
import { satisfies, valid, validRange } from 'semver'
import { EnvHttpProxyAgent, request } from 'undici'
import { manifestAt, textFile } from './local-package.ts'
import { isPackageName, record } from './package-document.ts'
import type { ResolvedConfig } from './pnpm-engine.ts'
import type { RegistryCandidate, RegistryInspection } from './contracts.ts'

const coreVersion: string = createRequire(import.meta.url)('@pluxel/core/package.json').version

export function configuredRegistry(config: ResolvedConfig, query: string) {
	const scope = /^(@[a-z0-9._~-]+)(?:\/|\s|$)/.exec(query)?.[1]
	const selected =
		config.registries.find((reg) => reg.name === scope) ??
		config.registries.find((reg) => reg.name === 'default')
	if (!selected) throw new Error('No default npm registry is configured.')
	const url = new URL(selected.url)
	if (
		!['https:', 'http:'].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		throw new Error('Configure the registry URL and credentials separately in pnpm.')
	return { url: url.href.replace(/\/$/, ''), auth: selected.authHeader, scope }
}

export async function searchRegistry(
	config: ResolvedConfig,
	query: string,
	includeAll: boolean,
	lifetime: AbortSignal,
) {
	if (typeof query !== 'string' || !query.trim() || query.length > 214)
		throw new Error('Enter a package name or keywords (up to 214 characters).')
	if (typeof includeAll !== 'boolean') throw new Error('Select a registry search mode.')
	const text = query.trim()
	const registry = configuredRegistry(config, text)
	const { scope } = registry
	// npm ranks an exact conventional plugin name ahead of generic high-download packages.
	const terms =
		includeAll || scope || /pluxel/i.test(text)
			? text
			: 'pluxel-plugin-' + text.replaceAll(/\s+/g, '-')
	const url = new URL(registry.url + '/-/v1/search')
	url.search = new URLSearchParams({ text: terms, size: '20' }).toString()
	const tls = {
		ca: config.ca,
		cert: config.cert,
		key: config.key,
		rejectUnauthorized: config.strictSsl,
	}
	const dispatcher = new EnvHttpProxyAgent({
		httpProxy: config.httpProxy,
		httpsProxy: config.httpsProxy,
		noProxy: config.noProxy === true ? '*' : config.noProxy || undefined,
		connect: tls,
		requestTls: tls,
		maxResponseSize: 1024 * 1024,
	})
	try {
		const { statusCode, body } = await request(url, {
			dispatcher,
			signal: AbortSignal.any([lifetime, AbortSignal.timeout(12000)]),
			headers: {
				accept: 'application/json',
				...(registry.auth && { authorization: registry.auth }),
			},
		})
		if (statusCode !== 200) {
			await body.dump()
			throw new Error(
				'Registry search returned HTTP ' +
					statusCode +
					'. You can still check an exact package name.',
			)
		}
		const data: unknown = await body.json()
		if (!record(data) || !Array.isArray(data.objects))
			throw new Error('Registry returned an invalid search response.')
		const packages: RegistryCandidate[] = []
		for (const row of data.objects.slice(0, 20)) {
			const pkg = record(row) ? row.package : null
			if (
				!record(pkg) ||
				!isPackageName(pkg.name) ||
				typeof pkg.version !== 'string' ||
				!valid(pkg.version)
			)
				continue
			if (
				!includeAll &&
				pkg.name !== text &&
				!(scope && pkg.name.startsWith(scope + '/')) &&
				!pkg.name.includes('pluxel') &&
				!(
					Array.isArray(pkg.keywords) &&
					pkg.keywords.some((word) => typeof word === 'string' && /pluxel/i.test(word))
				) &&
				!(typeof pkg.description === 'string' && /\bpluxel\b/i.test(pkg.description))
			)
				continue
			packages.push({
				name: pkg.name,
				version: pkg.version,
				description: typeof pkg.description === 'string' ? pkg.description.slice(0, 500) : null,
			})
		}
		return { registry: registry.url, packages }
	} finally {
		await dispatcher.destroy()
	}
}

function relativeFile(path: unknown): path is string {
	return (
		typeof path === 'string' &&
		path.startsWith('./') &&
		!path.includes('\0') &&
		!/[\\%?#]/.test(path) &&
		path
			.slice(2)
			.split('/')
			.every((part) => part && part !== '.' && part !== '..' && part !== 'node_modules')
	)
}

/** Registry metadata is advisory. Apply these same checks to the bytes pnpm actually materializes. */
export function inspectPluginManifest(
	manifest: Record<string, unknown>,
): RegistryInspection['check'] {
	const peer = record(manifest.peerDependencies)
		? manifest.peerDependencies['@pluxel/core']
		: undefined
	if (typeof peer !== 'string' || !peer.trim() || !validRange(peer))
		return {
			ok: false,
			reason: 'The package must declare a published @pluxel/core peer version range.',
		}
	if (!satisfies(coreVersion, peer))
		return {
			ok: false,
			reason: 'Requires @pluxel/core ' + peer + '. This application provides ' + coreVersion + '.',
		}
	let entry: string | undefined
	try {
		entry = resolveExports(manifest.exports as PathConditions, '', [
			'import',
			'node',
			'node-addons',
			'module-sync',
		])[0]
	} catch {
		// Packages exposing only subpaths cannot be imported by the managed root wrapper.
	}
	if (!relativeFile(entry) || !/\.(?:cjs|mjs|js)$/.test(entry))
		return { ok: false, reason: 'A published JavaScript export at the package root is required.' }
	return { ok: true, coreRange: peer, coreVersion, entry }
}

export async function checkInstalledPlugin(root: string, name: string) {
	const manifest = await manifestAt(root)
	if (manifest.name !== name) throw new Error('Installed package name differs from ' + name + '.')
	const check = inspectPluginManifest(manifest)
	if (check.ok === false) throw new Error(check.reason)
	async function publishedFile(path: string) {
		const actual = await realpath(resolve(root, path)).catch((): null => null)
		const rel = actual && relative(root, actual)
		if (!actual || !rel || rel.split(sep)[0] === '..' || isAbsolute(rel))
			throw new Error('Missing published package file: ' + path)
		const file = await stat(actual)
		if (!file.isFile()) throw new Error('Missing published package file: ' + path)
		return actual
	}
	await publishedFile(check.entry)
	const control = record(manifest.pluxel) ? manifest.pluxel.control : undefined
	if (control !== undefined) {
		if (!relativeFile(control)) throw new Error('Invalid pluxel.control manifest path.')
		const file = await publishedFile(control)
		const contents = await textFile(file, 4 * 1024 * 1024)
		if (contents.truncated) throw new Error('Plugin control manifest exceeds 4 MiB.')
		const facts: unknown = JSON.parse(contents.text)
		const rootPlugin =
			record(facts) &&
			Array.isArray(facts.definitions) &&
			facts.definitions.some(
				(d: unknown) =>
					record(d) &&
					record(d.definition) &&
					record(d.definition.entry) &&
					d.definition.entry.kind === 'package-root' &&
					d.definition.entry.packageName === name &&
					typeof d.definition.exportName === 'string' &&
					d.definition.exportName.length > 0,
			)
		if (!rootPlugin)
			throw new Error('The published control manifest declares no plugin at this package root.')
	}
}
