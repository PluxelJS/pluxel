import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Bench } from 'tinybench'
import { ContainerBuilder } from 'diod'
import { DraftGraph, Runtime, classProvider } from '../dist/bench/index.mjs'

type BenchCase = {
	id: string
	label: string
	runCoreDi: () => void
	runDiod: () => void
}
type ComparisonRow = {
	id: string
	label: string
	coreOps: number
	diodOps: number
	coreLatencyUs: number
	diodLatencyUs: number
	speedup: number
	winner: 'core-di' | 'diod'
}

const BENCH_TIME_MS = Number(process.env.PLUXEL_DI_BENCH_TIME_MS ?? 500)
const WARMUP_TIME_MS = Number(process.env.PLUXEL_DI_WARMUP_MS ?? 100)
const CHAIN_SIZE = Number(process.env.PLUXEL_DI_CHAIN_SIZE ?? 64)
const STAR_SIZE = Number(process.env.PLUXEL_DI_STAR_SIZE ?? 128)
const BENCH_ROUNDS = Math.max(1, Number(process.env.PLUXEL_DI_BENCH_ROUNDS ?? 1))
type ClassCtor<T = object> = new (...args: any[]) => T
type BenchTask = Bench['tasks'][number]

const namedClass = (name: string, Base?: ClassCtor): ClassCtor => {
	const Ctor = Base ? class extends Base {} : class {}
	Object.defineProperty(Ctor, 'name', { value: name })
	return Ctor
}

const mustCoreBuild = <M>(draft: DraftGraph<M>) => {
	const built = draft.build()
	if (built.ok === true) return built.val
	throw built.err
}

const mustDiodBuild = (builder: ContainerBuilder) => {
	const built = builder.build({ autowire: false, aliasPolicy: 'error' })
	if (!built.ok) throw built.err
	return built.val
}

const createCoreChain = (count: number, cache: 'retain' | 'fresh') => {
	const ctors = Array.from({ length: count }, (_, i) => namedClass(`CoreChain${i}`) as ClassCtor)
	const draft = new DraftGraph()
	for (let i = 0; i < ctors.length; i++) {
		const Ctor = ctors[i]!
		draft.put(
			classProvider({
				key: Ctor,
				use: Ctor,
				cache,
				deps: i === 0 ? [] : [ctors[i - 1]!],
			}),
		)
	}
	return { draft, ctors, root: ctors[ctors.length - 1]! }
}

const createDiodChain = (count: number, scope: 'singleton' | 'transient') => {
	const ctors = Array.from({ length: count }, (_, i) => namedClass(`DiodChain${i}`) as ClassCtor)
	const builder = new ContainerBuilder()
	for (let i = 0; i < ctors.length; i++) {
		const Ctor = ctors[i]!
		const reg = builder.registerAndUse(Ctor).withDependencies(i === 0 ? [] : [ctors[i - 1]!])
		if (scope === 'singleton') reg.asSingleton()
		else reg.asTransient()
	}
	return { builder, ctors, root: ctors[ctors.length - 1]! }
}

const createCoreStar = (count: number) => {
	const Base = namedClass('CoreBase') as ClassCtor
	const RootA = namedClass('CoreRootA', Base as any) as ClassCtor
	const RootB = namedClass('CoreRootB', Base as any) as ClassCtor
	const leafs = Array.from({ length: count }, (_, i) => namedClass(`CoreLeaf${i}`) as ClassCtor)
	const extraLeaf = namedClass('CoreExtraLeaf') as ClassCtor
	const draft = new DraftGraph()
	draft.put(classProvider({ key: RootA, tokens: [Base], use: RootA, deps: [] }))
	for (const Leaf of leafs) {
		draft.put(classProvider({ key: Leaf, use: Leaf, deps: [Base] }))
	}
	return { draft, Base, RootA, RootB, leafs, extraLeaf }
}

