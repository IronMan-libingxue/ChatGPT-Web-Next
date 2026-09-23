import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: resolve('out-native-login-pilot/main'),
      rollupOptions: {
        input: resolve('native-login-pilot/src/main/index.ts')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: resolve('out-native-login-pilot/preload'),
      rollupOptions: {
        input: resolve('native-login-pilot/src/preload/index.ts'),
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    root: resolve('native-login-pilot/src/renderer'),
    plugins: [react()],
    build: {
      outDir: resolve('out-native-login-pilot/renderer'),
      rollupOptions: {
        input: resolve('native-login-pilot/src/renderer/index.html')
      }
    }
  }
})
