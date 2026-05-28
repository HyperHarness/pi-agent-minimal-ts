import assert from "node:assert/strict";
import test from "node:test";
import {
  parseExtensionHostMessage,
  parseExtensionHostResponse
} from "../../src/agent/paper/extension/paper-extension-protocol.js";

test("parseExtensionHostMessage accepts register_download messages", () => {
  const message = parseExtensionHostMessage({
    type: "register_download",
    jobId: "job-123",
    articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
    source: "science",
    downloadPath: "knowledge-base/raw/pdfs/science-paper.pdf",
    pdfUrl: "https://www.science.org/doi/epdf/10.1126/science.adz8659",
    title: "Science Paper"
  });

  assert.deepEqual(message, {
    type: "register_download",
    jobId: "job-123",
    articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
    source: "science",
    downloadPath: "knowledge-base/raw/pdfs/science-paper.pdf",
    pdfUrl: "https://www.science.org/doi/epdf/10.1126/science.adz8659",
    title: "Science Paper"
  });
});

test("parseExtensionHostMessage accepts register_download_bytes messages", () => {
  const message = parseExtensionHostMessage({
    type: "register_download_bytes",
    jobId: "job-123",
    articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
    source: "science",
    pdfBase64: "JVBERi0xLjQK",
    pdfUrl: "https://www.science.org/doi/epdf/10.1126/science.adz8659",
    pdfFileName: "science-adz8659.pdf",
    title: "Science Paper"
  });

  assert.deepEqual(message, {
    type: "register_download_bytes",
    jobId: "job-123",
    articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
    source: "science",
    pdfBase64: "JVBERi0xLjQK",
    pdfUrl: "https://www.science.org/doi/epdf/10.1126/science.adz8659",
    pdfFileName: "science-adz8659.pdf",
    title: "Science Paper"
  });
});

test("parseExtensionHostMessage accepts register_supplemental_material messages", () => {
  const message = parseExtensionHostMessage({
    type: "register_supplemental_material",
    jobId: "job-supplement",
    articleUrl: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502",
    source: "aps",
    materialUrl: "https://journals.aps.org/prl/supplemental/10.1103/PhysRevLett.111.080502/SM.pdf",
    materialBase64: "JVBERi0xLjQK",
    filename: "SM.pdf",
    mimeType: "application/pdf",
    title: "Supplemental Material"
  });

  assert.deepEqual(message, {
    type: "register_supplemental_material",
    jobId: "job-supplement",
    articleUrl: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502",
    source: "aps",
    materialUrl: "https://journals.aps.org/prl/supplemental/10.1103/PhysRevLett.111.080502/SM.pdf",
    materialBase64: "JVBERi0xLjQK",
    filename: "SM.pdf",
    mimeType: "application/pdf",
    title: "Supplemental Material"
  });
});

test("parseExtensionHostMessage accepts register_webpage_snapshot messages", () => {
  const message = parseExtensionHostMessage({
    type: "register_webpage_snapshot",
    jobId: "job-webpage",
    articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
    finalUrl: "https://www.science.org/doi/10.1126/science.adz8659?loaded=1",
    source: "science",
    title: "Science Paper",
    html: "<html><head><title>Science Paper</title></head><body><main><h1>Science Paper</h1><p>Abstract text.</p></main></body></html>",
    webpageAssets: [
      {
        url: "https://www.science.org/cms/asset/figure-1.png",
        originalUrl: "/cms/asset/figure-1.png",
        filename: "figure-1.png",
        mimeType: "image/png",
        dataBase64: "cG5n",
        alt: "Figure 1"
      }
    ]
  });

  assert.deepEqual(message, {
    type: "register_webpage_snapshot",
    jobId: "job-webpage",
    articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
    finalUrl: "https://www.science.org/doi/10.1126/science.adz8659?loaded=1",
    source: "science",
    title: "Science Paper",
    html: "<html><head><title>Science Paper</title></head><body><main><h1>Science Paper</h1><p>Abstract text.</p></main></body></html>",
    webpageAssets: [
      {
        url: "https://www.science.org/cms/asset/figure-1.png",
        originalUrl: "/cms/asset/figure-1.png",
        filename: "figure-1.png",
        mimeType: "image/png",
        dataBase64: "cG5n",
        alt: "Figure 1"
      }
    ]
  });
});

