// tests/builder.spec.ts
import 'reflect-metadata'
import { describe, expect, it } from 'bun:test'
import { ContainerBuilder } from '../src'
import {
	ServiceVerificationAggregateError,
	type VerificationError,
} from '../src/verifier'
import { expectErr, expectExist, expectOk } from './_helpers'
import { Agenda, Schedule } from './fixtures/agenda'
import {
	Circular1,
	Circular2,
	Circular3,
	circular1,
	circular2,
} from './fixtures/circular'
import { Clock } from './fixtures/clock'
import { Routes } from './fixtures/extended-classes'
import { NotDecorated } from './fixtures/not-decorated'
import { NotPerson } from './fixtures/not-person'
import { BankUser } from './fixtures/user'

/**
 * 小工具：断言 build 的 Err 是聚合错误，并返回该错误对象（强类型）
 */
const expectBuildErr = (r: ReturnType<ContainerBuilder['build']>) => {
	const e = expectErr(r, 'expected build to be Err')
	expect(e).toBeInstanceOf(ServiceVerificationAggregateError)
	return e
}

describe('build-time validations and registry ops', () => {
	it('throws error when there is not completed registration', () => {
		// Arrange
		const builder = new ContainerBuilder()
		expectOk(builder.tryRegister(NotDecorated)) // 只 register，没有 use

		// Assert
		const e = expectBuildErr(builder.build())
		// 你现有实现里会生成对应信息；这里用 format() 做包含断言即可
		expect(e.format()).toContain('registration is not completed')
		expect(e.format()).toContain('NotDecorated')
	})

	it('throws error when asked for a not decorated service with constructor dependencies', () => {
		const builder = new ContainerBuilder()
		// 直接 use 未装饰但带依赖的服务
		expectOk(builder.tryRegisterAndUse(NotDecorated))

		const e = expectBuildErr(builder.build())
		// 信息包含 "Service not decorated"
		expect(e.format()).toContain('Service not decorated')
		expect(e.format()).toContain('NotDecorated')
	})

	it('throws error building a container with a registered service which has unregistered dependencies', () => {
		const builder = new ContainerBuilder()
		expectOk(builder.tryRegisterAndUse(Agenda))

		const e = expectBuildErr(builder.build())
		// 缺失依赖属于 MissingDependency
		const hasMissing = e.errors.some((x) => x.kind === 'MissingDependency')
		expect(hasMissing).toBeTrue()
		// 人类可读信息包含目标类名
		expect(e.format()).toContain('Agenda')
	})

	it('throws error when a dependency has unregistered dependencies', () => {
		const builder = new ContainerBuilder()
		expectOk(builder.tryRegister(Schedule)).use(Schedule)
		expectOk(builder.tryRegister(Agenda)).use(Agenda)

		const e = expectBuildErr(builder.build())
		const hasMissing = e.errors.some((x) => x.kind === 'MissingDependency')
		expect(hasMissing).toBeTrue()
		expect(e.format()).toContain('Agenda')
	})

	it('throws error when service without constructor extends not decorated service with constructor dependencies', () => {
		const builder = new ContainerBuilder()
		expectOk(builder.tryRegisterAndUse(NotPerson))

		const e = expectBuildErr(builder.build())
		// 你的实现通常会输出 NotPerson -> NotDecorated 的链
		expect(e.format()).toContain('NotPerson')
		expect(e.format()).toContain('NotDecorated')
		expect(e.format()).toContain('Service not decorated')
	})

	it('does not throw when service with parameter-less constructor extends not decorated service with ctor deps', () => {
		const builder = new ContainerBuilder()
		expectOk(builder.tryRegisterAndUse(Routes))
		const container = expectOk(builder.build())

		const routes = expectExist(container.get(Routes))
		expect(routes.constructor.name).toBe('Routes')
		expect(routes.getRoute()).toBe('aRoute')
	})

	it('throws error when needed dependencies are not provided for non autowired service', () => {
		const builder = new ContainerBuilder()
		expectOk(builder.tryRegisterAndUse(BankUser))

		const e = expectBuildErr(builder.build({ autowire: false }))
		// 至少应包含 MissingDependency
		const hasMissing = e.errors.some((x) => x.kind === 'MissingDependency')

		const hasInsufficient = e.errors.some(
			(
				x,
			): x is Extract<
				VerificationError,
				{ kind: 'InsufficientExplicitDependencies' }
			> => x.kind === 'InsufficientExplicitDependencies',
			// 可选：进一步限定就是 BankUser
			// && x.id === (BankUser as unknown as Identifier<unknown>)
		)

		expect(hasMissing || hasInsufficient).toBeTrue()
		expect(e.format()).toContain('BankUser') // 保持可读断言
	})

	it('throws error if circular dependencies are detected', () => {
		const builder = new ContainerBuilder()
		expectOk(builder.tryRegisterAndUse(Circular1)).withDependencies([Circular2])
		expectOk(builder.tryRegisterAndUse(Circular2)).withDependencies([Circular3])
		expectOk(builder.tryRegisterAndUse(Circular3)).withDependencies([Circular1])

		const e = expectBuildErr(builder.build({ autowire: false }))
		// 类型安全：检查 CircularDependency
		const cycle = e.errors.find(
			(x): x is Extract<VerificationError, { kind: 'CircularDependency' }> =>
				x.kind === 'CircularDependency',
		)
		expect(Boolean(cycle)).toBeTrue()
		// 链名字应包含环
		if (cycle) {
			const names = cycle.chain.map((id) => (id as any).name ?? '(anonymous)')
			expect(names.join(' -> ')).toContain('Circular1')
			expect(names.join(' -> ')).toContain('Circular2')
			expect(names.join(' -> ')).toContain('Circular3')
		}
	})

	it('does not throw circular dependency error when different classes with the same name are used', () => {
		const builder = new ContainerBuilder()
		expectOk(builder.tryRegisterAndUse(circular1.Circular1))
		expectOk(builder.tryRegisterAndUse(circular2.Circular1)).withDependencies([
			circular2.Circular2,
		])
		expectOk(builder.tryRegisterAndUse(circular2.Circular2)).withDependencies([
			circular1.Circular1,
		])

		// 成功构建
		expectOk(builder.build({ autowire: false }))
	})

	it('throws error if service is registered twice', () => {
		const builder = new ContainerBuilder()
		expectOk(builder.tryRegisterAndUse(Clock))

		// 再注册同一个：返回 Err(AlreadyRegistered)
		const r = builder.tryRegisterAndUse(Clock)
		const regErr = expectErr(r, 'should be AlreadyRegistered')
		expect(regErr.kind).toBe('AlreadyRegistered')
		// 可选：校验 id
		// expect(regErr.id).toBe(Clock)
	})

	it('throws unregistering not registered service', () => {
		const builder = new ContainerBuilder()
		expectOk(builder.tryRegisterAndUse(Clock))

		const r = builder.tryUnregister(Circular1)
		const success = expectOk(
			r,
			'no NotRegistered any more when unregistering unknown id',
		)
		expect(success).toBe(false)
		// expect(unregErr.id).toBe(Circular1)
	})

	it('services can be unregistered', () => {
		const builder = new ContainerBuilder()
		expectOk(builder.tryRegisterAndUse(Clock))

		expectOk(builder.tryUnregister(Clock))
		expect(builder.isRegistered(Clock)).toBeFalse()
	})

	it('can query if a service is registe red', () => {
		const builder = new ContainerBuilder()
		expectOk(builder.tryRegisterAndUse(Clock))

		const isClockRegistered = builder.isRegistered(Clock)
		const isCircular1Registered = builder.isRegistered(Circular1)

		expect(isClockRegistered).toBeTrue()
		expect(isCircular1Registered).toBeFalse()
	})
})
