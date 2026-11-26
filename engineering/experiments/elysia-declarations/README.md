# Elysia 声明隔离复现

2026-10-05，Native/modules/Vite 独立消费者验收发现 Elysia 2.0.0-beta.19 的库声明在 TypeScript 7.0.2、`strict: true`、`skipLibCheck: false` 下失败。
最小输入只有 `import { Elysia } from 'elysia'; new Elysia()`，没有 Pluxel imports。使用仓库已安装的 Elysia 及其真实 peers；不改库声明，不扩大已有 Cap'n Web 例外。

```sh
vp exec node engineering/experiments/elysia-declarations/check.mjs
```

该命令使用临时目录并清理，失败时保留编译器退出码。beta.19 的样本包含 79 个 Elysia macro/generic 声明诊断，例如 `base.d.ts(408,34)` 的 TS2536。

2026-11-25 用 Elysia `2.0.0-rc.5`、exact-mirror `1.2.8`、`@types/bun@1.4.5` 和同一 TypeScript 版本逐一对照 TypeBox。TypeBox `1.4.3` 和 `1.4.4` 的输出一致，均为 Elysia 声明中的 29 条 TS2536 和 36 条 TS2344。`1.4.5` 至 `1.4.7` 的 `StaticType` 只接受四个泛型参数，Elysia 的 `ArrayString` 和 `ObjectString` 仍传入五个，每个版本都新增五条 TS2314。工作区与两个脚手架因此精确固定 `1.4.4`。

这次实验中的完整库检查失败。当前独立安装入口位于 `packages/services/tests/installed/services.smoke.mjs`。Native、生产 Vite、已安装 Plugin/Node 制品与其余 API 检查独立验收；本轮结果与边界见[部署验证](../../records/host-deployment.md#native-modules-与-vite-生产执行)。
