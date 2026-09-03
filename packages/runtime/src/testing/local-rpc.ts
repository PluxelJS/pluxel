import { RpcStub, RpcTarget as CapnwebRpcTarget } from 'capnweb'
import type { RpcTarget } from '../capnweb'

/**
 * Creates a local Cap'n Web client for an object contract.
 *
 * The target is borrowed: disposing the client releases only the client capability graph and
 * never invokes the target's disposer. Child capabilities returned by target methods keep their
 * ordinary Cap'n Web ownership contract. This helper does not test an HTTP or WebSocket transport.
 */
export function createLocalRpcClient<Api extends RpcTarget>(target: Api): RpcStub<Api> {
	return new RpcStub<Api>(borrowRpcTarget(target) as Api)
}

function borrowRpcTarget<Api extends RpcTarget>(target: Api): RpcTarget {
	if (!(target instanceof CapnwebRpcTarget)) {
		throw new TypeError('[pluxel/test] createLocalRpcClient() requires an RpcTarget instance')
	}
	const adapter = new (class extends CapnwebRpcTarget {})()
	return new Proxy(adapter, {
		get(_receiver, property) {
			if (property === Symbol.dispose || property === Symbol.asyncDispose) return undefined
			const value = Reflect.get(target, property, target) as unknown
			return typeof value === 'function'
				? (...args: readonly unknown[]) => Reflect.apply(value, target, args)
				: value
		},
		set(_receiver, property, value) {
			return Reflect.set(target, property, value, target)
		},
		has(_receiver, property) {
			// The adapter deliberately does not inherit the borrowed target's cleanup ownership.
			if (property === Symbol.dispose || property === Symbol.asyncDispose) return false
			return Reflect.has(target, property)
		},
	})
}