const createDiodStar = (count: number) => {
	const Base = namedClass('DiodBase') as ClassCtor
	const RootA = namedClass('DiodRootA', Base as any) as ClassCtor
	const RootB = namedClass('DiodRootB', Base as any) as ClassCtor
	const leafs = Array.from({ length: count }, (_, i) => namedClass(`DiodLeaf${i}`) as ClassCtor)
	const extraLeaf = namedClass('DiodExtraLeaf') as ClassCtor
	const builder = new ContainerBuilder()
	builder.registerAndUse(RootA).withDependencies([]).asSingleton().addAlias(Base)
	for (const Leaf of leafs) {
		builder.registerAndUse(Leaf).withDependencies([Base]).asSingleton()
	}
	return { builder, Base, RootA, RootB, leafs, extraLeaf }
}

const createCoreReplaceAliasStar = (count: number) => {
	const RootA = namedClass('CoreReplaceRootA') as ClassCtor
	const RootB = namedClass('CoreReplaceRootB') as ClassCtor
	const leafs = Array.from(
		{ length: count },
		(_, i) => namedClass(`CoreReplaceLeaf${i}`) as ClassCtor,
	)
	const draft = new DraftGraph()
	draft.put(classProvider({ key: RootA, use: RootA, deps: [] }))
	for (const Leaf of leafs) {
		draft.put(classProvider({ key: Leaf, use: Leaf, deps: [RootA] }))
	}
	return { draft, RootA, RootB, leafs }
}

const createDiodReplaceAliasStar = (count: number) => {
	const RootA = namedClass('DiodReplaceRootA') as ClassCtor
	const RootB = namedClass('DiodReplaceRootB') as ClassCtor
	const leafs = Array.from(
		{ length: count },
		(_, i) => namedClass(`DiodReplaceLeaf${i}`) as ClassCtor,
	)
	const builder = new ContainerBuilder()
	builder.registerAndUse(RootA).withDependencies([]).asSingleton()
	for (const Leaf of leafs) {
		builder.registerAndUse(Leaf).withDependencies([RootA]).asSingleton()
	}
	return { builder, RootA, RootB, leafs }
}

