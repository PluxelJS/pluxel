import { RpcTarget } from 'capnweb'
import type { ArtifactUnion, DesktopApi, StudioApi } from '../shared/contracts.js'
import { rpcError } from './errors.js'

/** This capability is wired only to the trusted Electron main-process port. */
export interface NativeDesktopApi extends DesktopApi {
	resolveArtifact(input: { id: string }): Promise<ArtifactUnion>
}

/** Admission and task settlement belong to the carrier, independently of an RPC connection. */
export class ApiGeneration {
	#api: NativeDesktopApi
	#resolve?: () => NativeDesktopApi | undefined
	#active = true
	#pending = new Set<Promise<unknown>>()

	constructor(api: NativeDesktopApi, resolve?: () => NativeDesktopApi | undefined) {
		this.#api = api
		this.#resolve = resolve
	}

	run<T>(call: (api: NativeDesktopApi) => Promise<T>): Promise<T> {
		if (!this.#active || (this.#resolve && this.#resolve() !== this.#api))
			return Promise.reject(
				rpcError(
					'BACKEND_UNAVAILABLE',
					'Studio backend generation was withdrawn; reconnect to the current instance',
				),
			)
		if (this.#pending.size >= 256)
			return Promise.reject(rpcError('BUSY', 'Studio backend operation capacity is full'))
		const operation = Promise.resolve().then(() => call(this.#api))
		this.#pending.add(operation)
		void operation.finally(() => this.#pending.delete(operation)).catch(() => {})
		return operation
	}

	withdraw(): void {
		this.#active = false
	}
	async drain(): Promise<void> {
		await Promise.allSettled(this.#pending)
	}
}

/** External programs receive exactly the shared business capability. */
export class StudioRpcTarget extends RpcTarget implements StudioApi {
	#generation: ApiGeneration
	constructor(generation: ApiGeneration) {
		super()
		this.#generation = generation
	}
	listProjects() {
		return this.#generation.run((api) => api.listProjects())
	}
	getProject(input: Parameters<StudioApi['getProject']>[0]) {
		return this.#generation.run((api) => api.getProject(input))
	}
	createProject(input: Parameters<StudioApi['createProject']>[0]) {
		return this.#generation.run((api) => api.createProject(input))
	}
	openProject(input: Parameters<StudioApi['openProject']>[0]) {
		return this.#generation.run((api) => api.openProject(input))
	}
	forgetProject(input: Parameters<StudioApi['forgetProject']>[0]) {
		return this.#generation.run((api) => api.forgetProject(input))
	}
	getTree(input: Parameters<StudioApi['getTree']>[0]) {
		return this.#generation.run((api) => api.getTree(input))
	}
	readFile(input: Parameters<StudioApi['readFile']>[0]) {
		return this.#generation.run((api) => api.readFile(input))
	}
	writeFile(input: Parameters<StudioApi['writeFile']>[0]) {
		return this.#generation.run((api) => api.writeFile(input))
	}
	mkdir(input: Parameters<StudioApi['mkdir']>[0]) {
		return this.#generation.run((api) => api.mkdir(input))
	}
	createReport(input: Parameters<StudioApi['createReport']>[0]) {
		return this.#generation.run((api) => api.createReport(input))
	}
	rename(input: Parameters<StudioApi['rename']>[0]) {
		return this.#generation.run((api) => api.rename(input))
	}
	remove(input: Parameters<StudioApi['remove']>[0]) {
		return this.#generation.run((api) => api.remove(input))
	}
	search(input: Parameters<StudioApi['search']>[0]) {
		return this.#generation.run((api) => api.search(input))
	}
	getInput(input: Parameters<StudioApi['getInput']>[0]) {
		return this.#generation.run((api) => api.getInput(input))
	}
	setInput(input: Parameters<StudioApi['setInput']>[0]) {
		return this.#generation.run((api) => api.setInput(input))
	}
	describeDocument(input: Parameters<StudioApi['describeDocument']>[0]) {
		return this.#generation.run((api) => api.describeDocument(input))
	}
	compile(input: Parameters<StudioApi['compile']>[0]) {
		return this.#generation.run((api) => api.compile(input))
	}
	renderPage(input: Parameters<StudioApi['renderPage']>[0]) {
		return this.#generation.run((api) => api.renderPage(input))
	}
	exportPdf(input: Parameters<StudioApi['exportPdf']>[0]) {
		return this.#generation.run((api) => api.exportPdf(input))
	}
	importWorkspaceFile(input: Parameters<StudioApi['importWorkspaceFile']>[0]) {
		return this.#generation.run((api) => api.importWorkspaceFile(input))
	}
	importAssetFile(input: Parameters<StudioApi['importAssetFile']>[0]) {
		return this.#generation.run((api) => api.importAssetFile(input))
	}
	exportWorkspaceFile(input: Parameters<StudioApi['exportWorkspaceFile']>[0]) {
		return this.#generation.run((api) => api.exportWorkspaceFile(input))
	}
}

export class DesktopRpcTarget extends StudioRpcTarget implements DesktopApi {
	#generation: ApiGeneration
	constructor(generation: ApiGeneration) {
		super(generation)
		this.#generation = generation
	}
	getPreview(input: Parameters<DesktopApi['getPreview']>[0]) {
		return this.#generation.run((api) => api.getPreview(input))
	}
	importWorkspace(input: Parameters<DesktopApi['importWorkspace']>[0]) {
		return this.#generation.run((api) => api.importWorkspace(input))
	}
	putAsset(input: Parameters<DesktopApi['putAsset']>[0]) {
		return this.#generation.run((api) => api.putAsset(input))
	}
	exportWorkspace(input: Parameters<DesktopApi['exportWorkspace']>[0]) {
		return this.#generation.run((api) => api.exportWorkspace(input))
	}
	models() {
		return this.#generation.run((api) => api.models())
	}
	providers() {
		return this.#generation.run((api) => api.providers())
	}
	configureProvider(input: Parameters<DesktopApi['configureProvider']>[0]) {
		return this.#generation.run((api) => api.configureProvider(input))
	}
	discoverModels(input: Parameters<DesktopApi['discoverModels']>[0]) {
		return this.#generation.run((api) => api.discoverModels(input))
	}
	threads(input: Parameters<DesktopApi['threads']>[0]) {
		return this.#generation.run((api) => api.threads(input))
	}
	createThread(input: Parameters<DesktopApi['createThread']>[0]) {
		return this.#generation.run((api) => api.createThread(input))
	}
	snapshot(input: Parameters<DesktopApi['snapshot']>[0]) {
		return this.#generation.run((api) => api.snapshot(input))
	}
	renameThread(input: Parameters<DesktopApi['renameThread']>[0]) {
		return this.#generation.run((api) => api.renameThread(input))
	}
	deleteThread(input: Parameters<DesktopApi['deleteThread']>[0]) {
		return this.#generation.run((api) => api.deleteThread(input))
	}
	prompt(input: Parameters<DesktopApi['prompt']>[0]) {
		return this.#generation.run((api) => api.prompt(input))
	}
	abort(input: Parameters<DesktopApi['abort']>[0]) {
		return this.#generation.run((api) => api.abort(input))
	}
}

export class NativeDesktopRpcTarget extends DesktopRpcTarget implements NativeDesktopApi {
	#generation: ApiGeneration
	constructor(generation: ApiGeneration) {
		super(generation)
		this.#generation = generation
	}
	resolveArtifact(input: { id: string }) {
		return this.#generation.run((api) => api.resolveArtifact(input))
	}
}
