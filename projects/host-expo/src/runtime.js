import { getRandomValues, randomUUID } from 'expo-crypto'

// The browser Host and ZenFS read these methods during module initialization.
globalThis.crypto ??= {}
globalThis.crypto.getRandomValues ??= getRandomValues
globalThis.crypto.randomUUID ??= randomUUID

// Use the same fallback keys as Babel's explicit resource management transform.
for (const name of ['dispose', 'asyncDispose']) {
	if (!Symbol[name]) Object.defineProperty(Symbol, name, { value: Symbol.for(`Symbol.${name}`) })
}
