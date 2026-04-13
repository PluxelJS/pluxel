import { ContainerBuilder, type Newable } from '../../src'

const autoregisteredClasses: Newable<unknown>[] = []

const isNewable = (target: unknown): target is Newable<unknown> => {
	if (typeof target !== 'function') {
		return false
	}

	const prototype = target.prototype
	return !!prototype && !!prototype.constructor
}

/**
 * Example of a decorator to autoregister classes.
 * @returns
 */
export const RegisterService = (): ClassDecorator => {
	return (target) => {
		if (isNewable(target)) {
			autoregisteredClasses.push(target)
		} else {
			throw new Error('Abstract classes cannot be auto registered')
		}

		return target
	}
}

export const autoregister = (builder: ContainerBuilder): ContainerBuilder => {
	for (const service of autoregisteredClasses) {
		builder.registerAndUse(service)
	}

	return builder
}
