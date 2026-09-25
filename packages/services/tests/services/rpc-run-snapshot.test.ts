import { expect, it } from 'vitest'
import { captureRpcRunInput } from '../../src/rpc/executor'
import type { RpcDescription, RpcKernelSession } from '../../src/rpc/kernel'

function description(id: string, method: string): RpcDescription {
	return {
		sessionId: 'session',
		id,
		hash: 'a'.repeat(64),
		generation: 1,
		methods: [{ method, command: `${id}.${method}`, description: method, inputSchema: {} }],
		types: [{ method, input: '{}', success: 'null' }],
		declaration: `export interface RpcClient { open(id: '${id}'): unknown }`,
	}
}

it('pins a run selection before caller-owned input changes', () => {
	const selected = [description('notes', 'read')]
	const submitted = {
		session: {} as RpcKernelSession,
		contracts: selected,
		code: "return await rpc.open('notes').read({})",
	}
	const captured = captureRpcRunInput(submitted)
	selected.push(description('notes', 'write'))
	submitted.contracts = [description('admin', 'delete')]
	submitted.code = "return await rpc.open('admin').delete({})"
	expect(captured.contracts).toEqual([selected[0]])
	expect(captured.contracts?.[0]).toBe(selected[0])
	expect(Object.isFrozen(captured.contracts)).toBe(true)
	expect(captured.code).toBe("return await rpc.open('notes').read({})")
})
