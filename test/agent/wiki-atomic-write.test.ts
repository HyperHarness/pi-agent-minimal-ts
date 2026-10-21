import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { atomicWriteFile } from "../../src/agent/wiki/atomic-write.js";

test("failed atomic replacement preserves old content and cleans the temporary file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "wiki-atomic-"));
  const target = path.join(dir, "page.md");
  try {
    await writeFile(target, "old complete page");
    await assert.rejects(atomicWriteFile(target, "new page", { rename: async () => { throw new Error("rename failed"); } }), /rename failed/);
    assert.equal(await readFile(target, "utf8"), "old complete page");
    assert.deepEqual(await readdir(dir), ["page.md"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("concurrent atomic writers expose only complete old or new documents", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "wiki-atomic-"));
  const target = path.join(dir, "page.md");
  const documents = Array.from({ length: 8 }, (_, index) => String(index).repeat(100_000));
  const valid = new Set(["original", ...documents]);
  try {
    await writeFile(target, "original");
    let finished = false;
    const writers = Promise.all(documents.map((document) => atomicWriteFile(target, document))).finally(() => { finished = true; });
    do { assert.ok(valid.has(await readFile(target, "utf8"))); } while (!finished);
    await writers;
    assert.ok(documents.includes(await readFile(target, "utf8")));
    assert.deepEqual(await readdir(dir), ["page.md"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("atomic replacement preserves existing permissions and refuses symlink destinations", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "wiki-atomic-"));
  const target = path.join(dir, "metadata.json");
  const link = path.join(dir, "link.json");
  try {
    await writeFile(target, "old");
    await chmod(target, 0o600);
    await atomicWriteFile(target, "new");
    if (process.platform !== "win32") assert.equal((await lstat(target)).mode & 0o777, 0o600);
    await symlink(target, link, process.platform === "win32" ? "file" : undefined);
    await assert.rejects(atomicWriteFile(link, "unsafe"), /regular destination/);
    assert.equal(await readFile(target, "utf8"), "new");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
