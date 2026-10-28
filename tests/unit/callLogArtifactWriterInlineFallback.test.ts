import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const TEST_DATA_DIR = path.resolve("_artifacts", "test-call-logs-inline-fallback");
process.env.DATA_DIR = TEST_DATA_DIR;

const { writeCallArtifactAsync, closeCallLogArtifactWriter, __setWorkerResolverForTests } =
  await import("../../src/lib/usage/callLogArtifactWriter.ts");

test.after(async () => {
  await closeCallLogArtifactWriter();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function buildArtifact(id: string) {
  return {
    schemaVersion: 5 as const,
    summary: {
      id,
      timestamp: "2026-08-11T12:34:56.789Z",
      method: "POST",
      path: "/v1/chat/completions",
      status: 200,
      model: "test-model",
      requestedModel: null,
      provider: "test-provider",
      account: "test-account",
      connectionId: null,
      duration: 10,
      tokens: {
        in: 1,
        out: 2,
        cacheRead: null,
        cacheWrite: null,
        reasoning: null,
        compressed: null,
      },
      requestType: "chat",
      sourceFormat: "openai",
      targetFormat: "openai",
      apiKeyId: null,
      apiKeyName: null,
      comboName: null,
      comboStepId: null,
      comboExecutionKey: null,
    },
    requestBody: { inline: true },
    responseBody: { content: "written in-process" },
    error: null,
  };
}

test("a worker resolution miss degrades to in-process writes and still persists the artifact", async () => {
  __setWorkerResolverForTests(() => ({
    workerFile: "/nonexistent/callLogArtifactWorker.js",
    execArgv: [],
  }));

  // The worker fails asynchronously (Worker 'error' event), so this only resolves
  // once degradeToInline() re-dispatches the in-flight item.
  const result = await writeCallArtifactAsync(buildArtifact("inline-fallback-1"));

  assert.ok(result, "inline fallback must return write metadata, not null");
  assert.match(result.sha256, /^[0-9a-f]{8}$/);

  const artifactPath = path.join(TEST_DATA_DIR, "call_logs", result.relPath);
  assert.equal(fs.existsSync(artifactPath), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(artifactPath, "utf8")), buildArtifact("inline-fallback-1"));
});

test("inline mode stays active for subsequent writes after the worker failed", async () => {
  // Resolver still returns the missing path; inlineMode must short-circuit pump()
  // without spawning another worker.
  let resolverCalls = 0;
  __setWorkerResolverForTests(() => {
    resolverCalls++;
    return { workerFile: "/nonexistent/callLogArtifactWorker.js", execArgv: [] };
  });

  const first = await writeCallArtifactAsync(buildArtifact("inline-fallback-2"));
  const second = await writeCallArtifactAsync(buildArtifact("inline-fallback-3"));

  assert.ok(first);
  assert.ok(second);
  assert.equal(resolverCalls, 1);
});