test("parseExtensionHostMessage accepts job_status messages", () => {
  const message = parseExtensionHostMessage({
    type: "job_status",
    jobId: "job-123",
    status: "pdf_candidate_found",
    articleUrl: "https://www.nature.com/articles/s41586-019-1666-5",
    source: "nature",
    message: "PDF link detected."
  });

  assert.deepEqual(message, {
    type: "job_status",
    jobId: "job-123",
    status: "pdf_candidate_found",
    articleUrl: "https://www.nature.com/articles/s41586-019-1666-5",
    source: "nature",
    message: "PDF link detected."
  });
});

test("parseExtensionHostMessage accepts poll_jobs messages", () => {
  const message = parseExtensionHostMessage({
    type: "poll_jobs",
    extensionInstanceId: "extension-abc"
  });

  assert.deepEqual(message, {
    type: "poll_jobs",
    extensionInstanceId: "extension-abc"
  });
});

test("parseExtensionHostMessage rejects register_download messages missing downloadPath", () => {
  assert.throws(
    () =>
      parseExtensionHostMessage({
        type: "register_download",
        jobId: "job-123",
        articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
        source: "science"
      }),
    /downloadPath/i
  );
});

test("parseExtensionHostMessage rejects non-object input", () => {
  assert.throws(() => parseExtensionHostMessage("not an object"), /object/i);
});

test("parseExtensionHostMessage rejects blank required strings", () => {
  assert.throws(
    () =>
      parseExtensionHostMessage({
        type: "poll_jobs",
        extensionInstanceId: " "
      }),
    /extensionInstanceId/i
  );
});

test("parseExtensionHostMessage rejects invalid PaperSource values", () => {
  assert.throws(
    () =>
      parseExtensionHostMessage({
        type: "register_download",
        jobId: "job-123",
        articleUrl: "https://example.com/paper",
        source: "publisher",
        downloadPath: "knowledge-base/raw/pdfs/paper.pdf"
      }),
    /source/i
  );
});

test("parseExtensionHostMessage rejects invalid job statuses", () => {
  assert.throws(
    () =>
      parseExtensionHostMessage({
        type: "job_status",
        jobId: "job-123",
        status: "started",
        articleUrl: "https://example.com/paper"
      }),
    /status/i
  );
});

test("parseExtensionHostResponse accepts jobs responses with queued job payloads", () => {
  const response = parseExtensionHostResponse({
    type: "jobs",
    jobs: [
      {
        jobId: "job-123",
        articleUrl: "https://arxiv.org/abs/2401.01234",
        source: "arxiv",
        title: "Queued Paper",
        autoClose: true,
        purpose: "webpage"
      }
    ]
  });

  assert.deepEqual(response, {
    type: "jobs",
    jobs: [
      {
        jobId: "job-123",
        articleUrl: "https://arxiv.org/abs/2401.01234",
        source: "arxiv",
        title: "Queued Paper",
        autoClose: true,
        purpose: "webpage"
      }
    ]
  });
});

test("parseExtensionHostResponse accepts webpage_registered responses", () => {
  const response = parseExtensionHostResponse({
    type: "webpage_registered",
    jobId: "job-webpage",
    articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
    paperKey: "science-10.1126-science.adz8659",
    markdownPath: "knowledge-base/sources/science-10.1126-science.adz8659/parses/webpage/document.md",
    parsePath: "knowledge-base/sources/science-10.1126-science.adz8659/parses/webpage/parse.json",
    qualityPath: "knowledge-base/sources/science-10.1126-science.adz8659/parses/webpage/quality.json",
    chunksPath: "knowledge-base/sources/science-10.1126-science.adz8659/parses/webpage/chunks.jsonl",
    quality: {
      status: "good",
      score: 1,
      pages: 1,
      totalTextLength: 1234,
      warnings: []
    },
    title: "Science Paper"
  });

  assert.deepEqual(response, {
    type: "webpage_registered",
    jobId: "job-webpage",
    articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
    paperKey: "science-10.1126-science.adz8659",
    markdownPath: "knowledge-base/sources/science-10.1126-science.adz8659/parses/webpage/document.md",
    parsePath: "knowledge-base/sources/science-10.1126-science.adz8659/parses/webpage/parse.json",
    qualityPath: "knowledge-base/sources/science-10.1126-science.adz8659/parses/webpage/quality.json",
    chunksPath: "knowledge-base/sources/science-10.1126-science.adz8659/parses/webpage/chunks.jsonl",
    quality: {
      status: "good",
      score: 1,
      pages: 1,
      totalTextLength: 1234,
      warnings: []
    },
    title: "Science Paper"
  });
});

