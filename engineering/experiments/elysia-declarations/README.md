# Elysia 声明隔离复现

2026-10-05，Native/modules/Vite 独立消费者验收发现 Elysia 2.0.0-beta.19 的库声明在 TypeScript 7.0.2、`strict: true`、`skipLibCheck: false` 下失败。
最小输入只有 `import { Elysia } from 'elysia'; new Elysia()`，没有 Pluxel imports。使用仓库已安装的 Elysia 及其真实 peers；不改库声明，不扩大已有 Cap'n Web 例外。

```sh
node engineering/experiments/elysia-declarations/check.mjs
```

该命令使用临时目录并清理，失败时保留编译器退出码。当前样本包含 79 个 Elysia macro/generic 声明诊断，例如 `base.d.ts(408,34)` 的 TS2536。
这说明错误能独立于 Pluxel 复现，不证明上游未来版本已修复。

`packages/services/tests/installed-services.smoke.mjs` 的完整库检查仍会失败，不将其标为通过。Native、生产 Vite、已安装 Plugin/Node 制品与其余 API 检查独立验收；本轮结果与边界见[部署验证](../../HOST_DEPLOYMENT_VALIDATION.md#native-modules-与-vite-生产执行)。
