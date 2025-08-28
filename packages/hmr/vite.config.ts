// vite.config.ts
import path from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  appType: 'custom',

  // SSR 这边按你原本外部化 react/react-dom，保持一致性
  ssr: {
    external: ['react', 'react-dom'],
    // 如果你的 SSR 也会 import(immutable)，建议别 noExternal 它，保持“用它自己的产物，不再语义压缩”
    // noExternal: ['immutable'], // <- 通常不需要；仅当你一定要打进 SSR 包时再开
  },

  resolve: {
    alias: {
      // 关键1：强制使用“非极限压缩”的产物，避免再被转换出箭头父类
      // 任选其一：commonjs 版本或 ES 版本（看你项目是 CJS 还是 ESM 链路）
      immutable: 'immutable/dist/immutable.js',
      // immutable: 'immutable/dist/immutable.es.js',
    },
  },

  optimizeDeps: {
    // 关键2：预构建阶段就别再动它，避免二次语义压缩
    exclude: ['immutable'],
  },

  build: {
    outDir: 'public/',
    manifest: true,
    emptyOutDir: true,

    // 关键3：改用 terser，并禁止会动原型链语义的优化
    minify: 'terser',
    terserOptions: {
      compress: {
        // 禁止把普通函数改成箭头（导致没有 prototype）
        arrows: false,
        // 禁止把函数折叠成常量（有时会让“父类函数”失去可实例化语义）
        reduce_funcs: false,
        // 降低 passes，避免“越优化越聪明”
        passes: 1,
      },
      mangle: true, // 保持混淆，但不影响原型链语义
      format: {
        // 方便排查，可先设 true 看看；确认没问题后再关
        comments: false,
      },
    },

    rollupOptions: {
      input: path.resolve(__dirname, 'src/client.tsx'),
      treeshake: {
        // 关键4：对 immutable 保留副作用标记，避免把内部 runtime 标记摇没
        moduleSideEffects: (id) => /immutable/.test(id) ? true : undefined,
      },
    },
    // 如果你用到 target，非常老的浏览器目标也可能触发不同的压缩路径
    // target: 'es2019',
  },
})
