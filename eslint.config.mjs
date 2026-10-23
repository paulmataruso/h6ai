import js from '@eslint/js';
import globals from 'globals';

export default [
    {
        // .claude/: vendored agent skills; webroot/: local test share (holds a deployed copy of the build)
        ignores: ['build/**', 'node_modules/**', 'coverage/**', 'test-e2e/node_modules/**', '.claude/**', '.impeccable/**', 'webroot/**']
    },
    js.configs.recommended,
    {
        linterOptions: {reportUnusedDisableDirectives: 'off'}
    },
    {
        files: ['src/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {...globals.browser, ...globals.commonjs, global: 'readonly'}
        },
        rules: {
            'no-unused-vars': ['error', {args: 'after-used', caughtErrors: 'none'}],
            'no-var': 'error',
            'prefer-const': 'error',
            'eqeqeq': ['error', 'always'],
            'no-eval': 'error',
            'no-implied-eval': 'error',
            'no-new-func': 'error',
            'no-use-before-define': ['error', {functions: false, classes: true, variables: true}],
            // legacy, well tested regexes; escaping style isn't worth the risk of changing them
            'no-useless-escape': 'off'
        }
    },
    {
        files: ['*.mjs', 'test/**/*.js', 'test-integration/**/*.mjs', 'test-integration/**/*.js', 'test-native/**/*.mjs'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {...globals.node}
        }
    },
    {
        files: ['test/**/*.js'],
        languageOptions: {sourceType: 'commonjs'}
    },
    {
        // Playwright scripts; page callbacks run in the browser
        files: ['test-e2e/**/*.js', 'test-native/**/*.cjs'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {...globals.node, ...globals.browser}
        }
    }
];
