import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import security from 'eslint-plugin-security';
import globals from 'globals';

export default [
    {
        ignores: ['dist/**', 'release/**', 'node_modules/**', '.dev-program-data/**', '.dev-user-data/**', 'tmp_*/**', 'docs/**']
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    security.configs.recommended,
    {
        files: ['src/vod-player/**/*.{js,jsx}'],
        languageOptions: { globals: globals.browser, parserOptions: { ecmaFeatures: { jsx: true } } },
        rules: {
            'no-unused-vars': 'off',
            '@typescript-eslint/no-unused-vars': 'off',
            'no-empty': ['error', { allowEmptyCatch: true }],
            'security/detect-object-injection': 'off'
        }
    },
    {
        files: ['src/**/*.ts'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            'no-console': 'off',
            'security/detect-object-injection': 'off',
            'security/detect-non-literal-fs-filename': 'off',
            'no-async-promise-executor': 'warn',
            'no-empty': ['warn', { allowEmptyCatch: true }]
        }
    },
    {
        files: ['src/renderer.ts', 'src/renderer-*.ts'],
        ignores: ['src/**/*.test.ts'],
        languageOptions: {
            sourceType: 'script',
            globals: globals.browser
        },
        rules: {
            '@typescript-eslint/no-unused-vars': 'off',
            'prefer-const': 'off'
        }
    },
    {
        files: ['scripts/**/*.{js,cjs}'],
        languageOptions: {
            sourceType: 'commonjs',
            globals: globals.node
        },
        rules: {
            '@typescript-eslint/no-require-imports': 'off',
            '@typescript-eslint/no-unused-vars': 'off',
            'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
            'no-console': 'off',
            'no-empty': ['error', { allowEmptyCatch: true }],
            'security/detect-object-injection': 'off',
            'security/detect-non-literal-fs-filename': 'off'
        }
    },
    {
        files: ['scripts/**/*.mjs'],
        languageOptions: {
            sourceType: 'module',
            globals: globals.node
        },
        rules: {
            '@typescript-eslint/no-require-imports': 'off',
            '@typescript-eslint/no-unused-vars': 'off',
            'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
            'no-console': 'off',
            'no-empty': ['error', { allowEmptyCatch: true }],
            'security/detect-object-injection': 'off',
            'security/detect-non-literal-fs-filename': 'off'
        }
    },
    {
        files: ['scripts/smoke-test*.{js,cjs}', 'scripts/capture-readme-screenshot.js', 'scripts/e2e-test-environment.js'],
        languageOptions: {
            globals: {
                ...globals.node,
                ...globals.browser
            }
        },
        rules: {
            'no-undef': 'off'
        }
    }
];
