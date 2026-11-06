const assert = require("node:assert/strict");
const { once } = require("node:events");
const { mkdtemp, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const express = require("express");

const {
  CompareVersionCommits,
  CommitComparisonInputError,
  CommitComparisonProjectNotFoundError,
} = require("../dist/application/use-cases/CompareVersionCommits");
const { CommitDiffDTO } = require("../dist/application/dto/CommitDiffDTO");
const { GitRefNotFoundError } = require("../dist/domain/interfaces/IGitClient");
const { Project } = require("../dist/domain/models/Project");
const { ProjectDependency } = require("../dist/domain/models/ProjectDependency");
const { ProjectTag } = require("../dist/domain/models/ProjectTag");
const { Version } = require("../dist/domain/models/Version");
const { AutoDetectSourceControlProvider } = require("../dist/infrastructure/providers/AutoDetectSourceControlProvider");
const { ProjectRegistry } = require("../dist/infrastructure/registry/ProjectRegistry");
const { JsonFileDataStore } = require("../dist/infrastructure/storage/JsonFileDataStore");
const { CommitDiffController } = require("../dist/interfaces/http/controllers/CommitDiffController");
const { createRoutes } = require("../dist/interfaces/http/routes/routes");

const fromHash = "a".repeat(40);
const toHash = "b".repeat(40);
const fromDate = "2026-10-20T12:34:56+02:00";
const toDate = "2026-10-22T09:08:07-04:00";
const diff = {
  fromCommitHash: fromHash,
  toCommitHash: toHash,
  fromOnly: [{ hash: fromHash, subject: "Only in baseline", committedAt: fromDate }],
  toOnly: [{ hash: toHash, subject: "Only in comparison", committedAt: toDate }],
};

function createComparison(dataStore) {
  const child = new Project("child", "Child", "git@github.com:example/child.git");
  const root = new Project("root", "Root", "https://github.com/example/root.git", null, [
    new ProjectDependency(new Project("middle", "Middle", "https://github.com/example/middle.git", null, [
      new ProjectDependency(child),
    ])),
  ]);
  const calls = [];
  const gitClient = {
    compareCommits: async (...args) => {
      calls.push(args);
      return diff;
    },
  };
  const registry = new ProjectRegistry([root]);
  const sourceControlProvider = new AutoDetectSourceControlProvider();
  const comparison = new CompareVersionCommits(registry, gitClient, sourceControlProvider, dataStore);
  return { comparison, gitClient, calls, child, root, registry, sourceControlProvider };
}

test("commit comparison resolves root and transitive projects and returns a transport DTO with links", async () => {
  const { comparison, calls, child, root } = createComparison();
  const result = await comparison.execute(" child ", " release/v1 ", " release/v2 ");
  assert.deepEqual(calls, [[child.repoUrl, "release/v1", "release/v2"]]);
  assert.deepEqual(CommitDiffDTO.fromResult(result), new CommitDiffDTO(
    child.id, child.name, "release/v1", "release/v2", fromHash, toHash,
    [{ hash: fromHash, subject: "Only in baseline", committedAt: fromDate, url: `https://github.com/example/child/commit/${fromHash}` }],
    [{ hash: toHash, subject: "Only in comparison", committedAt: toDate, url: `https://github.com/example/child/commit/${toHash}` }]
  ));

  const rootResult = await comparison.execute(root.id, "v1", "v2");
  assert.equal(rootResult.projectName, root.name);
  assert.equal(rootResult.toOnly[0].url, `https://github.com/example/root/commit/${toHash}`);
});

test("commit comparison uses exact JSON catalog hints for nested projects only on result-cache misses", async context => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "commit-comparison-catalog-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonFileDataStore(path.join(directory, "trees.json"), path.join(directory, "projects.json"));
  await store.syncProjectTags("child", [
    new Version("release/v1", new Date(fromDate), fromHash),
    new Version("release/v2", new Date(toDate), toHash),
  ]);
  const lookup = context.mock.method(store, "getProjectTag", store.getProjectTag.bind(store));
  const { comparison, calls, child } = createComparison(store);
  await comparison.execute(child.id, "release/v1", "release/v2");
  assert.deepEqual(calls, [[child.repoUrl, "release/v1", "release/v2", {
    fromCommitHash: fromHash, toCommitHash: toHash,
  }]]);
  await comparison.execute(child.id, "release/v2", "release/v1");
  assert.equal(lookup.mock.callCount(), 2);
  assert.equal(calls.length, 1);
});

