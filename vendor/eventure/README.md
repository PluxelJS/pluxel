<h1 align="center">Eventure</h1>

<p align="center">
<b>Eventure</b> 是一个类型友好的事件库。除了常规事件注册和触发，它重点支持 <a href="#功能与示例">调用方中断、监听方短路、条件监听、等待下一次事件</a> 等控制流能力，并把高频触发路径作为主要性能优化目标，见 <a href="#性能">性能</a>。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/eventure"><img src="https://img.shields.io/npm/v/eventure?style=flat-square" alt="NPM version"></a>
  <a href="https://github.com/Kokoro-js/Eventure/actions/workflows/test.yml"><img src="https://github.com/Kokoro-js/Eventure/actions/workflows/test.yml/badge.svg" alt="Test status"></a>
  <a href="https://github.com/Kokoro-js/Eventure/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/eventure?style=flat-square" alt="License"></a>
</p>

## 安装

```bash
npx nypm add eventure
```

## 基础用法

```ts
import { Eventure } from 'eventure'

interface Events {
	message: [text: string]
	sum: (a: number, b: number) => number
}

const events = new Eventure<Events>()

const unsubscribe = events.on('message', (text) => {
	console.log(text)
})

events.emit('message', 'hello')
unsubscribe()

events.on('sum', (a, b) => a + b)
const results = await events.emitAll('sum', 1, 2)
```

无返回值事件用 tuple 写；关心 listener 返回值时，用函数签名写。完整方法说明见 [API.md](./API.md)。

## 功能与示例

测试文件同时作为可运行示例：

- 调用方控制中断：[fire / fireAsync](https://github.com/Kokoro-js/Eventure/blob/main/tests/fire.test.ts) 逐个产出 listener 的 `success` / `error` / `async` 结果；调用方可以 `break` / `return`，后续 listener 不会继续执行。
- 监听方控制短路：[waterfall](https://github.com/Kokoro-js/Eventure/blob/main/tests/waterfall.test.ts) 让 listener 通过 `next` 串联；某个 listener 不调用 `next` 时流水线停止，并返回 `{ ok: false, value }`。
- 单事件通道：[EvtChannel](https://github.com/Kokoro-js/Eventure/blob/main/tests/channel.test.ts) 适合只管理一个事件的场景，方法与 `Eventure` 基本一致但不需要事件名。
- 条件、限次与位置监听：[once / many](https://github.com/Kokoro-js/Eventure/blob/main/tests/onceMany.test.ts)、[when](https://github.com/Kokoro-js/Eventure/blob/main/tests/when.test.ts) 和 [at scope](https://github.com/Kokoro-js/Eventure/blob/main/tests/scope.test.ts) 支持一次性、限次、带 predicate 和指定插入位置的监听。
- 等待下一次事件：[waitFor](https://github.com/Kokoro-js/Eventure/blob/main/tests/waitFor.test.ts) 支持过滤、超时、取消和 `AbortSignal`。
- 批量收集结果：[emitAll / emitSettled](https://github.com/Kokoro-js/Eventure/blob/main/tests/emitAllSettled.test.ts) 分别对应快速失败和 settled 结果收集。
- 基础行为：[Eventure 基础测试](https://github.com/Kokoro-js/Eventure/blob/main/tests/index.test.ts) 覆盖注册、触发、退订和异步错误处理。

## 性能

Benchmark 源码见 [tinybench/onlyEmit.ts](https://github.com/Kokoro-js/Eventure/blob/main/tinybench/onlyEmit.ts)，设计说明见 [PERFORMANCE.md](./PERFORMANCE.md)。

每个 sample 内部执行 `100_000` 次 emit，尽量摊薄 benchmark 自身的调度开销。主要性能收益来自 Copy-On-Write 的监听器数组设计，具体见设计说明。

`bench:compare` 用于和 EventEmitter3、EventEmitter2、mitt 做 emit 参考线对比；`bench:api` 用于 Eventure 自身 API 的 base/PR 性能回归检测。

本地记录：Bun 1.3.4，Linux x64，11th Gen Intel(R) Core(TM) i5-11400H @ 2.70GHz，`hrtimeNow`。参考库：EventEmitter3 ^5.0.4，EventEmitter2 ^6.4.9，mitt ^3.0.1。

Sync emit loop：

| Rank | Task          | ×10^5 emits/s | RME   | Samples | ns/emit |
| ---: | ------------- | ------------: | ----- | ------: | ------: |
|    1 | Eventure      |        884.70 | 0.37% |     881 |   11.30 |
|    2 | EventEmitter2 |        526.94 | 0.70% |     523 |   18.98 |
|    3 | EventEmitter3 |        485.29 | 0.67% |     480 |   20.61 |
|    4 | mitt          |        267.76 | 0.70% |     267 |   37.35 |

Async end-to-end：

| Rank | Task          | ×10^5 emits/s | RME   | Samples | ns/emit |
| ---: | ------------- | ------------: | ----- | ------: | ------: |
|    1 | Eventure      |         44.79 | 3.17% |      88 |  223.27 |
|    2 | EventEmitter3 |         42.53 | 2.91% |      84 |  235.13 |
|    3 | EventEmitter2 |         40.03 | 3.20% |      79 |  249.83 |
|    4 | mitt          |         31.53 | 3.16% |      63 |  317.15 |
