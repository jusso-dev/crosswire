import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['dist', '.output', 'src/routeTree.gen.ts', 'drizzle', 'coverage'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // Server-only modules must not be imported from client components.
    files: ['src/routes/**/*.tsx', 'src/components/**/*.tsx'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['**/server/**'], message: 'Import server code via src/fns server functions, not directly in UI.' }] }],
    },
  },
  {
    files: ['src/server/agents/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          // Patterns, not one exact path (#158): any relative spelling or alias of these modules matches.
          patterns: [
            {
              group: ['**/response/proposals', '~/server/response/proposals'],
              importNames: ['executeProposal', 'decideProposal', 'dryRunProposal'],
              message: 'Agents may only create proposals, never decide or execute them.',
            },
            { group: ['**/response/executors', '~/server/response/executors'], message: 'Agents must not import executors.' },
          ],
        },
      ],
    },
  },
)