test("commit comparison deduplicates exact catalog lookups for identical refs", async () => {
  let lookups = 0;
  const store = {
    getProjectTag: async (projectId, name) => {
      lookups += 1;
      return new ProjectTag(projectId, name, fromHash, new Date(fromDate));
    },
  };
  const { comparison, calls } = createComparison(store);
  await comparison.execute("root", "v1", "v1");
  assert.equal(lookups, 1);
  assert.deepEqual(calls[0][3], { fromCommitHash: fromHash, toCommitHash: fromHash });
});

for (const state of ["missing", "removed", "unknown commit"]) {
  test(`commit comparison discovers refs when exact catalog metadata is ${state}`, async () => {
    const store = {
      getProjectTag: async (projectId, name) => state === "missing" ? null :
        new ProjectTag(projectId, name, state === "unknown commit" ? null : fromHash,
          new Date(fromDate), state === "removed"),
    };
    const { comparison, calls, root } = createComparison(store);
    await comparison.execute("root", "v1", "v2");
    assert.deepEqual(calls, [[root.repoUrl, "v1", "v2"]]);
  });
}

test("commit comparison surfaces metadata failures without caching a failed request", async () => {
  const failure = new Error("Catalog lookup failed");
  const store = { getProjectTag: async () => { throw failure; } };
  const { comparison, calls } = createComparison(store);
  await assert.rejects(comparison.execute("root", "v1", "v2"), failure);
  assert.equal(calls.length, 0);
  store.getProjectTag = async (projectId, name) =>
    new ProjectTag(projectId, name, name === "v1" ? fromHash : toHash, new Date(fromDate));
  await comparison.execute("root", "v1", "v2");
  assert.equal(calls.length, 1);
});

test("commit comparison rejects corrupt stored tag metadata rather than silently trusting it", async () => {
  const store = {
    getProjectTag: async (projectId, name) =>
      new ProjectTag(projectId, name, "invalid-hash", new Date(fromDate)),
  };
  const { comparison, calls } = createComparison(store);
  await assert.rejects(comparison.execute("root", "v1", "v2"), /Stored commit comparison tag metadata is invalid/);
  assert.equal(calls.length, 0);
});

test("repeated and reversed comparisons reuse one result without exposing mutable cache entries", async () => {
  const { comparison, calls } = createComparison();
  const first = await comparison.execute("root", "v2", "v1");
  const repeated = await comparison.execute(" root ", " v2 ", " v1 ");
  const reverse = await comparison.execute("root", "v1", "v2");
  assert.deepEqual(repeated, first);
  assert.equal(reverse.fromVersion, "v1");
  assert.equal(reverse.toVersion, "v2");
  assert.equal(reverse.fromCommitHash, first.toCommitHash);
  assert.equal(reverse.toCommitHash, first.fromCommitHash);
  assert.deepEqual(reverse.fromOnly, first.toOnly);
  assert.deepEqual(reverse.toOnly, first.fromOnly);
  assert.equal(calls.length, 1);

  first.fromOnly[0].subject = "Mutated response";
  first.toOnly.length = 0;
  const unaffected = await comparison.execute("root", "v2", "v1");
  assert.equal(unaffected.fromOnly[0].subject, "Only in baseline");
  assert.equal(unaffected.toOnly.length, 1);
});

