# Minimal TypeScript Node Test Setup Design

**Date:** 2026-04-21

## Goal

Create the smallest practical Node development environment in this project with TypeScript as the primary language and a sandbox-safe `npm test` workflow.

## Chosen Approach

Use:
- `typescript` for compilation
- `@types/node` for Node type definitions
- Node's built-in test runner for test execution

The `npm test` command will:
1. Compile TypeScript from `src/` and `test/` into `dist/`
2. Run the compiled test files with `node --test --test-isolation=none`

## File Layout

- `package.json`: project metadata and scripts
- `tsconfig.json`: TypeScript compiler settings
- `src/index.ts`: minimal sample TypeScript module
- `test/index.test.ts`: minimal sample test
- `.gitignore`: ignore `node_modules/` and `dist/`

## Behavior

- `npm install` installs only the minimal TypeScript toolchain
- `npm test` fails if TypeScript compilation fails
- `npm test` fails if the runtime test fails
- `npm test` passes only when both compile and test phases succeed
- Test execution stays in-process so it can run inside this sandbox

## Non-Goals

- No external test framework
- No bundler
- No linting setup
- No application framework
