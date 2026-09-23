import eslint from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dist-login-pilot/**',
      'dist-native-login-pilot/**',
      'out/**',
      'out-login-pilot/**',
      'out-native-login-pilot/**',
      'out-chrome-work-pilot/**',
      'node_modules/**',
      'coverage/**'
    ]
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['chrome-work-pilot/src/**/*.ts'],
    languageOptions: {
      globals: { ...globals.browser, chrome: 'readonly' }
    }
  },
  {
    files: [
      'src/renderer/**/*.{ts,tsx}',
      'login-pilot/src/renderer/**/*.{ts,tsx}',
      'native-login-pilot/src/renderer/**/*.{ts,tsx}'
    ],
    languageOptions: {
      globals: globals.browser
    }
  },
  {
    files: [
      'src/main/**/*.ts',
      'src/preload/**/*.ts',
      'login-pilot/src/main/**/*.ts',
      'login-pilot/src/preload/**/*.ts',
      'login-pilot/src/shared/**/*.ts',
      'native-login-pilot/src/main/**/*.ts',
      'native-login-pilot/src/preload/**/*.ts',
      'native-login-pilot/src/shared/**/*.ts',
      'tests/**/*.ts',
      '*.config.ts'
    ],
    languageOptions: {
      globals: globals.node
    }
  },
  {
    files: [
      'scripts/**/*.mjs',
      'login-pilot/scripts/**/*.mjs',
      'login-pilot/test-fixtures/**/*.mjs',
      'native-login-pilot/scripts/**/*.mjs',
      'chrome-work-pilot/scripts/**/*.mjs'
    ],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser }
    }
  }
)
