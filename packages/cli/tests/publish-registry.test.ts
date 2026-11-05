import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PackageJson } from 'pkg-types'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalRegistry, resolvePublishTarget } from '../src/publish/registry'

const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function target(
	options: {
		name?: string
		npmrc?: string
		registryEnv?: string
		publishConfig?: Record<string, unknown>
		access?: string
	} = {},
) {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-publish-registry-'))
	roots.push(root)
	const pkg = {
		name: options.name ?? 'example-pkg',
		version: '1.0.0',
		publishConfig: options.publishConfig,
	} as PackageJson
	await Promise.all([
		writeFile(join(root, 'package.json'), JSON.stringify(pkg)),
		writeFile(join(root, '.npmrc'), options.npmrc ?? ''),
		writeFile(join(root, 'user.npmrc'), ''),
		writeFile(join(root, 'global.npmrc'), ''),
	])
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)),
	)
	return resolvePublishTarget(pkg, {
		cwd: root,
		env: {
			...env,
			NPM_CONFIG_USERCONFIG: join(root, 'user.npmrc'),
			NPM_CONFIG_GLOBALCONFIG: join(root, 'global.npmrc'),
			...(options.registryEnv ? { NPM_CONFIG_REGISTRY: options.registryEnv } : {}),
		},
		access: options.access,
	})
}

describe('publish registry selection through native npm config', () => {
	it('uses the native public npm default', async () => {
		expect(await target()).toEqual({ registry: 'https://registry.npmjs.org', access: null })
	})

	it('honors environment precedence over the project registry', async () => {
		expect(
			await target({
				npmrc: 'registry=https://project.example/npm/\n',
				registryEnv: 'https://environment.example/npm/',
			}),
		).toMatchObject({ registry: 'https://environment.example/npm' })
	})

	it('applies publishConfig.registry above the environment registry', async () => {
		expect(
			await target({
				npmrc: 'registry=https://project.example/npm/\n',
				registryEnv: 'https://environment.example/npm/',
				publishConfig: { registry: 'http://127.0.0.1:7677/npm/' },
			}),
		).toMatchObject({ registry: 'http://127.0.0.1:7677/npm' })
	})

	it('preserves npm scoped registry precedence over publishConfig.registry', async () => {
		expect(
			await target({
				name: '@acme/plugin',
				npmrc: '@acme:registry=https://scoped.example/npm/\n',
				registryEnv: 'https://environment.example/npm/',
				publishConfig: { registry: 'https://publish.example/npm/' },
			}),
		).toMatchObject({ registry: 'https://scoped.example/npm' })
	})

	it('allows publishConfig to override its matching scoped registry', async () => {
		expect(
			await target({
				name: '@acme/plugin',
				npmrc: '@acme:registry=https://scoped.example/npm/\n',
				publishConfig: { '@acme:registry': 'https://publish-scoped.example/npm/' },
			}),
		).toMatchObject({ registry: 'https://publish-scoped.example/npm' })
	})

	it('keeps npm configured scope fallback for an unscoped package', async () => {
		expect(
			await target({
				npmrc: 'scope=acme\n@acme:registry=https://fallback.example/npm/\n',
			}),
		).toMatchObject({ registry: 'https://fallback.example/npm' })
	})

	it('uses native access selection and the private alias for privacy decisions', async () => {
		expect(
			await target({ npmrc: 'access=public\n', publishConfig: { access: 'private' } }),
		).toMatchObject({ access: 'restricted' })
		expect(
			await target({ publishConfig: { access: 'restricted' }, access: 'public' }),
		).toMatchObject({ access: 'public' })
	})
})

describe('registry base URL contract', () => {
	it.each(['http://localhost:7677/npm/', 'http://127.0.0.1:7677/npm/', 'http://[::1]:7677/npm/'])(
		'accepts loopback HTTP base %s without a trailing slash',
		(value) => {
			expect(canonicalRegistry(value)).toBe(value.slice(0, -1))
		},
	)
	it.each([
		'http://registry.example/npm',
		'http://127.0.0.2/npm',
		'https://user:secret@registry.example/npm',
		'https://registry.example/npm?token=secret',
		'https://registry.example/npm#fragment',
		' https://registry.example/npm',
	])('rejects disallowed registry base %s', (value) => {
		expect(() => canonicalRegistry(value)).toThrow('The npm registry must be an HTTPS base URL')
	})
})
