# Minimal TypeScript Node Test Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a minimal Node + TypeScript project in this workspace and make `npm test` pass in the sandbox.

**Architecture:** Keep the project intentionally small. TypeScript compiles `src/` and `test/` into `dist/`, and Node's built-in test runner executes the compiled test files.

**Tech Stack:** Node.js, npm, TypeScript, `@types/node`, Node built-in test runner

---

### Task 1: Create the project skeleton

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`

- [ ] **Step 1: Write the project metadata and scripts**

```json
{
  "name": "pi-agent-minimal-ts",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "npm run build && node --test --test-isolation=none dist/test/**/*.test.js"
  }
}
```

- [ ] **Step 2: Write the TypeScript compiler config**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": ".",
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Ignore generated directories**

```gitignore
node_modules/
dist/
```

### Task 2: Add the failing test first

**Files:**
- Create: `test/index.test.ts`
- Test: `test/index.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { add } from "../src/index";

test("add returns the sum of two numbers", () => {
  assert.equal(add(2, 3), 5);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL during TypeScript compilation because `src/index.ts` does not exist yet

### Task 3: Add the minimal implementation

**Files:**
- Create: `src/index.ts`
- Test: `test/index.test.ts`

- [ ] **Step 1: Write minimal implementation**

```ts
export function add(left: number, right: number): number {
  return left + right;
}
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npm test`
Expected: PASS with one passing test
