import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { buildGraphData } from "../../scripts/wiki-web.mjs";

async function writePage(workspace, key, frontmatter) {
  const pagePath = path.join(workspace, "pages", `${key}.md`);
  await mkdir(path.dirname(pagePath), { recursive: true });
  await writeFile(pagePath, `${frontmatter}\n\n# ${key}\n`, "utf8");
}

test("wiki web graph uses typed relation edge types", async () => {
  const wikiRoot = await mkdtemp(path.join(tmpdir(), "wiki-web-graph-"));
  try {
    await writePage(wikiRoot, "surface-code", [
      "---",
      'title: "Surface Code"',
      "---"
    ].join("\n"));
    await writePage(wikiRoot, "logical-error-rate", [
      "---",
      'title: "Logical Error Rate"',
      'typed_relations: [{"type":"supports","target":"surface-code","targetKind":"page","evidenceRefs":["claim-1"],"status":"confirmed"}]',
      "---"
    ].join("\n"));

    const graph = await buildGraphData(wikiRoot);

    assert.equal(graph.links.length, 1);
    assert.equal(graph.links[0].type, "supports");
    assert.equal(graph.links[0].source, "logical-error-rate");
    assert.equal(graph.links[0].target, "surface-code");
  } finally {
    await rm(wikiRoot, { recursive: true, force: true });
  }
});

test("wiki web graph client settles instead of animating forever", async () => {
  const source = await readFile(new URL("../../scripts/wiki-web.mjs", import.meta.url), "utf8");

  assert.match(source, /function settleLayout\(\)/);
  assert.match(source, /function renderGraphFrame\(\)/);
  assert.doesNotMatch(source, /requestAnimationFrame\(animate\)/);
});