const createCases = (): BenchCase[] => {
	const noOpCore = createCoreChain(CHAIN_SIZE, 'retain')
	mustCoreBuild(noOpCore.draft).commit()

	const noOpDiod = createDiodChain(CHAIN_SIZE, 'singleton')
	mustDiodBuild(noOpDiod.builder)

	const addRemoveCore = createCoreStar(STAR_SIZE)
	mustCoreBuild(addRemoveCore.draft).commit()
	let coreLeafPresent = false

	const addRemoveDiod = createDiodStar(STAR_SIZE)
	mustDiodBuild(addRemoveDiod.builder)
	let diodLeafPresent = false

	const replaceCore = createCoreStar(STAR_SIZE)
	mustCoreBuild(replaceCore.draft).commit()
	let coreCurrentRoot = replaceCore.RootA

	const replaceDiod = createDiodStar(STAR_SIZE)
	mustDiodBuild(replaceDiod.builder)
	let diodCurrentRoot = replaceDiod.RootA

	const replaceAliasCore = createCoreReplaceAliasStar(STAR_SIZE)
	mustCoreBuild(replaceAliasCore.draft).commit()
	let coreCurrentAliasRoot = replaceAliasCore.RootA

	const replaceAliasDiod = createDiodReplaceAliasStar(STAR_SIZE)
	mustDiodBuild(replaceAliasDiod.builder)
	let diodCurrentAliasRoot = replaceAliasDiod.RootA

	const resolveCore = createCoreStar(STAR_SIZE)
	mustCoreBuild(resolveCore.draft).commit()
	const resolveCoreRuntime = new Runtime(resolveCore.draft.graph, resolveCore.draft.instances)
	resolveCoreRuntime.ensureByToken(resolveCore.Base)

	const resolveDiod = createDiodStar(STAR_SIZE)
	const resolveDiodContainer = mustDiodBuild(resolveDiod.builder)
	resolveDiodContainer.get(resolveDiod.Base)

	const transientCore = createCoreChain(Math.max(8, Math.floor(CHAIN_SIZE / 2)), 'fresh')
	mustCoreBuild(transientCore.draft).commit()
	const transientCoreRuntime = new Runtime(transientCore.draft.graph, transientCore.draft.instances)

	const transientDiod = createDiodChain(Math.max(8, Math.floor(CHAIN_SIZE / 2)), 'transient')
	const transientDiodContainer = mustDiodBuild(transientDiod.builder)

	return [
		{
			id: 'cold-full-build-chain',
			label: `Cold full build chain x${CHAIN_SIZE}`,
			runCoreDi: () => {
				const { draft } = createCoreChain(CHAIN_SIZE, 'retain')
				mustCoreBuild(draft).commit()
			},
			runDiod: () => {
				const { builder } = createDiodChain(CHAIN_SIZE, 'singleton')
				mustDiodBuild(builder)
			},
		},
		{
			id: 'cold-build-and-first-resolve-chain',
			label: `Cold build + first resolve chain x${CHAIN_SIZE}`,
			runCoreDi: () => {
				const { draft, root } = createCoreChain(CHAIN_SIZE, 'retain')
				const built = mustCoreBuild(draft)
				built.commit()
				new Runtime(draft.graph, draft.instances).ensureByKey(root)
			},
			runDiod: () => {
				const { builder, root } = createDiodChain(CHAIN_SIZE, 'singleton')
				mustDiodBuild(builder).get(root)
			},
		},
		{
			id: 'hot-noop-build-chain',
			label: `Hot no-op build chain x${CHAIN_SIZE}`,
			runCoreDi: () => {
				mustCoreBuild(noOpCore.draft).commit()
			},
			runDiod: () => {
				mustDiodBuild(noOpDiod.builder)
			},
		},
		{
			id: 'hot-add-remove-leaf-star',
			label: `Hot add/remove leaf star x${STAR_SIZE}`,
			runCoreDi: () => {
				if (!coreLeafPresent) {
					addRemoveCore.draft.put(
						classProvider({
							key: addRemoveCore.extraLeaf,
							use: addRemoveCore.extraLeaf,
							deps: [addRemoveCore.Base],
						}),
					)
				} else addRemoveCore.draft.remove(addRemoveCore.extraLeaf)
				mustCoreBuild(addRemoveCore.draft).commit()
				coreLeafPresent = !coreLeafPresent
			},
			runDiod: () => {
				if (!diodLeafPresent) {
					addRemoveDiod.builder
						.registerAndUse(addRemoveDiod.extraLeaf)
						.withDependencies([addRemoveDiod.Base])
						.asSingleton()
				} else addRemoveDiod.builder.unregister(addRemoveDiod.extraLeaf)
				mustDiodBuild(addRemoveDiod.builder)
				diodLeafPresent = !diodLeafPresent
			},
		},
		{
			id: 'hot-retarget-base-star',
			label: `Hot base retarget star x${STAR_SIZE}`,
			runCoreDi: () => {
				const nextRoot =
					coreCurrentRoot === replaceCore.RootA ? replaceCore.RootB : replaceCore.RootA
				replaceCore.draft.remove(coreCurrentRoot)
				replaceCore.draft.put(
					classProvider({
						key: nextRoot,
						tokens: [replaceCore.Base],
						use: nextRoot,
						deps: [],
					}),
				)
				mustCoreBuild(replaceCore.draft).commit()
				coreCurrentRoot = nextRoot
			},
			runDiod: () => {
				const nextRoot =
					diodCurrentRoot === replaceDiod.RootA ? replaceDiod.RootB : replaceDiod.RootA
				replaceDiod.builder.unregister(diodCurrentRoot)
				replaceDiod.builder
					.registerAndUse(nextRoot)
					.withDependencies([])
					.asSingleton()
					.addAlias(replaceDiod.Base)
				mustDiodBuild(replaceDiod.builder)
				diodCurrentRoot = nextRoot
			},
		},
		{
			id: 'hot-replace-root-alias-star',
			label: `Hot replace root with old-token alias star x${STAR_SIZE}`,
			runCoreDi: () => {
				const nextRoot =
					coreCurrentAliasRoot === replaceAliasCore.RootA
						? replaceAliasCore.RootB
						: replaceAliasCore.RootA
				if (nextRoot === replaceAliasCore.RootA) {
					replaceAliasCore.draft.replace(
						coreCurrentAliasRoot,
						classProvider({
							key: nextRoot,
							use: nextRoot,
							deps: [],
						}),
					)
				} else {
					replaceAliasCore.draft.replace(
						coreCurrentAliasRoot,
						classProvider({
							key: nextRoot,
							tokens: [replaceAliasCore.RootA],
							use: nextRoot,
							deps: [],
						}),
					)
				}
				mustCoreBuild(replaceAliasCore.draft).commit()
				coreCurrentAliasRoot = nextRoot
			},
			runDiod: () => {
				const nextRoot =
					diodCurrentAliasRoot === replaceAliasDiod.RootA
						? replaceAliasDiod.RootB
						: replaceAliasDiod.RootA
				replaceAliasDiod.builder.unregister(diodCurrentAliasRoot)
				const reg = replaceAliasDiod.builder
					.registerAndUse(nextRoot)
					.withDependencies([])
					.asSingleton()
				if (nextRoot === replaceAliasDiod.RootB) reg.addAlias(replaceAliasDiod.RootA)
				mustDiodBuild(replaceAliasDiod.builder)
				diodCurrentAliasRoot = nextRoot
			},
		},
		{
			id: 'hot-resolve-base-singleton',
			label: `Hot resolve base singleton star x${STAR_SIZE}`,
			runCoreDi: () => {
				resolveCoreRuntime.ensureByToken(resolveCore.Base)
			},
			runDiod: () => {
				resolveDiodContainer.get(resolveDiod.Base)
			},
		},
		{
			id: 'hot-resolve-transient-chain',
			label: `Hot resolve transient chain x${Math.max(8, Math.floor(CHAIN_SIZE / 2))}`,
			runCoreDi: () => {
				transientCoreRuntime.ensureByKey(transientCore.root)
			},
			runDiod: () => {
				transientDiodContainer.get(transientDiod.root)
			},
		},
	]
}

