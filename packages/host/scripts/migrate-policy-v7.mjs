import { randomUUID } from 'node:crypto'
import { open, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { parsePluginNodeAddress, pluginDefinitionIndexKey, pluginNodeIndexKey } from '@pluxel/core'
import { createHost } from '@pluxel/host'
import {
	assertPolicyGraphReferences,
	canonicalHostPolicyInput,
	HOST_EXECUTION_POLICY_FIELDS,
	HOST_GLOBAL_POLICY_FIELDS,
	HOST_NODE_POLICY_FIELDS,
	nodePolicyKey,
	snapshotHostPolicy,
} from '@pluxel/host/internal'
import { SuperJSON } from 'superjson'

const legacyDefaults = {
	providerDefaults: [],
	startTimeoutMs: 1500,
	drainTimeoutMs: 3000,
	startConcurrency: 8,
	stopConcurrency: 1,
}
const disabledValue = {
	autoStart: { autoStart: false },
	forks: { deploy: false },
	dependencyOverrides: { providerAddress: null },
}

function record(input, label) {
	if (Array.isArray(input) || input === null || typeof input !== 'object')
		throw new TypeError(`${label} must be an object`)
	return input
}

function legacyPolicy(input) {
	const choices = { ...input }
	for (const field of HOST_NODE_POLICY_FIELDS) {
		if (!Object.hasOwn(input, field)) continue
		if (!Array.isArray(input[field])) throw new TypeError(`v7 policy.${field} must be an array`)
		choices[field] = input[field].map((value) => {
			if (field === 'autoStart') return { node: value, autoStart: true }
			if (field === 'forks') return { node: value, deploy: true }
			const choice = record(value, 'v7 dependency override')
			if (choice.providerAddress === null)
				throw new TypeError('v7 dependency override requires a provider address')
			return choice
		})
	}
	const canonical = { ...canonicalHostPolicyInput(choices, false) }
	for (const field of HOST_NODE_POLICY_FIELDS)
		if (Object.hasOwn(input, field)) canonical[field] ??= []
	return canonical
}

function selectLegacyPolicy(declared, saved, modes) {
	const select = (field) => {
		if (modes[field] === 'saved-first') return saved[field] ?? declared[field]
		return declared[field] ?? (modes[field] === 'declared-first' ? saved[field] : undefined)
	}
	return {
		...Object.fromEntries(
			HOST_GLOBAL_POLICY_FIELDS.map((field) => [field, select(field) ?? legacyDefaults[field]]),
		),
		autoStart: (select('autoStart') ?? []).map(({ node }) => node),
		forks: (select('forks') ?? []).map(({ node }) => node),
		dependencyOverrides: select('dependencyOverrides') ?? [],
	}
}

function preserveMaskedChoices(declared, saved, modes) {
	const adjustments = []
	for (const field of HOST_NODE_POLICY_FIELDS) {
		if (modes[field] === 'declared-only') continue
		const primary = modes[field] === 'saved-first' ? saved : declared
		const secondary = primary === saved ? declared : saved
		if (primary[field] === undefined || secondary[field] === undefined) continue
		const keys = new Set(primary[field].map(nodePolicyKey))
		if (field === 'forks' && primary === declared) {
			// A code declaration can leave deployment to saved policy. The saved choice supplies the veto.
			saved.forks = saved.forks.map((choice) => {
				if (keys.has(nodePolicyKey(choice))) return choice
				const revised = { ...choice, deploy: false }
				adjustments.push({ field, layer: 'saved', before: choice, after: revised })
				return revised
			})
			continue
		}
		const choices = [...primary[field]]
		for (const choice of secondary[field])
			if (!keys.has(nodePolicyKey(choice))) choices.push({ ...choice, ...disabledValue[field] })
		primary[field] = choices
	}
	return adjustments
}

function declarations(declared, modes, unresolved) {
	const byDefinition = new Map()
	function nodeDeclaration(node) {
		const key = pluginDefinitionIndexKey(node.definition)
		if (!byDefinition.has(key)) byDefinition.set(key, { definition: node.definition })
		const plugin = byDefinition.get(key)
		if (node.variant === 'default') return plugin
		plugin.forks ??= Object.create(null)
		return (plugin.forks[node.forkId] ??= { deploy: false })
	}
	for (const { node } of declared.forks ?? []) nodeDeclaration(node).deploy = true
	for (const choice of declared.autoStart ?? []) {
		const row = nodeDeclaration(choice.node)
		if (row.deploy === false && choice.autoStart) {
			unresolved.push({
				field: 'autoStart',
				choice,
				reason: 'A declared startup requires the fork to be declared deployed.',
			})
			continue
		}
		row.autoStart = choice.autoStart
	}
	for (const choice of declared.dependencyOverrides ?? []) {
		const { consumerAddress, requirementAddress, providerAddress } = choice
		const row = nodeDeclaration(consumerAddress)
		if (row.deploy === false) {
			unresolved.push({
				field: 'dependencyOverrides',
				choice,
				reason: 'A declared override requires the consumer fork to be declared deployed.',
			})
			continue
		}
		;(row.dependencyOverrides ??= []).push({ requirementAddress, providerAddress })
	}
	const execution = Object.fromEntries(
		HOST_EXECUTION_POLICY_FIELDS.flatMap((field) =>
			declared[field] === undefined ? [] : [[field, declared[field]]],
		),
	)
	return {
		pluginNodes: [...byDefinition.keys()].sort().map((key) => byDefinition.get(key)),
		policy: {
			...(modes === undefined ? {} : { modes }),
			...(declared.providerDefaults === undefined
				? {}
				: { providerDefaults: declared.providerDefaults }),
			...(Object.keys(execution).length === 0 ? {} : { execution }),
		},
	}
}

function inventory(nodes, ...layers) {
	if (!Array.isArray(nodes)) throw new TypeError('nodes must be an array of node addresses')
	const found = new Map(
		nodes.map((input) => {
			const node = parsePluginNodeAddress(input)
			return [pluginNodeIndexKey(node), node]
		}),
	)
	const remember = (node) => found.set(pluginNodeIndexKey(node), node)
	for (const layer of layers) {
		for (const { node } of [...(layer.autoStart ?? []), ...(layer.forks ?? [])]) remember(node)
		for (const { provider } of layer.providerDefaults ?? []) remember(provider)
		for (const { consumerAddress, providerAddress } of layer.dependencyOverrides ?? []) {
			remember(consumerAddress)
			if (providerAddress !== null) remember(providerAddress)
		}
	}
	return [...found.keys()].sort().map((key) => found.get(key))
}

function projectNodes(graph) {
	const start = new Set(graph.autoStart.map(pluginNodeIndexKey))
	const forks = new Set(graph.forks.map(pluginNodeIndexKey))
	const overrides = new Map()
	for (const {
		consumerAddress,
		requirementAddress,
		providerAddress,
	} of graph.dependencyOverrides) {
		const key = pluginNodeIndexKey(consumerAddress)
		if (!overrides.has(key)) overrides.set(key, [])
		overrides.get(key).push({ requirementAddress, providerAddress })
	}
	return (node) => {
		const key = pluginNodeIndexKey(node)
		return {
			autoStart: start.has(key),
			...(node.variant === 'fork' ? { deploy: forks.has(key) } : {}),
			dependencyOverrides: overrides.get(key) ?? [],
		}
	}
}

async function readConvertedPolicy(declaration, savedText) {
	await using host = await createHost({
		...declaration,
		config: { document: false },
		policy: {
			...declaration.policy,
			document: {
				readOnly: true,
				storage: () => ({
					getText: async () => savedText,
					put: async () => {
						throw new Error('Migration verification storage is read-only')
					},
					stat: async () => undefined,
				}),
			},
		},
	})
	const policy = await host.policy.get()
	if (!policy.ok) throw new Error(policy.message)
	return policy.effective
}

async function planMigration(author, stateText) {
	const { policy, nodes = [], ...other } = record(author, 'author export')
	if (Object.keys(other).length > 0)
		throw new TypeError('Author export accepts only policy and nodes')
	const { mode, ...authorInput } = record(policy, 'v7 authored policy')
	const { version, ...savedInput } = record(SuperJSON.parse(stateText), 'saved v7 policy')
	if (version !== 7)
		throw new TypeError(`Expected saved policy version 7, found ${String(version)}`)
	const declared = legacyPolicy(authorInput)
	const saved = legacyPolicy(savedInput)
	const modes = snapshotHostPolicy({ modes: mode }).mode
	const oldGraph = selectLegacyPolicy(declared, saved, modes)
	assertPolicyGraphReferences(oldGraph)
	const known = inventory(nodes, declared, saved)
	const adjustments = preserveMaskedChoices(declared, saved, modes)
	const unresolved = []
	const declaration = declarations(canonicalHostPolicyInput(declared), mode, unresolved)
	const document = { version: 8, ...canonicalHostPolicyInput(saved) }
	let nextGraph
	try {
		nextGraph = await readConvertedPolicy(declaration, SuperJSON.stringify(document))
	} catch (error) {
		unresolved.push({ reason: error.message, cause: error.cause?.message })
	}
	const oldNode = projectNodes(oldGraph)
	const nextNode = nextGraph && projectNodes(nextGraph)
	const comparison = known.map((node) => {
		const before = oldNode(node)
		const after = nextNode?.(node) ?? null
		if (after !== null && JSON.stringify(before) !== JSON.stringify(after))
			unresolved.push({ node, reason: 'Effective node policy changes.' })
		return { node, before, after }
	})
	const global = HOST_GLOBAL_POLICY_FIELDS.map((field) => {
		const before = oldGraph[field]
		const after = nextGraph?.[field] ?? null
		if (after !== null && JSON.stringify(before) !== JSON.stringify(after))
			unresolved.push({ field, reason: 'Effective application policy changes.' })
		return { field, before, after }
	})
	return {
		declaration,
		document,
		comparison,
		global,
		adjustments,
		unresolved,
		futureKeys:
			'In v8, a missing key inherits eligible inputs. A v7 whole-column veto cannot cover future keys.',
	}
}

async function replaceState(path, original, next) {
	const temporary = `${path}.${randomUUID()}.tmp`
	const metadata = await stat(path)
	const file = await open(temporary, 'wx', metadata.mode & 0o777)
	try {
		try {
			await file.writeFile(next)
			await file.sync()
		} finally {
			await file.close()
		}
		if ((await readFile(path, 'utf8')) !== original)
			throw new Error('state.json changed while preparing migration. Review a new preview.')
		await rename(temporary, path)
	} finally {
		await rm(temporary, { force: true })
	}
}

async function migratePolicyV7({ policy, state, write = false }) {
	const path = await realpath(state)
	const [authorText, stateText] = await Promise.all([
		readFile(policy, 'utf8'),
		readFile(path, 'utf8'),
	])
	const plan = await planMigration(JSON.parse(authorText), stateText)
	const written = write && plan.unresolved.length === 0
	if (written) await replaceState(path, stateText, SuperJSON.stringify(plan.document))
	return { ...plan, written }
}

if (import.meta.main) {
	try {
		const { values } = parseArgs({
			options: {
				policy: { type: 'string' },
				state: { type: 'string' },
				write: { type: 'boolean' },
			},
		})
		if (!values.policy || !values.state)
			throw new Error(
				'Usage: migrate-policy-v7.mjs --policy author.json --state state.json [--write]',
			)
		const result = await migratePolicyV7(values)
		console.log(JSON.stringify(result, null, 2))
		if (values.write && !result.written) process.exitCode = 1
	} catch (error) {
		console.error(error.message)
		process.exitCode = 1
	}
}