test("parseExtensionHostResponse accepts supplemental_registered responses", () => {
  const response = parseExtensionHostResponse({
    type: "supplemental_registered",
    jobId: "job-supplement",
    articleUrl: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502",
    materialUrl: "https://journals.aps.org/prl/supplemental/10.1103/PhysRevLett.111.080502/SM.pdf",
    path: "knowledge-base/raw/pdfs/aps-10.1103-PhysRevLett.111.080502-supplemental-SM.pdf",
    sha256: "abc123",
    recordPath: "knowledge-base/sources/aps/10.1103-PhysRevLett.111.080502/acquisition.json",
    title: "Supplemental Material"
  });

  assert.deepEqual(response, {
    type: "supplemental_registered",
    jobId: "job-supplement",
    articleUrl: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502",
    materialUrl: "https://journals.aps.org/prl/supplemental/10.1103/PhysRevLett.111.080502/SM.pdf",
    path: "knowledge-base/raw/pdfs/aps-10.1103-PhysRevLett.111.080502-supplemental-SM.pdf",
    sha256: "abc123",
    recordPath: "knowledge-base/sources/aps/10.1103-PhysRevLett.111.080502/acquisition.json",
    title: "Supplemental Material"
  });
});

test("parseExtensionHostResponse rejects invalid optional booleans", () => {
  assert.throws(
    () =>
      parseExtensionHostResponse({
        type: "jobs",
        jobs: [
          {
            jobId: "job-123",
            articleUrl: "https://arxiv.org/abs/2401.01234",
            source: "arxiv",
            autoClose: "yes"
          }
        ]
      }),
    /autoClose/i
  );
});

test("parseExtensionHostResponse accepts registered responses", () => {
  const response = parseExtensionHostResponse({
    type: "registered",
    jobId: "job-123",
    articleUrl: "https://example.com/paper",
    downloadPath: "knowledge-base/raw/pdfs/external-paper.pdf",
    recordPath: "knowledge-base/sources/external-paper/acquisition.json",
    fileSha256: "abc123",
    title: "External Paper"
  });

  assert.deepEqual(response, {
    type: "registered",
    jobId: "job-123",
    articleUrl: "https://example.com/paper",
    downloadPath: "knowledge-base/raw/pdfs/external-paper.pdf",
    recordPath: "knowledge-base/sources/external-paper/acquisition.json",
    fileSha256: "abc123",
    title: "External Paper"
  });
});

test("parseExtensionHostResponse accepts status_ack responses", () => {
  const response = parseExtensionHostResponse({
    type: "status_ack",
    jobId: "job-123",
    status: "downloaded"
  });

  assert.deepEqual(response, {
    type: "status_ack",
    jobId: "job-123",
    status: "downloaded"
  });
});

test("parseExtensionHostResponse rejects status_ack responses with invalid statuses", () => {
  assert.throws(
    () =>
      parseExtensionHostResponse({
        type: "status_ack",
        jobId: "job-123",
        status: "complete"
      }),
    /status/i
  );
});

test("parseExtensionHostResponse accepts error responses", () => {
  const response = parseExtensionHostResponse({
    type: "error",
    jobId: "job-123",
    code: "invalid_message",
    message: "downloadPath is required."
  });

  assert.deepEqual(response, {
    type: "error",
    jobId: "job-123",
    code: "invalid_message",
    message: "downloadPath is required."
  });
});

test("parseExtensionHostResponse rejects error responses missing code", () => {
  assert.throws(
    () =>
      parseExtensionHostResponse({
        type: "error",
        message: "downloadPath is required."
      }),
    /code/i
  );
});

test("parseExtensionHostResponse rejects error responses missing message", () => {
  assert.throws(
    () =>
      parseExtensionHostResponse({
        type: "error",
        code: "invalid_message"
      }),
    /message/i
  );
});

test("parseExtensionHostResponse rejects error responses with blank code", () => {
  assert.throws(
    () =>
      parseExtensionHostResponse({
        type: "error",
        code: " ",
        message: "downloadPath is required."
      }),
    /code/i
  );
});

test("parseExtensionHostResponse rejects error responses with blank message", () => {
  assert.throws(
    () =>
      parseExtensionHostResponse({
        type: "error",
        code: "invalid_message",
        message: " "
      }),
    /message/i
  );
});
