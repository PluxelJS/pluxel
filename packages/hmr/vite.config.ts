// vite.config.ts
import path from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  appType: 'custom',
  ssr: {
    external: ['react', 'react-dom']
  },

  resolve: {
    alias: {
      '@tabler/icons-react': '@tabler/icons-react/dist/esm/icons/index.mjs',
    },
    // 避免多份实例导致上下文不一致（Mantine/React）
    dedupe: ['react', 'react-dom', '@mantine/core', '@mantine/hooks', '@mantine/notifications', '@mantine/dates'],
  },

  optimizeDeps: {
    // 关键2：预构建阶段就别再动它，避免二次语义压缩
    exclude: ['immutable'],
    include: [
      'react',
      'react-dom',
      '@mantine/core',
      '@mantine/hooks',
      '@mantine/notifications',
      '@tabler/icons-react',
    ],
  },

  build: {
    outDir: 'public/',
    manifest: true,
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'src/client.tsx'),
      treeshake: {
        // 关键4：对 immutable 保留副作用标记，避免把内部 runtime 标记摇没
        moduleSideEffects: (id) => /immutable/.test(id) ? true : undefined,
      },
      output: {
        // 更合理的生产分包：react/mantine/emotion/tabler 独立缓存
        advancedChunks: {
          groups: [
            {
              name: 'react',
              test: /[\\/]node_modules[\\/](react|react-dom)[\\/]/,
              priority: 50,
            },
            {
              name: 'mantine',
              test: /[\\/]node_modules[\\/]@mantine[\\/]/,
              priority: 40,
            },
            {
              name: 'emotion',
              test: /[\\/]node_modules[\\/]@emotion[\\/]/,
              priority: 30,
            },
            {
              name: 'tabler',
              test: /[\\/]node_modules[\\/]@tabler[\\/]icons-react[\\/]/,
              priority: 20,
            },
            {
              name: 'vendor',
              test: /[\\/]node_modules[\\/]/,
              priority: 0,
              minSize: 10 * 1024,
            },
          ],
        },
      },
    }
  },
})