test("simultaneous same-direction and reverse requests share the in-flight comparison", async () => {
  const { comparison, gitClient } = createComparison();
  let resolve;
  const pending = new Promise(onResolve => { resolve = onResolve; });
  let calls = 0;
  gitClient.compareCommits = async () => { calls += 1; return pending; };
  const first = comparison.execute("root", "v1", "v2");
  const second = comparison.execute("root", "v1", "v2");
  const reversed = comparison.execute("root", "v2", "v1");
  assert.equal(calls, 1);
  resolve(diff);
  const [left, same, right] = await Promise.all([first, second, reversed]);
  assert.deepEqual(left, same);
  assert.deepEqual(right.fromOnly, left.toOnly);
  assert.deepEqual(right.toOnly, left.fromOnly);
  assert.equal(calls, 1);
});

test("cache expires at exactly 24 hours after completion and cache hits do not extend expiry", async context => {
  const { comparison, calls } = createComparison();
  let now = Date.parse("2026-10-26T12:00:00Z");
  context.mock.method(Date, "now", () => now);
  await comparison.execute("root", "v1", "v2");
  now += 24 * 60 * 60 * 1_000 - 1;
  await comparison.execute("root", "v2", "v1");
  assert.equal(calls.length, 1);
  now += 1;
  await comparison.execute("root", "v1", "v2");
  assert.equal(calls.length, 2);
});

test("cache holds exactly 1000 pairs and evicts the least recently used comparison", async () => {
  const { comparison, calls } = createComparison();
  for (let index = 0; index < 1_000; index += 1) {
    await comparison.execute("root", `from-${index}`, `to-${index}`);
  }
  assert.equal(calls.length, 1_000);
  await comparison.execute("root", "to-0", "from-0");
  await comparison.execute("root", "from-999", "to-999");
  assert.equal(calls.length, 1_000);
  await comparison.execute("root", "from-1000", "to-1000");
  assert.equal(calls.length, 1_001);
  await comparison.execute("root", "from-0", "to-0");
  assert.equal(calls.length, 1_001);
  await comparison.execute("root", "from-1", "to-1");
  assert.equal(calls.length, 1_002);
});

test("cache starts expiry on completion rather than when a slow comparison was requested", async context => {
  const { comparison, gitClient } = createComparison();
  let now = Date.parse("2026-10-26T12:00:00Z");
  context.mock.method(Date, "now", () => now);
  let resolve;
  let calls = 0;
  const pending = new Promise(onResolve => { resolve = onResolve; });
  gitClient.compareCommits = async () => { calls += 1; return pending; };
  const first = comparison.execute("root", "v1", "v2");
  now += 60_000;
  resolve(diff);
  await first;
  now += 24 * 60 * 60 * 1_000 - 1;
  await comparison.execute("root", "v1", "v2");
  assert.equal(calls, 1);
  now += 1;
  await comparison.execute("root", "v1", "v2");
  assert.equal(calls, 2);
});

test("failed in-flight comparisons are shared but not cached and can be retried", async () => {
  const { comparison, gitClient } = createComparison();
  let reject;
  let calls = 0;
  const pending = new Promise((_resolve, onReject) => { reject = onReject; });
  gitClient.compareCommits = async () => { calls += 1; return pending; };
  const attempts = Promise.allSettled([
    comparison.execute("root", "v1", "v2"),
    comparison.execute("root", "v2", "v1"),
  ]);
  const failure = new Error("Temporary Git failure");
  reject(failure);
  const results = await attempts;
  assert.ok(results.every(result => result.status === "rejected" && result.reason === failure));
  assert.equal(calls, 1);
  gitClient.compareCommits = async () => { calls += 1; return diff; };
  await comparison.execute("root", "v1", "v2");
  await comparison.execute("root", "v1", "v2");
  assert.equal(calls, 2);
});

