# @pluxel/test

Pluxel 的 runner/toolchain 测试支持包。它不再提供 Plugin test host 根入口；从所验证的最小产品边界导入 host：

- Core graph/config/lifecycle：`@pluxel/core/test`
- Runtime capability：`@pluxel/runtime/test`
- static application wiring：`@pluxel/runtime-static/test`
- dynamic Vite/HMR/carrier：项目 Vite command 或 `@pluxel/runtime-dynamic`

本包只保留三个面向调用方的职责：

- `@pluxel/test/vitest`：Vitest/Vite preset 与 lifecycle matcher registration
- `@pluxel/test/fixtures`：VFS/disk filesystem fixture
- `@pluxel/test/unsafe`：显式 synthetic lowering/replacement facts

完整用户教程见 [`docs/development/testing.md`](../../docs/development/testing.md)，coding agent 的局部选择规则见
[`LLM_TESTING_GUIDE.md`](LLM_TESTING_GUIDE.md)。

## Vitest preset

```ts
// vitest.config.ts
export { default } from '@pluxel/test/vitest'
```

需要配置时：

```ts
import { definePluxelVitestConfig } from '@pluxel/test/vitest'

export default definePluxelVitestConfig({
	test: { include: ['tests/**/*.test.ts'] },
})
```

preset 在 TypeScript 擦除前执行 Plugin semantic lowering，并注册唯一的
`toHavePluginLifecycleIssue()` matcher。使用 matcher 的项目应把 `vitest.config.ts` 纳入 `tsconfig.include`，使同一个 preset import 同时提供
Vitest module augmentation。Core/Runtime test entries 不依赖 Vitest。

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