const median = (values: readonly number[]): number => {
	if (values.length === 0) return Number.NaN
	const sorted = [...values].sort((a, b) => a - b)
	const mid = Math.floor(sorted.length / 2)
	return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

const taskPeriod = (task: BenchTask | undefined): number => {
	const result = task?.result
	return result && 'period' in result ? result.period : Number.POSITIVE_INFINITY
}

const runRound = async (): Promise<ComparisonRow[]> => {
	const bench = new Bench({
		time: BENCH_TIME_MS,
		warmupTime: WARMUP_TIME_MS,
	})
	const cases = createCases()
	for (const testCase of cases) {
		bench.add(`${testCase.id}:core-di`, testCase.runCoreDi)
		bench.add(`${testCase.id}:diod`, testCase.runDiod)
	}

	await bench.run()

	const taskMap = new Map(bench.tasks.map((task) => [task.name, task]))
	return cases.map((testCase) => {
		const coreTask = taskMap.get(`${testCase.id}:core-di`)
		const diodTask = taskMap.get(`${testCase.id}:diod`)
		const corePeriod = taskPeriod(coreTask)
		const diodPeriod = taskPeriod(diodTask)
		const coreHz = Number.isFinite(corePeriod) && corePeriod > 0 ? 1_000 / corePeriod : 0
		const diodHz = Number.isFinite(diodPeriod) && diodPeriod > 0 ? 1_000 / diodPeriod : 0
		const coreLatencyUs = corePeriod * 1_000
		const diodLatencyUs = diodPeriod * 1_000
		const speedup = diodHz > 0 ? coreHz / diodHz : Number.POSITIVE_INFINITY
		return {
			id: testCase.id,
			label: testCase.label,
			coreOps: coreHz,
			diodOps: diodHz,
			coreLatencyUs,
			diodLatencyUs,
			speedup,
			winner: speedup >= 1 ? 'core-di' : 'diod',
		}
	})
}

const rounds: ComparisonRow[][] = []
for (let round = 0; round < BENCH_ROUNDS; round++) rounds.push(await runRound())

const comparison = rounds[0]!.map((row, index) => {
	const samples = rounds.map((round) => round[index]!)
	const coreOps = median(samples.map((sample) => sample.coreOps))
	const diodOps = median(samples.map((sample) => sample.diodOps))
	const coreLatencyUs = median(samples.map((sample) => sample.coreLatencyUs))
	const diodLatencyUs = median(samples.map((sample) => sample.diodLatencyUs))
	const speedup = diodOps > 0 ? coreOps / diodOps : Number.POSITIVE_INFINITY
	return {
		id: row.id,
		label: row.label,
		coreOps,
		diodOps,
		coreLatencyUs,
		diodLatencyUs,
		speedup,
		winner: speedup >= 1 ? 'core-di' : 'diod',
		rounds: samples,
	}
})

const table = comparison.map((row) => ({
	Scenario: row.label,
	'core-di ops/s': row.coreOps.toFixed(0),
	'diod ops/s': row.diodOps.toFixed(0),
	'core-di us/op': row.coreLatencyUs.toFixed(2),
	'diod us/op': row.diodLatencyUs.toFixed(2),
	Speedup:
		row.speedup >= 1 ? `${row.speedup.toFixed(2)}x` : `${(1 / row.speedup).toFixed(2)}x slower`,
	Winner: row.winner,
}))

console.table(table)

const benchmarksDir = new URL('../benchmarks/', import.meta.url)
mkdirSync(fileURLToPath(benchmarksDir), { recursive: true })

const jsonReport = {
	recordedAt: new Date().toISOString(),
	options: {
		timeMs: BENCH_TIME_MS,
		warmupTimeMs: WARMUP_TIME_MS,
		rounds: BENCH_ROUNDS,
		chainSize: CHAIN_SIZE,
		starSize: STAR_SIZE,
	},
	rows: comparison,
}

const markdown = [
	'# core-di vs diod benchmark',
	'',
	`- Time per task: ${BENCH_TIME_MS}ms`,
	`- Warmup per task: ${WARMUP_TIME_MS}ms`,
	`- Rounds (median): ${BENCH_ROUNDS}`,
	`- Chain size: ${CHAIN_SIZE}`,
	`- Star size: ${STAR_SIZE}`,
	'',
	'| Scenario | core-di ops/s | diod ops/s | core-di us/op | diod us/op | Speedup | Winner |',
	'| --- | ---: | ---: | ---: | ---: | ---: | --- |',
	...comparison.map(
		(row) =>
			`| ${row.label} | ${row.coreOps.toFixed(0)} | ${row.diodOps.toFixed(0)} | ${row.coreLatencyUs.toFixed(2)} | ${row.diodLatencyUs.toFixed(2)} | ${row.speedup.toFixed(2)}x | ${row.winner} |`,
	),
	'',
].join('\n')

writeFileSync(new URL('di-kernel-vs-diod.json', benchmarksDir), JSON.stringify(jsonReport, null, 2))
writeFileSync(new URL('di-kernel-vs-diod.md', benchmarksDir), markdown, 'utf8')