test("link-provider failures do not leave a successful result cached", async () => {
  const { comparison, calls, sourceControlProvider } = createComparison();
  const getCommitUrl = sourceControlProvider.getCommitUrl.bind(sourceControlProvider);
  sourceControlProvider.getCommitUrl = () => { throw new Error("Link creation failed"); };
  await assert.rejects(comparison.execute("root", "v1", "v2"), /Link creation failed/);
  sourceControlProvider.getCommitUrl = getCommitUrl;
  await comparison.execute("root", "v1", "v2");
  assert.equal(calls.length, 2);
});

test("empty successful comparisons are cached while changed refs or repositories use separate entries", async () => {
  const { comparison, gitClient, root, calls } = createComparison();
  await comparison.execute("root", "v1", "v2");
  await comparison.execute("root", "v1", "v3");
  root.repoUrl = "https://gitlab.com/example/root.git";
  await comparison.execute("root", "v1", "v2");
  assert.equal(calls.length, 3);

  let emptyCalls = 0;
  gitClient.compareCommits = async () => {
    emptyCalls += 1;
    return { fromCommitHash: fromHash, toCommitHash: fromHash, fromOnly: [], toOnly: [] };
  };
  const empty = await comparison.execute("root", "same", "same");
  assert.equal(empty.fromOnly.length, 0);
  await comparison.execute("root", "same", "same");
  assert.equal(emptyCalls, 1);
});

test("cached comparisons use the current project name and never bypass project lookup", async () => {
  const { comparison, root, registry, calls } = createComparison();
  await comparison.execute("root", "v1", "v2");
  root.name = "Renamed";
  const cached = await comparison.execute("root", "v1", "v2");
  assert.equal(cached.projectName, "Renamed");
  assert.equal(calls.length, 1);
  registry.removeProject(root.id);
  await assert.rejects(comparison.execute("root", "v1", "v2"), CommitComparisonProjectNotFoundError);
});

test("invalid input and unregistered projects fail explicitly before accessing Git", async () => {
  const { comparison, calls } = createComparison();
  for (const args of [
    ["", "v1", "v2"], ["root", "", "v2"], ["root", "v1", ""],
    ["root", "--all", "v2"], ["root", "v1", "v2\0"], ["root", "v1\nv2", "v3"],
  ]) {
    await assert.rejects(comparison.execute(...args), CommitComparisonInputError);
  }
  await assert.rejects(comparison.execute("missing", "v1", "v2"), CommitComparisonProjectNotFoundError);
  assert.deepEqual(calls, []);
});

test("Git failures propagate instead of becoming empty or successful diffs", async () => {
  const { comparison, gitClient } = createComparison();
  const missing = new GitRefNotFoundError("missing-tag");
  gitClient.compareCommits = async () => { throw missing; };
  await assert.rejects(comparison.execute("root", "v1", "missing-tag"), error => error === missing);
  gitClient.compareCommits = async () => { throw new Error("Access denied"); };
  await assert.rejects(comparison.execute("root", "v1", "v2"), /Access denied/);
});

for (const [repoUrl, commitBase] of [
  ["https://github.com/example/child.git", "https://github.com/example/child/commit"],
  ["git@gitlab.com:group/subgroup/child.git", "https://gitlab.com/group/subgroup/child/-/commit"],
  ["git@bitbucket.org:workspace/child.git", "https://bitbucket.org/workspace/child/commits"],
  ["ssh://git@bitbucket.example.com:7999/EXAMPLE/child.git",
    "https://bitbucket.example.com/projects/EXAMPLE/repos/child/commits"],
]) {
  test(`commit comparison uses detected commit links without changing Git transport: ${repoUrl}`, async () => {
    const { comparison, child, calls } = createComparison();
    child.repoUrl = repoUrl;
    const result = await comparison.execute(child.id, "v1", "v2");
    assert.equal(result.fromOnly[0].url, `${commitBase}/${fromHash}`);
    assert.equal(result.toOnly[0].url, `${commitBase}/${toHash}`);
    assert.deepEqual(calls, [[repoUrl, "v1", "v2"]]);
  });
}

