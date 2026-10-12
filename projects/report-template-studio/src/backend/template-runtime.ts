import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import {
	createServer,
	createServerHotChannel,
	DevEnvironment,
	type ViteDevServer,
	type HMRPayload,
} from 'vite'
import { rolldown } from 'rolldown'
import { newQuickJSWASMModule, type QuickJSContext } from 'quickjs-emscripten'
export interface RuntimeSource {
	files: Record<string, string>
	entry: string
}

const libraryNames = ['valibot', 'valibot-form', '@pluxel/typst/template'] as const
const libraries = new Map<string, Promise<string>>()
async function bundleLibrary(name: string) {
	let pending = libraries.get(name)
	if (!pending) {
		pending = (async () => {
			const build = await rolldown({
				input: fileURLToPath(import.meta.resolve(name)),
				platform: 'neutral',
				transform: name === 'vite/module-runner' ? { define: { 'import.meta': '{}' } } : undefined,
			})
			try {
				const output = await build.generate({
					format: name === 'vite/module-runner' ? 'iife' : 'esm',
					name: name === 'vite/module-runner' ? '__viteRunner' : undefined,
					codeSplitting: false,
				})
				const chunk = output.output[0]
				if (output.output.length !== 1 || chunk?.type !== 'chunk')
					throw new Error('Expected one runtime module')
				return chunk.code
			} finally {
				await build.close()
			}
		})()
		libraries.set(name, pending)
	}
	return pending
}

/** The official Vite ModuleRunner lives entirely inside this constrained QuickJS heap. */
class Sandbox {
	private deadline = Infinity
	private closed = false
	private readonly pending = new Set<Promise<void>>()
	constructor(
		readonly vm: QuickJSContext,
		private readonly invoke: (payload: HMRPayload) => Promise<unknown>,
		private readonly send: (payload: HMRPayload) => void,
	) {
		vm.runtime.setMemoryLimit(64 * 1024 * 1024)
		vm.runtime.setMaxStackSize(512 * 1024)
		vm.runtime.setInterruptHandler(() => Date.now() > this.deadline)
		const request = vm.newFunction('__studioInvoke', (encoded) => {
			const payload = JSON.parse(vm.getString(encoded)) as HMRPayload
			if (
				payload.type !== 'custom' ||
				payload.event !== 'vite:invoke' ||
				!['fetchModule', 'getBuiltins'].includes(payload.data?.name)
			)
				throw new Error('Unsupported module transport request')
			const deferred = vm.newPromise()
			const operation = this.invoke(payload)
				.then(
					(result) => {
						if (this.closed) return
						using value = vm.newString(JSON.stringify(result))
						deferred.resolve(value)
						return undefined
					},
					(error) => {
						if (this.closed) return
						using value = vm.newError(error instanceof Error ? error.message : String(error))
						deferred.reject(value)
						return undefined
					},
				)
				.finally(() => {
					this.pending.delete(operation)
					deferred.dispose()
				})
			this.pending.add(operation)
			return deferred.handle.dup()
		})
		vm.setProp(vm.global, '__studioInvoke', request)
		request.dispose()
		const sender = vm.newFunction('__studioSend', (encoded) => {
			this.send(JSON.parse(vm.getString(encoded)))
			return vm.undefined
		})
		vm.setProp(vm.global, '__studioSend', sender)
		sender.dispose()
		const url = vm.newFunction('__studioUrl', (encoded) =>
			vm.newString(new URL(vm.getString(encoded)).href),
		)
		vm.setProp(vm.global, '__studioUrl', url)
		url.dispose()
		const decode = vm.newFunction('__studioDecode', (encoded) =>
			vm.newString(new TextDecoder().decode(Uint8Array.from(JSON.parse(vm.getString(encoded))))),
		)
		vm.setProp(vm.global, '__studioDecode', decode)
		decode.dispose()
		const base64 = vm.newFunction('atob', (encoded) =>
			vm.newString(Buffer.from(vm.getString(encoded), 'base64').toString('latin1')),
		)
		vm.setProp(vm.global, 'atob', base64)
		base64.dispose()
	}
	async evaluate(expression: string): Promise<unknown> {
		if (this.closed) throw new Error('Template sandbox is closed')
		this.deadline = Date.now() + 1500
		using handle = this.vm.unwrapResult(this.vm.evalCode(expression))
		let settled = false
		let abandoned = false
		let resolved: Awaited<ReturnType<QuickJSContext['resolvePromise']>> | undefined
		const promise = this.vm.resolvePromise(handle).then((value) => {
			if (abandoned) value.dispose()
			else resolved = value
			settled = true
			return undefined
		})
		const end = Date.now() + 10_000
		try {
			while (!settled) {
				this.deadline = Date.now() + 1500
				const result = this.vm.runtime.executePendingJobs()
				if (result.error) {
					const failure = this.vm.dump(result.error)
					result.error.dispose()
					throw new Error(`模板执行失败：${JSON.stringify(failure)}`)
				}
				if (Date.now() > end) throw new Error('Template module evaluation timed out')
				await nextTurn()
			}
			await promise
			using value = this.vm.unwrapResult(resolved!)
			return this.vm.dump(value)
		} finally {
			abandoned = true
			if (resolved?.alive) resolved.dispose()
		}
	}

