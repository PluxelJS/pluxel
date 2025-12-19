import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { createServer, normalizePath } from 'vite'
import { HMRService } from '../../src/services/hmr/HMRService'
import { buildHmrViteConfig, resolveFsAllowList, resolveHMRDependencyConfig } from '../../src/services/hmr/config'

describe('HMR CJS dependency handling', () => {
	it('externalizes CJS deps so require() works', async () => {
		const root = mkdtempSync(join(tmpdir(), 'pluxel-hmr-cjs-'))
		try {
			mkdirSync(join(root, 'node_modules', 'cjs-pkg'), { recursive: true })
			writeFileSync(
				join(root, 'node_modules', 'cjs-pkg', 'package.json'),
				JSON.stringify({ name: 'cjs-pkg', version: '1.0.0', main: 'index.js' }),
			)
			writeFileSync(
				join(root, 'node_modules', 'cjs-pkg', 'index.js'),
				"const { platform } = require('os'); module.exports = { platform };\n",
			)
			writeFileSync(
				join(root, 'entry.ts'),
				"import pkg from 'cjs-pkg'; export const platform = pkg.platform;\n",
			)

			const errorLogs: Array<{ msg: string; obj: any }> = []
			const ctx = {
				logger: {
					info() {},
					warn() {},
					error(obj: any, msg: string) {
						errorLogs.push({ msg, obj })
					},
				},
				loader: {
					pathAnchors: new Set<string>(),
					beginBatch() {
						return {
							replaceModule: async () => false,
							rollback() {},
							commit() {},
						}
					},
					pruneModule() {},
				},
				registry: {
					commit: async () => ({ ok: true }),
					resetDraft() {},
					container: { services: new Map() },
				},
				honoService: { viteHonoDevServer: { name: 'noop', apply: 'serve', configureServer() {} } },
			} as any

			const hmr = new HMRService(ctx, {
				dir: [root],
				attribution: 'off',
				deps: {
					bridgeModules: [],
					ssrExternal: [],
					ssrNoExternal: [],
					cjsExternal: ['cjs-pkg'],
					optimizeDepsInclude: [],
					optimizeDepsInterop: [],
				},
				log: { useColors: false },
			})
			hmr.setServerRoot(root)

			const deps = resolveHMRDependencyConfig({
				bridgeModules: [],
				ssrExternal: [],
				ssrNoExternal: [],
				cjsExternal: ['cjs-pkg'],
				optimizeDepsInclude: [],
				optimizeDepsInterop: [],
			})
			const fsAllow = resolveFsAllowList({
				cwd: root,
				cwdNormalized: normalizePath(root),
				scanRoots: [normalizePath(root)],
			})

			const server = await createServer({
				...buildHmrViteConfig({
					root,
					fsAllow,
					scanDirs: [root],
					deps,
					runnerPlugin: (hmr as any).plugin,
					honoPlugin: { name: 'noop' },
					port: 0,
				}),
				server: { port: 0, middlewareMode: false, fs: { allow: fsAllow } },
			})
			try {
				await server.listen()
			} finally {
				await server.close()
			}

			const executeFailed = errorLogs.find((e) => e.msg === '[HMR] execute failed')
			expect(executeFailed).toBeUndefined()
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})

	it('externalizes CJS subpath exports (pkg/subpath)', async () => {
		const root = mkdtempSync(join(tmpdir(), 'pluxel-hmr-cjs-subpath-'))
		try {
			mkdirSync(join(root, 'node_modules', 'pluxel-plugin-napi-rs', 'canvas'), { recursive: true })
			writeFileSync(
				join(root, 'node_modules', 'pluxel-plugin-napi-rs', 'package.json'),
				JSON.stringify({
					name: 'pluxel-plugin-napi-rs',
					version: '1.0.0',
					exports: {
						'./canvas': './canvas/index.cjs',
					},
				}),
			)
			writeFileSync(
				join(root, 'node_modules', 'pluxel-plugin-napi-rs', 'canvas', 'index.cjs'),
				"const { platform } = require('os'); module.exports = { platform };\n",
			)
			writeFileSync(
				join(root, 'entry.ts'),
				"import pkg from 'pluxel-plugin-napi-rs/canvas'; export const platform = pkg.platform;\n",
			)

			const errorLogs: Array<{ msg: string; obj: any }> = []
			const ctx = {
				logger: {
					info() {},
					warn() {},
					error(obj: any, msg: string) {
						errorLogs.push({ msg, obj })
					},
				},
				loader: {
					pathAnchors: new Set<string>(),
					beginBatch() {
						return {
							replaceModule: async () => false,
							rollback() {},
							commit() {},
						}
					},
					pruneModule() {},
				},
				registry: {
					commit: async () => ({ ok: true }),
					resetDraft() {},
					container: { services: new Map() },
				},
				honoService: { viteHonoDevServer: { name: 'noop', apply: 'serve', configureServer() {} } },
			} as any

			const hmr = new HMRService(ctx, {
				dir: [root],
				attribution: 'off',
				deps: {
					bridgeModules: [],
					ssrExternal: [],
					ssrNoExternal: [],
					cjsExternal: ['pluxel-plugin-napi-rs/*'],
					optimizeDepsInclude: [],
					optimizeDepsInterop: [],
				},
				log: { useColors: false },
			})
			hmr.setServerRoot(root)

			const deps = resolveHMRDependencyConfig({
				bridgeModules: [],
				ssrExternal: [],
				ssrNoExternal: [],
				cjsExternal: ['pluxel-plugin-napi-rs/*'],
				optimizeDepsInclude: [],
				optimizeDepsInterop: [],
			})
			const fsAllow = resolveFsAllowList({
				cwd: root,
				cwdNormalized: normalizePath(root),
				scanRoots: [normalizePath(root)],
			})

			const server = await createServer({
				...buildHmrViteConfig({
					root,
					fsAllow,
					scanDirs: [root],
					deps,
					runnerPlugin: (hmr as any).plugin,
					honoPlugin: { name: 'noop' },
					port: 0,
				}),
				server: { port: 0, middlewareMode: false, fs: { allow: fsAllow } },
			})
			try {
				await server.listen()
			} finally {
				await server.close()
			}

			const executeFailed = errorLogs.find((e) => e.msg === '[HMR] execute failed')
			expect(executeFailed).toBeUndefined()
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})

	it('externalizes CJS deps before workspace resolver', async () => {
		const root = mkdtempSync(join(tmpdir(), 'pluxel-hmr-cjs-workspace-'))
		try {
			// A node_modules CJS package that will work when externalized.
			mkdirSync(join(root, 'node_modules', 'cjs-pkg'), { recursive: true })
			writeFileSync(
				join(root, 'node_modules', 'cjs-pkg', 'package.json'),
				JSON.stringify({ name: 'cjs-pkg', version: '1.0.0', main: 'index.js' }),
			)
			writeFileSync(
				join(root, 'node_modules', 'cjs-pkg', 'index.js'),
				"const { platform } = require('os'); module.exports = { platform };\n",
			)

			// A workspace-scanned entry that points to a CJS file (this is what used to preempt externalization).
			mkdirSync(join(root, 'cjs-pkg'), { recursive: true })
			writeFileSync(
				join(root, 'cjs-pkg', 'package.json'),
				JSON.stringify({ name: 'cjs-pkg', version: '1.0.0' }),
			)
			writeFileSync(
				join(root, 'cjs-pkg', 'index.cjs'),
				"const { platform } = require('os'); module.exports = { platform };\n",
			)

			writeFileSync(
				join(root, 'entry.ts'),
				"import pkg from 'cjs-pkg'; export const platform = pkg.platform;\n",
			)

			const errorLogs: Array<{ msg: string; obj: any }> = []
			const ctx = {
				logger: {
					info() {},
					warn() {},
					error(obj: any, msg: string) {
						errorLogs.push({ msg, obj })
					},
				},
				scanService: {
					resolveEntry: async ({ name }: any) => {
						if (name !== 'cjs-pkg') return { ok: false }
						return { ok: true, entry: join(root, 'cjs-pkg', 'index.cjs') }
					},
				},
				loader: {
					pathAnchors: new Set<string>(),
					beginBatch() {
						return {
							replaceModule: async () => false,
							rollback() {},
							commit() {},
						}
					},
					pruneModule() {},
				},
				registry: {
					commit: async () => ({ ok: true }),
					resetDraft() {},
					container: { services: new Map() },
				},
				honoService: { viteHonoDevServer: { name: 'noop', apply: 'serve', configureServer() {} } },
			} as any

			const hmr = new HMRService(ctx, {
				dir: [root],
				attribution: 'off',
				deps: {
					bridgeModules: [],
					ssrExternal: [],
					ssrNoExternal: [],
					cjsExternal: ['cjs-pkg'],
					optimizeDepsInclude: [],
					optimizeDepsInterop: [],
				},
				log: { useColors: false },
			})
			hmr.setServerRoot(root)

			const deps = resolveHMRDependencyConfig({
				bridgeModules: [],
				ssrExternal: [],
				ssrNoExternal: [],
				cjsExternal: ['cjs-pkg'],
				optimizeDepsInclude: [],
				optimizeDepsInterop: [],
			})
			const fsAllow = resolveFsAllowList({
				cwd: root,
				cwdNormalized: normalizePath(root),
				scanRoots: [normalizePath(root)],
			})

			const server = await createServer({
				...buildHmrViteConfig({
					root,
					fsAllow,
					scanDirs: [root],
					deps,
					runnerPlugin: (hmr as any).plugin,
					honoPlugin: { name: 'noop' },
					port: 0,
				}),
				server: { port: 0, middlewareMode: false, fs: { allow: fsAllow } },
			})
			try {
				await server.listen()
			} finally {
				await server.close()
			}

			const executeFailed = errorLogs.find((e) => e.msg === '[HMR] execute failed')
			expect(executeFailed).toBeUndefined()
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})

	it('fails fast with a helpful hint for unmarked CJS deps', async () => {
		const root = mkdtempSync(join(tmpdir(), 'pluxel-hmr-cjs-unmarked-'))
		try {
			// Force a bare specifier to resolve into workspace source (not node_modules),
			// so Vite's runner inlines the CJS file and triggers "require is not defined".
			mkdirSync(join(root, 'cjs-pkg'), { recursive: true })
			writeFileSync(
				join(root, 'tsconfig.json'),
				JSON.stringify({
					compilerOptions: {
						baseUrl: '.',
						paths: {
							'cjs-pkg': ['./cjs-pkg/index.cjs'],
						},
					},
				}),
			)
			writeFileSync(
				join(root, 'cjs-pkg', 'package.json'),
				JSON.stringify({ name: 'cjs-pkg', version: '1.0.0' }),
			)
			writeFileSync(
				join(root, 'cjs-pkg', 'index.cjs'),
				"const { platform } = require('os'); module.exports = { platform };\n",
			)
			writeFileSync(join(root, 'entry.ts'), "import pkg from 'cjs-pkg'; export const platform = pkg.platform;\n")

			const ctx = {
				logger: { info() {}, warn() {}, error() {} },
				loader: {
					pathAnchors: new Set<string>(),
					beginBatch() {
						return {
							replaceModule: async () => false,
							rollback() {},
							commit() {},
						}
					},
					pruneModule() {},
				},
				registry: {
					commit: async () => ({ ok: true }),
					resetDraft() {},
					container: { services: new Map() },
				},
				honoService: { viteHonoDevServer: { name: 'noop', apply: 'serve', configureServer() {} } },
			} as any

			const hmr = new HMRService(ctx, {
				dir: [root],
				attribution: 'off',
				deps: {
					bridgeModules: [],
					ssrExternal: [],
					ssrNoExternal: [],
					cjsExternal: [],
					optimizeDepsInclude: [],
					optimizeDepsInterop: [],
				},
				log: { useColors: false },
			})
			hmr.setServerRoot(root)

			const deps = resolveHMRDependencyConfig({
				bridgeModules: [],
				ssrExternal: [],
				ssrNoExternal: [],
				cjsExternal: [],
				optimizeDepsInclude: [],
				optimizeDepsInterop: [],
			})
			const fsAllow = resolveFsAllowList({
				cwd: root,
				cwdNormalized: normalizePath(root),
				scanRoots: [normalizePath(root)],
			})

			let thrown: any = null
			let server: any = null
			try {
				server = await createServer({
					...buildHmrViteConfig({
						root,
						fsAllow,
						scanDirs: [root],
						deps,
						runnerPlugin: (hmr as any).plugin,
						honoPlugin: { name: 'noop' },
						port: 0,
					}),
					server: { port: 0, middlewareMode: false, fs: { allow: fsAllow } },
				})
				await server.listen()
			} catch (e) {
				thrown = e
			} finally {
				try {
					await server?.close?.()
				} catch {
					// ignore
				}
			}

			expect(thrown).toBeTruthy()
			expect(String(thrown?.message ?? '')).toContain('cjs-pkg')
			expect(String(thrown?.message ?? '')).not.toContain('rolldown-vite')
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})

	it('externalizes marked CJS deps even when resolved to /@fs/ file URLs', async () => {
		const root = mkdtempSync(join(tmpdir(), 'pluxel-hmr-cjs-fsurl-'))
		try {
			// Force a bare specifier to resolve into a local .cjs file via tsconfig paths.
			mkdirSync(join(root, 'cjs-pkg'), { recursive: true })
			writeFileSync(
				join(root, 'tsconfig.json'),
				JSON.stringify({
					compilerOptions: {
						baseUrl: '.',
						paths: {
							'cjs-pkg': ['./cjs-pkg/index.cjs'],
						},
					},
				}),
			)
			writeFileSync(
				join(root, 'cjs-pkg', 'package.json'),
				JSON.stringify({ name: 'cjs-pkg', version: '1.0.0' }),
			)
			writeFileSync(
				join(root, 'cjs-pkg', 'index.cjs'),
				"const { platform } = require('os'); module.exports = { platform };\n",
			)
			writeFileSync(
				join(root, 'entry.ts'),
				"import pkg from 'cjs-pkg'; export const platform = pkg.platform;\n",
			)

			const errorLogs: Array<{ msg: string; obj: any }> = []
			const ctx = {
				logger: {
					info() {},
					warn() {},
					error(obj: any, msg: string) {
						errorLogs.push({ msg, obj })
					},
				},
				loader: {
					pathAnchors: new Set<string>(),
					beginBatch() {
						return {
							replaceModule: async () => false,
							rollback() {},
							commit() {},
						}
					},
					pruneModule() {},
				},
				registry: {
					commit: async () => ({ ok: true }),
					resetDraft() {},
					container: { services: new Map() },
				},
				honoService: { viteHonoDevServer: { name: 'noop', apply: 'serve', configureServer() {} } },
			} as any

			const hmr = new HMRService(ctx, {
				dir: [root],
				attribution: 'off',
				deps: {
					bridgeModules: [],
					ssrExternal: [],
					ssrNoExternal: [],
					cjsExternal: ['cjs-pkg'],
					optimizeDepsInclude: [],
					optimizeDepsInterop: [],
				},
				log: { useColors: false },
			})
			hmr.setServerRoot(root)

			const deps = resolveHMRDependencyConfig({
				bridgeModules: [],
				ssrExternal: [],
				ssrNoExternal: [],
				cjsExternal: ['cjs-pkg'],
				optimizeDepsInclude: [],
				optimizeDepsInterop: [],
			})
			const fsAllow = resolveFsAllowList({
				cwd: root,
				cwdNormalized: normalizePath(root),
				scanRoots: [normalizePath(root)],
			})

			const server = await createServer({
				...buildHmrViteConfig({
					root,
					fsAllow,
					scanDirs: [root],
					deps,
					runnerPlugin: (hmr as any).plugin,
					honoPlugin: { name: 'noop' },
					port: 0,
				}),
				server: { port: 0, middlewareMode: false, fs: { allow: fsAllow } },
			})
			try {
				await server.listen()
			} finally {
				await server.close()
			}

			const executeFailed = errorLogs.find((e) => e.msg === '[HMR] execute failed')
			expect(executeFailed).toBeUndefined()
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})
})