test("HTTP commit diffs preserve sides, encode tags, and return explicit validation, lookup, and Git errors", async context => {
  const { comparison, gitClient, calls, child } = createComparison();
  const errors = [];
  const unused = (_req, res) => res.sendStatus(501);
  const app = express();
  app.use("/api", createRoutes(
    { resolveDependencies: unused },
    { getAvailableVersions: unused, getVersion: unused },
    { compareVersions: unused },
    {
      getAllProjects: unused, getProject: unused, createProject: unused,
      updateProject: unused, deleteProject: unused,
    },
    undefined,
    new CommitDiffController(comparison, {
      error: (...args) => errors.push(args),
    })
  ));
  const server = app.listen(0, "127.0.0.1");
  context.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  }));
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/api/projects`;
  const query = new URLSearchParams({ fromVersion: "release/v1+build", toVersion: "release/v2" });
  const success = await fetch(`${base}/child/commit-diffs?${query}`);
  assert.equal(success.status, 200);
  const result = await success.json();
  assert.deepEqual(calls[0], ["git@github.com:example/child.git", "release/v1+build", "release/v2"]);
  assert.equal(result.fromVersion, "release/v1+build");
  assert.equal(result.toVersion, "release/v2");
  assert.equal(result.fromOnly[0].hash, fromHash);
  assert.equal(result.fromOnly[0].committedAt, fromDate);
  assert.equal(result.toOnly[0].hash, toHash);
  assert.equal(result.toOnly[0].committedAt, toDate);
  assert.equal(result.toOnly[0].url, `https://github.com/example/child/commit/${toHash}`);
  const cachedResponse = await fetch(`${base}/child/commit-diffs?${query}`);
  assert.equal(cachedResponse.status, 200);
  assert.deepEqual(await cachedResponse.json(), result);
  assert.equal(calls.length, 1);

  for (const query of [
    "", "fromVersion=v1", "fromVersion=v1&toVersion=v2&toVersion=v3",
    "fromVersion=--all&toVersion=v2",
  ]) {
    const invalid = await fetch(`${base}/child/commit-diffs?${query}`);
    assert.equal(invalid.status, 400);
    assert.equal(typeof (await invalid.json()).error, "string");
  }
  const unknownProject = await fetch(`${base}/missing/commit-diffs?${query}`);
  assert.equal(unknownProject.status, 404);
  gitClient.compareCommits = async () => { throw new GitRefNotFoundError("missing-tag"); };
  const missingRef = await fetch(`${base}/child/commit-diffs?fromVersion=v1&toVersion=missing-tag`);
  assert.equal(missingRef.status, 404);
  assert.match((await missingRef.json()).error, /missing-tag/);

  gitClient.compareCommits = async () => { throw new Error("Private repository access failure"); };
  const failed = await fetch(`${base}/child/commit-diffs?fromVersion=v1&toVersion=unavailable`);
  assert.equal(failed.status, 500);
  assert.match((await failed.json()).error, /Unable to compare commit histories/);
  assert.equal(errors.length, 1);

  gitClient.compareCommits = async () => diff;
  child.repoUrl = "https://bitbucket.example.com/scm/example/child.git";
  const bitbucket = await fetch(`${base}/child/commit-diffs?${query}`);
  assert.equal(bitbucket.status, 200);
  assert.equal((await bitbucket.json()).toOnly[0].url,
    `https://bitbucket.example.com/projects/EXAMPLE/repos/child/commits/${toHash}`);

  child.repoUrl = "https://username:placeholder@unknown.invalid/group/repository.git";
  const unsupported = await fetch(`${base}/child/commit-diffs?${query}`);
  assert.equal(unsupported.status, 500);
  assert.equal((await unsupported.json()).error, 'Unsupported source-control host "unknown.invalid".');
  assert.equal(errors.length, 2);
});