	async close() {
		if (this.closed) return
		await Promise.allSettled(this.pending)
		this.closed = true
		this.vm.dispose()
	}
}

/** Database-backed virtual source files, with Vite owning dependency invalidation and HMR. */
export class TemplateRuntime {
	private server!: ViteDevServer
	private environment!: DevEnvironment
	private sandbox!: Sandbox
	private files: Record<string, string>
	private documentEntry: string
	private readonly messages: HMRPayload[] = []
	private closed = false
	private constructor(
		private readonly root: string,
		document: RuntimeSource,
	) {
		this.files = document.files
		this.documentEntry = document.entry
	}
	static async open(document: RuntimeSource) {
		const root = await mkdtemp(join(tmpdir(), 'studio-vite-'))
		const runtime = new TemplateRuntime(root, document)
		try {
			await runtime.initialize()
			return runtime
		} catch (error) {
			await runtime.close()
			throw error
		}
	}
	private entry() {
		const rawImports = Object.keys(this.files)
			.filter((name) => name.endsWith('.typ'))
			.sort()
			.map((name) => `import ${JSON.stringify(`./${name}?raw`)};`)
			.join('\n')
		return `${rawImports}
import * as initial from ${JSON.stringify('./' + this.documentEntry)};
import { safeParse, getDefaults } from 'valibot';
import { extractFormFields } from 'valibot-form';
let template = initial;
if (import.meta.hot) {
  import.meta.hot.accept(${JSON.stringify('./' + this.documentEntry)}, next => { if (next) template = next; });
  import.meta.hot.accept();
}
function merge(defaults, input) {
  if (Array.isArray(input)) return input.map((value, index) => merge(defaults?.[index], value));
  if (input && typeof input === 'object') {
    const result = defaults && typeof defaults === 'object' && !Array.isArray(defaults) ? { ...defaults } : {};
    for (const [key, value] of Object.entries(input)) result[key] = merge(defaults?.[key], value);
    return result;
  }
  return input === undefined ? defaults : input;
}
export function run(input) {
  if (!Object.hasOwn(template, 'default')) throw new Error('报表入口必须 default export 文档定义；使用 defineTypstDocument({ template, schema, createFiles? })');
  const definition = template.default;
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw new Error('报表入口 default 必须是文档定义对象');
  if (Object.keys(definition).some(key => !['template', 'schema', 'createFiles'].includes(key))) throw new Error('报表定义仅允许 template、schema 和 createFiles；名称来自入口文件名');
  if (definition.createFiles !== undefined && typeof definition.createFiles !== 'function') throw new Error('createFiles 必须是同步函数');
  if (!definition.schema || definition.schema.async || !['object', 'strict_object', 'loose_object', 'object_with_rest'].includes(definition.schema.type)) throw new Error('报表定义 schema 必须是同步 Valibot object schema');
  const metadata = { template: definition.template };
  const fields = extractFormFields(definition.schema);
  const data = merge(getDefaults(definition.schema), input);
  const parsed = safeParse(definition.schema, data);
  if (!parsed.success) return { ...metadata, fields, data, inputError: parsed.issues.map(i => (i.path?.map(p => p.key).join('.') || 'data') + ': ' + i.message).join('\\n') };
  const files = definition.createFiles ? definition.createFiles(parsed.output) : { '/inputs/data.json': { kind: 'json', value: parsed.output } };
  if (files?.then) throw new Error('createFiles 必须是同步函数');
  return { ...metadata, fields, data: parsed.output, files };
}`
	}
	private async initialize() {
		const channel = createServerHotChannel()
		channel.api!.outsideEmitter.on('send', (payload: HMRPayload) => this.messages.push(payload))
		const root = this.root.replaceAll('\\', '/')
		const entry = `${root}/.studio-entry.ts`
		this.server = await createServer({
			configFile: false,
			envFile: false,
			root,
			publicDir: false,
			appType: 'custom',
			logLevel: 'silent',
			server: { middlewareMode: true, ws: false, watch: null },
			optimizeDeps: { noDiscovery: true, include: [] },
			environments: {
				studio: {
					consumer: 'server',
					resolve: { noExternal: true, builtins: [] },
					optimizeDeps: { noDiscovery: true, include: [] },
					dev: {
						createEnvironment: (name, config) =>
							new DevEnvironment(name, config, { hot: true, transport: channel }),
					},
				},
			},
			plugins: [
				{
					name: 'studio-template-source-boundary',
					enforce: 'pre',
					resolveId: (source, importer) => {
						if (source === entry) return entry
						if (libraryNames.includes(source as (typeof libraryNames)[number]))
							return `\0studio-library:${source}`
						if (libraryNames.some((name) => source === `\0studio-library:${name}`)) return source
						let path: string
						if (source.startsWith(root + '/')) path = source.slice(root.length + 1)
						else if (source.startsWith('.') && importer?.startsWith(root + '/'))
							path = posix.normalize(
								posix.join(posix.dirname(importer.slice(root.length + 1)), source),
							)
						else if (source.startsWith('/') && !source.startsWith('/@')) path = source.slice(1)
						else
							throw new Error(
								`模板不能导入 ${source}；仅允许模板内模块、valibot、valibot-form 和 @pluxel/typst/template`,
							)
						if (path.startsWith('../') || path.startsWith('/'))
							throw new Error('模板 import 不得越出当前模板')
						const raw = path.endsWith('?raw')
						if (raw) path = path.slice(0, -4)
						const file = [path, `${path}.ts`, `${path}/index.ts`].find((name) =>
							Object.hasOwn(this.files, name),
						)
						if (!file) throw new Error(`模板模块不存在：${path}`)
						return `${root}/${file}${raw ? '?raw' : ''}`
					},
					load: async (id) => {
						if (id === entry) return this.entry()
						if (id.startsWith('\0studio-library:'))
							return bundleLibrary(id.slice('\0studio-library:'.length))
						if (id.startsWith(root + '/')) {
							const name = id.slice(root.length + 1)
							if (name.endsWith('?raw'))
								return `export default ${JSON.stringify(this.files[name.slice(0, -4)])}`
							if (!Object.hasOwn(this.files, name)) throw new Error(`模板模块不存在：${name}`)
							return this.files[name]
						}
						throw new Error(`模板不能加载 ${id}`)
					},
				},
			],
		})
		if (this.server.httpServer)
			throw new Error('Studio template compiler must not create an HTTP listener')
		this.environment = this.server.environments.studio!
		const quickjs = await newQuickJSWASMModule()
		this.sandbox = new Sandbox(
			quickjs.newContext(),
			async (payload) => {
				if (payload.type !== 'custom' || payload.event !== 'vite:invoke')
					throw new Error('Invalid Vite transport payload')
				const request = payload.data
				if (request.name === 'getBuiltins') return { result: [] }
				if (request.name !== 'fetchModule' || !Array.isArray(request.data))
					throw new Error('Unsupported Vite transport operation')
				const [id, importer] = request.data
				const allowed = (value: unknown, isImporter = false): boolean => {
					if (typeof value !== 'string') return false
					if (value === entry) return true
					if (
						libraryNames.some(
							(name) =>
								value === name ||
								value === `\0studio-library:${name}` ||
								value === `/@id/__x00__studio-library:${name}`,
						)
					)
						return true
					let name = value
					if (name.startsWith(root + '/')) name = name.slice(root.length + 1)
					else if (
						name.startsWith('.') &&
						typeof importer === 'string' &&
						importer.startsWith(root + '/')
					)
						name = posix.normalize(posix.join(posix.dirname(importer.slice(root.length + 1)), name))
					else if (name.startsWith('/') && !isImporter) name = name.slice(1)
					if (name.endsWith('?raw')) name = name.slice(0, -4)
					return (
						Object.hasOwn(this.files, name) ||
						(!isImporter &&
							[name + '.ts', name + '/index.ts'].some((path) => Object.hasOwn(this.files, path)))
					)
				}
				if (!allowed(id) || (importer != null && !allowed(importer, true)))
					throw new Error(
						`Template module transport cannot leave its own source tree: ${JSON.stringify([id, importer])}`,
					)
				if (request.data[1] === null) request.data[1] = undefined
				const result = await this.environment.hot.handleInvoke(payload)
				if (
					'result' in result &&
					result.result &&
					typeof result.result === 'object' &&
					'externalize' in result.result
				)
					throw new Error('External template modules are forbidden')
				return result
			},
			(payload) => {
				if (payload.type === 'custom')
					channel.api!.innerEmitter.emit(payload.event, payload.data, {
						send: (message: HMRPayload) => this.messages.push(message),
					})
			},
		)
		const runner = await bundleLibrary('vite/module-runner')
		await this.sandbox
			.evaluate(`class TextDecoder { decode(bytes) { return __studioDecode(JSON.stringify(Array.from(bytes))); } }
${runner}
class URL { constructor(input) { this.href = __studioUrl(input); } }
globalThis.__studioHmrErrors = [];
let __studioOnMessage;
class IsolatedEvaluator extends __viteRunner.ESModulesEvaluator {
  async runExternalModule(id) { throw new Error('External template modules are forbidden: ' + id); }
}
const __studioRunner = new __viteRunner.ModuleRunner({
  sourcemapInterceptor: false,
  hmr: { logger: { debug() {}, error(value) { __studioHmrErrors.push(String(value)); } } },
  transport: {
    invoke: async payload => JSON.parse(await __studioInvoke(JSON.stringify(payload))),
    send: payload => __studioSend(JSON.stringify(payload)),
    connect(handlers) { __studioOnMessage = handlers.onMessage; },
    disconnect() {},
  },
}, new IsolatedEvaluator());
globalThis.__studioHmr = payload => __studioOnMessage(payload);
globalThis.__studioRun = async data => { const module = await __studioRunner.import(${JSON.stringify(entry)}); return JSON.stringify(module.run(data)); };
globalThis.__studioClose = () => __studioRunner.close();
__studioRunner.import(${JSON.stringify(entry)}).then(() => true)
`)
	}
	async update(document: RuntimeSource) {
		if (this.closed) throw new Error('Template runtime is closed')
		const previousEntry = this.entry()
		const changed = new Set(
			[...Object.keys(this.files), ...Object.keys(document.files)].filter(
				(name) => this.files[name] !== document.files[name],
			),
		)
		this.files = document.files
		this.documentEntry = document.entry
		await this.sandbox.evaluate('__studioHmrErrors.length = 0')
		// The sources are store-backed, so use Vite's public HMR entry rather than a
		// second filesystem watcher. reloadModule propagates through Vite's graph.
		const modules = new Set<import('vite').EnvironmentModuleNode>()
		for (const name of changed) {
			const found = this.environment.moduleGraph.getModulesByFile(
				join(this.root, name).replaceAll('\\', '/'),
			)
			if (found) for (const module of found) modules.add(module)
		}
		if (previousEntry !== this.entry()) {
			const module = this.environment.moduleGraph.getModuleById(
				join(this.root, '.studio-entry.ts').replaceAll('\\', '/'),
			)
			if (module) modules.add(module)
		}
		for (const module of modules) await this.environment.reloadModule(module)
		let processed = 0
		const expires = Date.now() + 10_000
		while (this.messages.length > 0) {
			if (++processed > 128 || Date.now() > expires)
				throw new Error('Template HMR update budget exceeded')
			const message = this.messages.shift()!
			await this.sandbox.evaluate(`__studioHmr(${JSON.stringify(message)})`)
		}
		const errors = await this.sandbox.evaluate('JSON.stringify(__studioHmrErrors)')
		if (errors !== '[]') throw new Error(`模板热更新失败：${errors}`)
	}
	async run(data: Record<string, unknown>) {
		return this.sandbox.evaluate(`__studioRun(${JSON.stringify(data)})`)
	}
	async close() {
		if (this.closed) return
		this.closed = true
		try {
			if (this.sandbox) {
				try {
					await this.sandbox.evaluate(
						'typeof __studioClose === "function" ? __studioClose() : undefined',
					)
				} finally {
					await this.sandbox.close()
				}
			}
		} finally {
			await this.server?.close()
			await rm(this.root, { recursive: true, force: true })
		}
	}
}
