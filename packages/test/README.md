# @pluxel/test

Pluxel 的 runner/toolchain 测试支持包。它不再提供 Plugin test host 根入口；从所验证的最小产品边界导入 host：

- Core graph/config/lifecycle：`@pluxel/core/test`
- Runtime capability：`@pluxel/runtime/test`
- static application wiring：`@pluxel/runtime-static/test`
- dynamic Vite/HMR/carrier：项目 Vite command 或 `@pluxel/runtime-dynamic`

本包只保留三个面向调用方的职责：

- `@pluxel/test/vitest`：Vitest/Vite preset 与 Pluxel source toolchain
- `@pluxel/test/fixtures`：VFS/disk filesystem fixture
- `@pluxel/test/unsafe`：显式 synthetic lowering/replacement facts

完整用户教程见 [`docs/development/testing.md`](../../docs/development/testing.md)，coding agent 的局部选择规则见
[`LLM_TESTING_GUIDE.md`](LLM_TESTING_GUIDE.md)。

## Vitest preset

此 preset 固定对应 Vitest `5.0.0`（upstream 要求 Node.js `>=22.12.0`、Vite `>=6.4.0`）；Pluxel package 与生成项目
统一要求 Node.js `>=24`。不要把版本范围降回 Vitest 4，或用 `clearMocks: false` 恢复旧的 mock history 语义。

```ts
// vitest.config.ts
export { default } from '@pluxel/test/vitest'
```

需要配置时：

```ts
import { definePluxelVitestConfig } from '@pluxel/test/vitest'

export default definePluxelVitestConfig({
	// Native Vitest discovery and runner options.
	test: { include: ['tests/**/*.test.ts'], passWithNoTests: false },
	// Pluxel source transforms; this namespace is consumed before Vite sees the config.
	pluxel: { include: ['src/**/*.ts', 'tests/**/*.ts'] },
})
```

preset 在 TypeScript 擦除前执行 Plugin semantic lowering。lifecycle failure 直接断言
`commitExpectFail()` 返回的 structured `lifecycleReport`，不向 consumer 注册 Vitest matcher 或 `setupFiles`。Core/Runtime
test entries 不依赖 Vitest。

`test.include` 决定 Vitest 发现哪些测试；`pluxel.include` / `exclude` 决定哪些源码经过 Pluxel lowering 和 config
extraction，两者不能互相替代。需要在 lowering 前运行额外 Vite transform 时使用 `pluxel.prePlugins`；普通 Vite plugin
仍写在顶层 `plugins`。

## Filesystem fixture

```ts
import { createFixture } from '@pluxel/test/fixtures'

await using fixture = await createFixture({
	'packages/a/src/index.ts': 'export const entry = "a"\n',
})

await fixture.fsp.writeFile(fixture.getPath('tmp.txt'), 'ok\n', 'utf8')
```

默认使用 VFS；只有 watcher、child process 或原生工具链确实需要磁盘时才使用 disk fixture。fixture 拥有并释放自己创建的 filesystem resource。

## Unsafe lowering

`@pluxel/test/unsafe` 只用于明确模拟 module evaluation/replacement facts。普通 Plugin 测试不能用它绕过 semantic lowering、identity 或 lifecycle。
