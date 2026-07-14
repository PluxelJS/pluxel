import { RpcTarget } from '@pluxel/runtime/capnweb'
import type { ChatSandboxPlugin } from './plugin.ts'
import type { SandboxInput } from './workbench-contract.ts'

export class ChatSandboxRpc extends RpcTarget {
	constructor(private readonly sandbox: ChatSandboxPlugin) {
		super()
	}
	send(input: SandboxInput) {
		return this.sandbox.accept(input)
	}
	reset() {
		return this.sandbox.reset()
	}
	status() {
		return this.sandbox.status()
	}
}
