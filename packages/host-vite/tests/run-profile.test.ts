import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { afterEach, expect, it, vi } from 'vitest'
import { runViteApplication } from '../src/run'

afterEach(() => vi.unstubAllEnvs())

it.each([
	['server.hmr', '{server:{hmr:{port:0}}}'],
	['server.middlewareMode', '{server:{middlewareMode:false}}'],
	['define[process.env.NODE_ENV]', '{define:{"process.env.NODE_ENV":"\\"development\\""}}'],
] as const)(
	'rejects a config hook overriding production %s before server acquisition',
	async (field, config) => {
		vi.stubEnv('NODE_ENV', 'production')
		await using fixture = await createDiskFixture({})
		await writeFile(
			resolve(fixture.path, 'vite.config.mjs'),
			`export default {logLevel:'silent',plugins:[
		{name:'pluxel:host'},
		{name:'test:override',config(){return ${config}}},
		{name:'test:acquisition',configureServer(){throw new Error('SERVER_ACQUIRED')}}
	]}`,
		)
		await expect(
			runViteApplication({ root: fixture.path, configFile: 'vite.config.mjs' }),
		).rejects.toThrow(`production ${field}`)
	},
)
