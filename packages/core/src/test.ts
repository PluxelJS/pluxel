import { getAssetAsBlob } from 'node:sea'
import { ContainerBuilder, Service } from 'diod'
import 'reflect-metadata'

// 定义三个测试服务
@Service()
class TestA {
	a = 1
} // 测试 Singleton

@Service()
class TestB {} // 测试 Scoped

@Service()
class TestC {} // 测试 Transient

// 初始化 ContainerBuilder

const builder = new ContainerBuilder()

// 注册不同生命周期的服务
builder.registerAndUse(TestA).asBuilderSingleton() // 单例模式
builder.registerAndUse(TestB).asSingleton() // 作用域模式
builder.registerAndUse(TestC).asTransient() // 瞬态模式

// 第一次 build() -> 生成 container1
const container1 = builder.build()
const a1 = container1.get(TestA) // Singleton
const b1 = container1.get(TestB) // Scoped（作用域1）
const c1 = container1.get

a1.a++

// 第二次 build() -> 生成 container2（复用同一个 builder）
const container2 = builder.build()
const a2 = container2.get(TestA) // Singleton
const b2 = container2.get(TestB) // Scoped（作用域2）
const c2 = container2.get(TestC) // Transient

// 测试 Singleton
console.log('Singleton Test:')
console.log('a1 === a2?', a1 === a2) // true（全局唯一）
console.log(a1.a, a2.a) // true（全局唯一）

// 测试 Scoped
console.log('\nScoped Test:')
const b1_again = container1.get(TestB) // 再次从 container1 获取
console.log('b1 === b1_again?', b1 === b1_again) // true（同一作用域单例）
console.log('b1 === b2?', b1 === b2) // false（不同作用域）

// 测试 Transient
console.log('\nTransient Test:')
const c1_again = container1.get(TestC) // 再次从 container1 获取
console.log('c1 === c1_again?', c1 === c1_again) // false（每次都是新实例）
console.log('c1 === c2?', c1 === c2) // false（不同 build() 也是新实例）
