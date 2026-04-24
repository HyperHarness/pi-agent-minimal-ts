import test from "node:test";
import assert from "node:assert/strict";
import { searchApsPapers } from "../../src/agent/aps-search.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json"
    }
  });
}

test("searchApsPapers queries Crossref for APS DOI-prefix papers and returns newest matching results", async () => {
  const calls: Array<{ url: string }> = [];

  const results = await searchApsPapers({
    query: "superconducting quantum computing",
    maxResults: 2,
    fetchImpl: async (input) => {
      calls.push({ url: String(input) });
      return jsonResponse({
        message: {
          items: [
            {
              DOI: "10.1103/PhysRevLett.135.030801",
              title: ["Complete Self-Testing of a System of Remote Superconducting Qubits"],
              abstract: "Superconducting quantum processors are used for quantum computing.",
              published: {
                "date-parts": [[2025, 7, 15]]
              },
              author: [{ given: "Ada", family: "Lovelace" }],
              "container-title": ["Physical Review Letters"]
            },
            {
              DOI: "10.1103/PhysRevApplied.24.034057",
              title: ["On-chip direct-current source for scalable superconducting quantum computing"],
              abstract: "A scalable superconducting qubit control method.",
              published: {
                "date-parts": [[2025, 9, 22]]
              },
              author: [{ given: "Grace", family: "Hopper" }],
              "container-title": ["Physical Review Applied"]
            },
            {
              DOI: "10.1103/PhysRevB.120.123456",
              title: ["Quantum geometry in magnets"],
              abstract: "Not about the requested topic.",
              published: {
                "date-parts": [[2026, 1, 5]]
              }
            }
          ]
        }
      });
    }
  });

  assert.equal(calls.length, 1);
  const requestUrl = new URL(calls[0]?.url ?? "");
  assert.equal(requestUrl.hostname, "api.crossref.org");
  assert.equal(requestUrl.searchParams.get("filter"), "prefix:10.1103,type:journal-article");
  assert.equal(requestUrl.searchParams.get("sort"), "published");
  assert.equal(requestUrl.searchParams.get("order"), "desc");
  assert.equal(requestUrl.searchParams.get("rows"), "200");
  assert.equal(requestUrl.searchParams.get("query.bibliographic"), "superconducting quantum computing");

  assert.deepEqual(
    results.map((result) => ({
      title: result.title,
      primarySource: result.primarySource,
      articleUrl: result.sources[0]?.articleUrl,
      canonicalId: result.sources[0]?.canonicalId
    })),
    [
      {
        title: "On-chip direct-current source for scalable superconducting quantum computing",
        primarySource: "aps",
        articleUrl: "https://journals.aps.org/prapplied/abstract/10.1103/PhysRevApplied.24.034057",
        canonicalId: "10.1103/PhysRevApplied.24.034057"
      },
      {
        title: "Complete Self-Testing of a System of Remote Superconducting Qubits",
        primarySource: "aps",
        articleUrl: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.135.030801",
        canonicalId: "10.1103/PhysRevLett.135.030801"
      }
    ]
  );
});

test("searchApsPapers rejects empty queries", async () => {
  await assert.rejects(
    () => searchApsPapers({ query: "   " }),
    /query is required/i
  );
});
