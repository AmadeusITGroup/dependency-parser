const assert = require("node:assert/strict");
const { execFile: execFileCallback } = require("node:child_process");
const { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { pathToFileURL } = require("node:url");
const { promisify } = require("node:util");

const { GitCliClient } = require("../dist/infrastructure/git/GitCliClient");
const { GitRefNotFoundError } = require("../dist/domain/interfaces/IGitClient");
const { VersionLocatorService } = require("../dist/application/services/VersionLocatorService");
const { ScanProjectDependencies } = require("../dist/application/use-cases/ScanProjectDependencies");
const { FindRootVersion, VersionSearchInputError } = require("../dist/application/use-cases/FindRootVersion");
const { GetDependencyVersion } = require("../dist/application/use-cases/GetDependencyVersion");
const { ProjectRegistry } = require("../dist/infrastructure/registry/ProjectRegistry");
const { JsonFileDataStore } = require("../dist/infrastructure/storage/JsonFileDataStore");
const { DependencyNode } = require("../dist/domain/models/DependencyNode");
const { DependencyTree } = require("../dist/domain/models/DependencyTree");
const { Project } = require("../dist/domain/models/Project");
const { ProjectDependency } = require("../dist/domain/models/ProjectDependency");
const { ConcurrencyLimiter, ReadWriteLock } = require("../dist/utils/ConcurrencyLimiter");

const execFile = promisify(execFileCallback);

function deferred() {
  let resolve;
  const promise = new Promise(onResolve => { resolve = onResolve; });
  return { promise, resolve };
}

async function git(repoPath, args, env = process.env) {
  const { stdout } = await execFile("git", args, { cwd: repoPath, windowsHide: true, env });
  return stdout.trim();
}

async function commitVersion(repoPath, version, env) {
  await writeFile(
    path.join(repoPath, "package.json"),
    `${JSON.stringify({ name: "fixture", version })}\n`
  );
  await git(repoPath, ["add", "--", "package.json"]);
  await git(repoPath, ["commit", "-m", `Version ${version}`], env);
  return git(repoPath, ["rev-parse", "HEAD"]);
}

async function createRepository(context, objectFormat) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dependency-parser-git-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const repoPath = path.join(directory, "remote");
  const clonePath = path.join(directory, "cache");
  const hooksPath = path.join(directory, "hooks");
  await mkdir(hooksPath);
  await git(directory, [
    "init", "--initial-branch=main", ...(objectFormat ? [`--object-format=${objectFormat}`] : []), repoPath,
  ]);
  for (const [key, value] of Object.entries({
    "user.name": "Dependency Parser Test",
    "user.email": "test@example.invalid",
    "commit.gpgSign": "false",
    "tag.gpgSign": "false",
    "core.hooksPath": hooksPath,
    "uploadpack.allowFilter": "true",
  })) {
    await git(repoPath, ["config", key, value]);
  }
  const initialCommit = await commitVersion(repoPath, "1.0.0");
  await git(repoPath, ["tag", "v1.0.0"]);
  const client = new GitCliClient();
  context.after(() => client.clearCommitComparisonCache());

  return {
    directory,
    repoPath,
    repoUrl: pathToFileURL(repoPath).href,
    clonePath,
    initialCommit,
    client,
  };
}

async function appendHistory(repoPath, branch, count, parent) {
  const records = [];
  for (let index = 0; index < count; index += 1) {
    const subject = `${branch} history ${index + 1}`;
    records.push(
      `commit refs/heads/${branch}\nmark :${index + 1}\n` +
      `committer Dependency Parser Test <test@example.invalid> ${1700000000 + index} +0000\n` +
      `data ${Buffer.byteLength(subject)}\n${subject}\n` +
      `from ${index === 0 ? parent : `:${index}`}\n\n`
    );
  }
  records.push("done\n");
  const command = execFile("git", ["fast-import", "--quiet"], { cwd: repoPath, windowsHide: true });
  command.child.stdin.end(records.join(""));
  await command;
  return git(repoPath, ["rev-parse", `refs/heads/${branch}`]);
}

test("commit comparisons exclude shared history and support upgrades, downgrades, and annotated tags", async context => {
  const { client, repoPath, repoUrl, initialCommit } = await createRepository(context);
  const middleDate = "2026-10-20T12:34:56+02:00";
  const latestDate = "2026-10-22T09:08:07-04:00";
  const middle = await commitVersion(repoPath, "1.1.0", {
    ...process.env, GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z", GIT_COMMITTER_DATE: middleDate,
  });
  const latest = await commitVersion(repoPath, "2.0.0", {
    ...process.env, GIT_AUTHOR_DATE: "2020-02-01T00:00:00Z", GIT_COMMITTER_DATE: latestDate,
  });
  await git(repoPath, ["tag", "-a", "release/v2.0.0", "-m", "Release two"], {
    ...process.env, GIT_COMMITTER_DATE: "2026-10-23T00:00:00Z",
  });
  await git(repoPath, ["tag", "-a", "nested-release", "-m", "Nested tag", "release/v2.0.0"]);
  const expected = [
    { hash: latest, subject: "Version 2.0.0", committedAt: latestDate },
    { hash: middle, subject: "Version 1.1.0", committedAt: middleDate },
  ];

  const forward = await client.compareCommits(repoUrl, "v1.0.0", "release/v2.0.0");
  assert.deepEqual(forward, {
    fromCommitHash: initialCommit, toCommitHash: latest, fromOnly: [], toOnly: expected,
  });
  const reverse = await client.compareCommits(repoUrl, "release/v2.0.0", "v1.0.0");
  assert.deepEqual(reverse, {
    fromCommitHash: latest, toCommitHash: initialCommit, fromOnly: expected, toOnly: [],
  });
  assert.deepEqual(await client.compareCommits(repoUrl, "v1.0.0", "nested-release"), forward);
});

test("commit comparisons return both exclusive histories and preserve commit subjects", async context => {
  const { client, repoPath, repoUrl, initialCommit } = await createRepository(context);
  const subject = 'Fix "quoted" names | keep\ttabs and <markup>';
  await git(repoPath, ["commit", "--allow-empty", "-m", subject]);
  const left = await git(repoPath, ["rev-parse", "HEAD"]);
  await git(repoPath, ["tag", "left"]);
  await git(repoPath, ["checkout", "-b", "other", initialCommit]);
  const right = await commitVersion(repoPath, "3.0.0");
  await git(repoPath, ["tag", "right"]);
  const leftDate = await git(repoPath, ["show", "-s", "--format=%cI", left]);
  const rightDate = await git(repoPath, ["show", "-s", "--format=%cI", right]);

  assert.deepEqual(await client.compareCommits(repoUrl, "left", "right"), {
    fromCommitHash: left,
    toCommitHash: right,
    fromOnly: [{ hash: left, subject, committedAt: leftDate }],
    toOnly: [{ hash: right, subject: "Version 3.0.0", committedAt: rightDate }],
  });
});

test("different tags pointing to the same commit have no differences", async context => {
  const { client, repoPath, repoUrl, initialCommit } = await createRepository(context);
  await git(repoPath, ["tag", "-a", "same-commit", "-m", "Alias"]);

  assert.deepEqual(await client.compareCommits(repoUrl, "v1.0.0", "same-commit"), {
    fromCommitHash: initialCommit, toCommitHash: initialCommit, fromOnly: [], toOnly: [],
  });
});

test("commit comparisons keep v-prefixed tags distinct and reject missing prefix forms", async context => {
  const { client, repoPath, repoUrl, initialCommit } = await createRepository(context);
  const second = await commitVersion(repoPath, "2.0.0");
  for (const tag of ["1.0.0", "v2.0.0", "3.0.0"]) {
    await git(repoPath, ["tag", tag]);
  }
  const comparison = await client.compareCommits(repoUrl, "v1.0.0", "1.0.0");
  assert.equal(comparison.fromCommitHash, initialCommit);
  assert.equal(comparison.toCommitHash, second);
  assert.deepEqual(comparison.toOnly.map(commit => commit.hash), [second]);

  for (const missing of ["2.0.0", "v3.0.0"]) {
    for (const existing of ["v1.0.0", "HEAD"]) {
      for (const [from, to] of [[missing, existing], [existing, missing]]) {
        await assert.rejects(client.compareCommits(repoUrl, from, to), error => {
          assert.ok(error instanceof GitRefNotFoundError);
          assert.equal(error.ref, missing);
          return true;
        });
      }
    }
  }
});

test("commit comparisons preserve full ref resolution and clean compatibility clones after failures", async context => {
  const { client, repoUrl, directory } = await createRepository(context);
  const clones = [];
  const syncTags = client.syncTags.bind(client);
  client.syncTags = async (remote, targetPath) => {
    clones.push(targetPath);
    return syncTags(remote, targetPath);
  };

  await client.compareCommits(repoUrl, "HEAD", "v1.0.0");
  await assert.rejects(client.compareCommits(repoUrl, "v1.0.0", "missing-tag"), error => {
    assert.ok(error instanceof GitRefNotFoundError);
    assert.equal(error.ref, "missing-tag");
    return true;
  });
  await assert.rejects(client.compareCommits(path.join(directory, "missing"), "HEAD", "v2"),
    /Git command failed/);
  assert.equal(clones.length, 2);
  for (const clone of clones) {
    await assert.rejects(access(clone), { code: "ENOENT" });
  }
  await assert.rejects(client.compareCommits(repoUrl, "--all", "v1.0.0"), /Invalid git ref/);
  await assert.rejects(client.compareCommits(repoUrl, "v1\nv2", "v1.0.0"), /Invalid git ref/);
  assert.equal(clones.length, 2);
});

test("commit comparisons fetch only requested commit history without changing shared tag catalogs", async context => {
  const { client, repoPath, repoUrl, clonePath, initialCommit } = await createRepository(context);
  const second = await commitVersion(repoPath, "2.0.0");
  await git(repoPath, ["tag", "v2.0.0"]);
  const third = await commitVersion(repoPath, "3.0.0");
  await git(repoPath, ["tag", "v3.0.0"]);
  await git(repoPath, ["checkout", "-b", "unrelated", initialCommit]);
  await commitVersion(repoPath, "99.0.0");
  await git(repoPath, ["tag", "unrelated"]);
  await client.syncTags(repoUrl, clonePath, "^v1\\.0\\.0$");
  const catalogBefore = await git(clonePath, ["for-each-ref"]);
  const shallowBefore = await git(clonePath, ["rev-parse", "--is-shallow-repository"]);

  const commands = [];
  const executeGit = client.executeGit.bind(client);
  context.mock.method(client, "executeGit", async (args, cwd, options) => {
    commands.push({ args, cwd, options });
    return executeGit(args, cwd, options);
  });

  const first = await client.compareCommits(repoUrl, "v1.0.0", "v2.0.0");
  assert.equal(first.fromCommitHash, initialCommit);
  assert.deepEqual(first.toOnly.map(commit => commit.hash), [second]);
  assert.deepEqual(first.fromOnly, []);
  assert.deepEqual(commands.map(command => command.args[0]),
    ["ls-remote", "init", "remote", "fetch", "show-ref", "log"]);
  const initialized = commands.filter(command => command.args[0] === "init");
  assert.equal(initialized.length, 1);
  const historyPath = initialized[0].args.at(-1);
  assert.notEqual(historyPath, clonePath);
  assert.equal(await git(historyPath, ["rev-parse", "--is-bare-repository"]), "false");
  await assert.rejects(access(path.join(historyPath, "package.json")), { code: "ENOENT" });
  assert.equal(await git(historyPath, ["rev-parse", "--is-shallow-repository"]), "false");
  assert.equal(await git(historyPath, ["config", "remote.origin.partialclonefilter"]), "tree:0");
  assert.deepEqual(new Set((await git(historyPath, ["rev-list", "--all"])).split("\n")),
    new Set([initialCommit, second]));
  const types = await git(historyPath, ["cat-file", "--batch-all-objects", "--batch-check=%(objecttype)"]);
  assert.deepEqual(new Set(types.split("\n")), new Set(["commit"]));
  assert.deepEqual((await git(historyPath, ["for-each-ref", "--format=%(refname)", "refs/tags"])).split("\n").sort(),
    ["refs/tags/v1.0.0", "refs/tags/v2.0.0"]);

  const beforeNext = commands.length;
  const next = await client.compareCommits(repoUrl, "v1.0.0", "v3.0.0");
  assert.deepEqual(next.toOnly.map(commit => commit.hash), [third, second]);
  assert.equal(commands.length - beforeNext, 4);
  const beforeReverse = commands.length;
  const reverse = await client.compareCommits(repoUrl, "v3.0.0", "v1.0.0");
  assert.deepEqual(reverse.fromOnly, next.toOnly);
  assert.equal(commands.length - beforeReverse, 4);
  assert.equal(commands.filter(command => command.args[0] === "init").length, 1);
  assert.equal(commands.filter(command => command.args[0] === "clone").length, 0);
  const fetches = commands.filter(command => command.args[0] === "fetch");
  assert.equal(fetches.length, 3);
  assert.ok(fetches.every(command => command.args.includes("--filter=tree:0")));
  assert.ok(fetches.every(command => command.args.includes("--depth=64")));
  assert.ok(fetches.every(command => !command.options.input.includes("*")));
  assert.equal(fetches[0].options.input, "+refs/tags/v1.0.0:refs/tags/v1.0.0\n+refs/tags/v2.0.0:refs/tags/v2.0.0\n");
  assert.equal(commands.filter(command => command.args[0] === "ls-remote").length, 3);
  assert.equal(await git(clonePath, ["for-each-ref"]), catalogBefore);
  assert.equal(await git(clonePath, ["rev-parse", "--is-shallow-repository"]), shallowBefore);

  await client.clearCommitComparisonCache();
  await assert.rejects(access(historyPath), { code: "ENOENT" });
});

test("commit comparison history checks moved and deleted tags before reusing cached objects", async context => {
  const { client, repoPath, repoUrl, initialCommit } = await createRepository(context);
  await commitVersion(repoPath, "2.0.0");
  await git(repoPath, ["tag", "v2.0.0"]);
  await client.compareCommits(repoUrl, "v1.0.0", "v2.0.0");
  const moved = await commitVersion(repoPath, "3.0.0");
  await git(repoPath, ["tag", "-f", "-a", "v2.0.0", "-m", "Moved release"]);
  const refreshed = await client.compareCommits(repoUrl, "v1.0.0", "v2.0.0");
  assert.equal(refreshed.toCommitHash, moved);
  assert.equal(refreshed.toOnly.length, 2);

  await git(repoPath, ["tag", "-d", "v2.0.0"]);
  await git(repoPath, ["tag", "2.0.0", initialCommit]);
  await assert.rejects(client.compareCommits(repoUrl, "v1.0.0", "v2.0.0"), GitRefNotFoundError);
  assert.equal((await client.compareCommits(repoUrl, "v1.0.0", "2.0.0")).toCommitHash, initialCommit);
  await git(repoPath, ["tag", "-d", "2.0.0"]);
  await assert.rejects(client.compareCommits(repoUrl, "v1.0.0", "v2.0.0"), error => {
    assert.ok(error instanceof GitRefNotFoundError);
    assert.equal(error.ref, "v2.0.0");
    return true;
  });
});

test("commit comparison history resolves synchronized identities when tags move during transfer", async context => {
  const { client, repoPath, repoUrl } = await createRepository(context);
  const second = await commitVersion(repoPath, "2.0.0");
  await git(repoPath, ["tag", "v2.0.0"]);
  const third = await commitVersion(repoPath, "3.0.0");
  const executeGit = client.executeGit.bind(client);
  let move = true;
  context.mock.method(client, "executeGit", async (args, ...rest) => {
    if (args[0] === "fetch" && move) {
      move = false;
      await git(repoPath, ["tag", "-f", "v2.0.0", third]);
    }
    return executeGit(args, ...rest);
  });
  const moved = await client.compareCommits(repoUrl, "v1.0.0", "v2.0.0");
  assert.equal(moved.toCommitHash, third);
  const refreshed = await client.compareCommits(repoUrl, "v1.0.0", "v2.0.0");
  assert.equal(refreshed.toCommitHash, third);
  await git(repoPath, ["tag", "-f", "v2.0.0", second]);
  const restored = await client.compareCommits(repoUrl, "v1.0.0", "v2.0.0");
  assert.equal(restored.toCommitHash, second);
});

test("commit comparison history serializes different pairs and separates repositories", async context => {
  const { client, repoPath, repoUrl, initialCommit } = await createRepository(context);
  const second = await commitVersion(repoPath, "2.0.0");
  await git(repoPath, ["tag", "v2.0.0"]);
  const third = await commitVersion(repoPath, "3.0.0");
  await git(repoPath, ["tag", "v3.0.0"]);
  const other = await createRepository(context);
  const otherSecond = await commitVersion(other.repoPath, "different-content");
  await git(other.repoPath, ["tag", "v2.0.0"]);
  const active = new Map();
  const readCommitDiff = client.readCommitDiff.bind(client);
  context.mock.method(client, "readCommitDiff", async (repo, ...args) => {
    const count = (active.get(repo) ?? 0) + 1;
    active.set(repo, count);
    assert.equal(count, 1);
    try {
      return await readCommitDiff(repo, ...args);
    } finally {
      active.set(repo, count - 1);
    }
  });
  const [left, right, separate] = await Promise.all([
    client.compareCommits(repoUrl, "v1.0.0", "v2.0.0"),
    client.compareCommits(repoUrl, "v2.0.0", "v3.0.0"),
    client.compareCommits(other.repoUrl, "v1.0.0", "v2.0.0"),
  ]);
  assert.equal(left.fromCommitHash, initialCommit);
  assert.deepEqual(left.toOnly.map(commit => commit.hash), [second]);
  assert.deepEqual(right.toOnly.map(commit => commit.hash), [third]);
  assert.deepEqual(separate.toOnly.map(commit => commit.hash), [otherSecond]);
  assert.equal(client.comparisonRepositories.size, 2);
  assert.equal(active.size, 2);
});

test("commit comparison history survives a failed incremental fetch and permits retry", async context => {
  const { client, repoPath, repoUrl } = await createRepository(context);
  await client.compareCommits(repoUrl, "v1.0.0", "v1.0.0");
  const cached = client.comparisonRepositories.get(repoUrl);
  const second = await commitVersion(repoPath, "2.0.0");
  await git(repoPath, ["tag", "v2.0.0"]);
  const failure = new Error("Incremental fetch failed");
  const executeGit = client.executeGit.bind(client);
  let fail = true;
  context.mock.method(client, "executeGit", async (args, ...rest) => {
    if (args[0] === "fetch" && fail) {
      fail = false;
      throw failure;
    }
    return executeGit(args, ...rest);
  });
  await assert.rejects(client.compareCommits(repoUrl, "v1.0.0", "v2.0.0"), failure);
  const retried = await client.compareCommits(repoUrl, "v1.0.0", "v2.0.0");
  assert.equal(retried.toCommitHash, second);
  assert.equal(client.comparisonRepositories.get(repoUrl), cached);
});

test("commit comparison history bounds idle repositories with LRU eviction without deleting active work", async context => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dependency-parser-history-"));
  const client = new GitCliClient();
  context.after(() => rm(directory, { recursive: true, force: true }));
  context.after(() => client.clearCommitComparisonCache());
  context.mock.method(client, "createComparisonRepository", async () =>
    mkdtemp(path.join(directory, "history-"))
  );
  const visit = (id, operation = async repo => repo) =>
    client.withComparisonRepository(id, operation);
  const paths = [];
  for (let index = 0; index < 8; index += 1) paths.push(await visit(`remote-${index}`));
  await visit("remote-0");
  paths.push(await visit("remote-8"));
  assert.equal(client.comparisonRepositories.size, 8);
  await access(paths[0]);
  await assert.rejects(access(paths[1]), { code: "ENOENT" });
  const release = deferred();
  const started = deferred();
  const working = visit("remote-0", async repo => {
    started.resolve();
    await release.promise;
    await access(repo);
  });
  try {
    await started.promise;
    for (let index = 9; index < 18; index += 1) paths.push(await visit(`remote-${index}`));
    await access(paths[0]);
    assert.equal(client.comparisonRepositories.size, 8);
  } finally {
    release.resolve();
    await working;
  }
  await client.clearCommitComparisonCache();
  assert.equal(client.comparisonRepositories.size, 0);
  for (const repo of paths) await assert.rejects(access(repo), { code: "ENOENT" });
});

test("commit comparison history initialization failures clean up and do not poison retries", async context => {
  const { client, repoUrl } = await createRepository(context);
  const paths = [];
  const createClonePath = client.createClonePath.bind(client);
  context.mock.method(client, "createClonePath", async () => {
    const repo = await createClonePath();
    paths.push(repo);
    return repo;
  });
  const executeGit = client.executeGit.bind(client);
  const failure = new Error("Cannot initialize comparison history");
  let fail = true;
  context.mock.method(client, "executeGit", async (args, ...rest) => {
    if (args[0] === "init" && fail) {
      fail = false;
      throw failure;
    }
    return executeGit(args, ...rest);
  });
  const attempts = await Promise.allSettled([
    client.compareCommits(repoUrl, "v1.0.0", "v1.0.0"),
    client.compareCommits(repoUrl, "v1.0.0", "v1.0.0"),
  ]);
  assert.ok(attempts.some(result => result.status === "rejected" && result.reason === failure));
  await assert.rejects(access(paths[0]), { code: "ENOENT" });
  const retry = await client.compareCommits(repoUrl, "v1.0.0", "v1.0.0");
  assert.deepEqual(retry.fromOnly, []);
  assert.deepEqual(retry.toOnly, []);
});

test("commit comparison catalog hints avoid discovery without trusting stale commit hashes", async context => {
  const { client, repoPath, repoUrl, initialCommit } = await createRepository(context);
  const second = await commitVersion(repoPath, "2.0.0");
  await git(repoPath, ["tag", "v2.0.0"]);
  const hints = { fromCommitHash: initialCommit, toCommitHash: second };
  const third = await commitVersion(repoPath, "3.0.0");
  await git(repoPath, ["tag", "-f", "v2.0.0"]);
  const commands = [];
  const executeGit = client.executeGit.bind(client);
  context.mock.method(client, "executeGit", async (args, ...rest) => {
    commands.push(args);
    return executeGit(args, ...rest);
  });
  const moved = await client.compareCommits(repoUrl, "v1.0.0", "v2.0.0", hints);
  assert.equal(moved.toCommitHash, third);
  assert.deepEqual(commands.map(args => args[0]), ["init", "remote", "fetch", "show-ref", "log"]);

  await git(repoPath, ["tag", "-d", "v2.0.0"]);
  await git(repoPath, ["tag", "2.0.0", initialCommit]);
  await assert.rejects(client.compareCommits(repoUrl, "v1.0.0", "v2.0.0", hints), GitRefNotFoundError);
  assert.equal((await client.compareCommits(repoUrl, "v1.0.0", "2.0.0")).toCommitHash, initialCommit);
  await git(repoPath, ["tag", "-d", "2.0.0"]);
  await assert.rejects(client.compareCommits(repoUrl, "v1.0.0", "v2.0.0", hints), error => {
    assert.ok(error instanceof GitRefNotFoundError);
    assert.equal(error.ref, "v2.0.0");
    return true;
  });
});

test("commit comparisons deepen distant histories and remain exact after another cached pair", async context => {
  const { client, repoPath, repoUrl, initialCommit } = await createRepository(context);
  const last = await appendHistory(repoPath, "main", 200, initialCommit);
  await git(repoPath, ["tag", "distant", last]);
  const expected = await client.readCommitDiff(repoPath, initialCommit, last, true);
  const fetches = [];
  const executeGit = client.executeGit.bind(client);
  context.mock.method(client, "executeGit", async (args, ...rest) => {
    if (args[0] === "fetch") fetches.push(args);
    return executeGit(args, ...rest);
  });
  const actual = await client.compareCommits(repoUrl, "v1.0.0", "distant");
  assert.deepEqual(actual, expected);
  assert.equal(actual.toOnly.length, 200);
  assert.ok(fetches.some(args => args.includes("--deepen=64")));
  assert.ok(fetches.some(args => args.includes("--deepen=128")));
  assert.ok(fetches.every(args => !args.includes("--unshallow")));
  const reversed = await client.compareCommits(repoUrl, "distant", "v1.0.0");
  assert.deepEqual(reversed.fromOnly, expected.toOnly);
  assert.deepEqual(reversed.toOnly, []);
});

test("commit comparisons deepen merged and diverged histories instead of returning shallow artifacts", async context => {
  const { client, repoPath, repoUrl, initialCommit } = await createRepository(context);
  const common = await appendHistory(repoPath, "main", 100, initialCommit);
  await appendHistory(repoPath, "main", 90, common);
  const feature = await appendHistory(repoPath, "feature", 100, common);
  await git(repoPath, ["merge", "--no-ff", "-m", "Merge feature history", "feature"]);
  const baseline = await git(repoPath, ["rev-parse", "HEAD"]);
  const comparison = await appendHistory(repoPath, "feature", 80, feature);
  await git(repoPath, ["tag", "baseline", baseline]);
  await git(repoPath, ["tag", "comparison", comparison]);
  const expected = await client.readCommitDiff(repoPath, baseline, comparison, true);
  const actual = await client.compareCommits(repoUrl, "baseline", "comparison");
  assert.deepEqual(actual, expected);
  assert.equal(actual.fromOnly.length, 91);
  assert.equal(actual.toOnly.length, 80);
});

test("commit comparisons stop at shared shallow boundaries with multiple merge bases", async context => {
  const { client, repoPath, repoUrl, initialCommit } = await createRepository(context);
  const left = await appendHistory(repoPath, "main", 90, initialCommit);
  const right = await appendHistory(repoPath, "feature", 90, initialCommit);
  const tree = await git(repoPath, ["rev-parse", `${initialCommit}^{tree}`]);
  const first = await git(repoPath, ["commit-tree", tree, "-p", left, "-p", right, "-m", "Left merge"]);
  const second = await git(repoPath, ["commit-tree", tree, "-p", right, "-p", left, "-m", "Right merge"]);
  await git(repoPath, ["tag", "merge-left", first]);
  await git(repoPath, ["tag", "merge-right", second]);
  const expected = await client.readCommitDiff(repoPath, first, second, true);
  const fetches = [];
  const executeGit = client.executeGit.bind(client);
  context.mock.method(client, "executeGit", async (args, ...rest) => {
    if (args[0] === "fetch") fetches.push(args);
    return executeGit(args, ...rest);
  });
  const actual = await client.compareCommits(repoUrl, "merge-left", "merge-right");
  assert.deepEqual(actual, expected);
  assert.deepEqual(actual.fromOnly.map(commit => commit.hash), [first]);
  assert.deepEqual(actual.toOnly.map(commit => commit.hash), [second]);
  assert.equal(fetches.length, 1);
  const history = await client.comparisonRepositories.get(repoUrl).path;
  assert.equal(await git(history, ["rev-parse", "--is-shallow-repository"]), "true");
});

test("commit comparisons deepen unrelated histories until both exclusive graphs are complete", async context => {
  const { client, repoPath, repoUrl, initialCommit } = await createRepository(context);
  const left = await appendHistory(repoPath, "main", 100, initialCommit);
  const tree = await git(repoPath, ["rev-parse", `${initialCommit}^{tree}`]);
  const orphan = await git(repoPath, ["commit-tree", tree, "-m", "Independent root"]);
  const right = await appendHistory(repoPath, "independent", 120, orphan);
  await git(repoPath, ["tag", "island-left", left]);
  await git(repoPath, ["tag", "island-right", right]);
  const expected = await client.readCommitDiff(repoPath, left, right, true);
  const actual = await client.compareCommits(repoUrl, "island-left", "island-right");
  assert.deepEqual(actual, expected);
  assert.equal(actual.fromOnly.length, 101);
  assert.equal(actual.toOnly.length, 121);
});

test("commit comparisons re-resolve moved tags during adaptive deepening", async context => {
  const { client, repoPath, repoUrl, initialCommit } = await createRepository(context);
  const previous = await appendHistory(repoPath, "main", 150, initialCommit);
  await git(repoPath, ["tag", "moving", previous]);
  const latest = await appendHistory(repoPath, "main", 50, previous);
  const expected = await client.readCommitDiff(repoPath, initialCommit, latest, true);
  const executeGit = client.executeGit.bind(client);
  let move = true;
  context.mock.method(client, "executeGit", async (args, ...rest) => {
    if (move && args.some(arg => arg.startsWith("--deepen="))) {
      move = false;
      await git(repoPath, ["tag", "-f", "moving", latest]);
    }
    return executeGit(args, ...rest);
  });
  const actual = await client.compareCommits(repoUrl, "v1.0.0", "moving");
  assert.equal(move, false);
  assert.deepEqual(actual, expected);
  assert.equal(actual.toOnly.length, 200);
});

test("commit comparisons retrieve complete selected ancestry after the adaptive deepening budget", async context => {
  const { client, repoPath, repoUrl, initialCommit } = await createRepository(context);
  const last = await appendHistory(repoPath, "main", 1100, initialCommit);
  await git(repoPath, ["tag", "far-release", last]);
  const expected = await client.readCommitDiff(repoPath, initialCommit, last, true);
  const fetches = [];
  const executeGit = client.executeGit.bind(client);
  context.mock.method(client, "executeGit", async (args, ...rest) => {
    if (args[0] === "fetch") fetches.push(args);
    return executeGit(args, ...rest);
  });
  assert.deepEqual(await client.compareCommits(repoUrl, "v1.0.0", "far-release"), expected);
  assert.equal(expected.toOnly.length, 1100);
  assert.equal(fetches.filter(args => args.includes("--unshallow")).length, 1);
  const history = await client.comparisonRepositories.get(repoUrl).path;
  assert.equal(await git(history, ["rev-parse", "--is-shallow-repository"]), "false");
});

test("commit comparisons never return partial results when deepening fails and allow retry", async context => {
  const { client, repoPath, repoUrl, initialCommit } = await createRepository(context);
  const last = await appendHistory(repoPath, "main", 150, initialCommit);
  await git(repoPath, ["tag", "later", last]);
  const expected = await client.readCommitDiff(repoPath, initialCommit, last, true);
  const executeGit = client.executeGit.bind(client);
  const failure = new Error("History deepening failed");
  let fail = true;
  context.mock.method(client, "executeGit", async (args, ...rest) => {
    if (fail && args.some(arg => arg.startsWith("--deepen="))) {
      fail = false;
      throw failure;
    }
    return executeGit(args, ...rest);
  });
  await assert.rejects(client.compareCommits(repoUrl, "v1.0.0", "later"), failure);
  assert.deepEqual(await client.compareCommits(repoUrl, "v1.0.0", "later"), expected);
});

test("commit comparisons handle SHA-256 repositories and repair stale catalog object-format hints", async context => {
  const { client, repoPath, repoUrl, initialCommit } = await createRepository(context, "sha256");
  const last = await commitVersion(repoPath, "2.0.0");
  await git(repoPath, ["tag", "v2.0.0"]);
  const hints = { fromCommitHash: "a".repeat(40), toCommitHash: "b".repeat(40) };
  const actual = await client.compareCommits(repoUrl, "v1.0.0", "v2.0.0", hints);
  assert.equal(actual.fromCommitHash, initialCommit);
  assert.equal(actual.toCommitHash, last);
  assert.equal(actual.toOnly.length, 1);
  assert.deepEqual(await client.compareCommits(repoUrl, "v1.0.0", "v2.0.0", hints), actual);
  const history = await client.comparisonRepositories.get(repoUrl).path;
  assert.equal(await git(history, ["rev-parse", "--show-object-format"]), "sha256");
});

test("commit comparison history cleanup waits for active comparisons", async context => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dependency-parser-history-close-"));
  const client = new GitCliClient();
  context.after(() => rm(directory, { recursive: true, force: true }));
  context.after(() => client.clearCommitComparisonCache());
  context.mock.method(client, "createComparisonRepository", async () =>
    mkdtemp(path.join(directory, "history-"))
  );
  const started = deferred();
  const release = deferred();
  let historyPath;
  const working = client.withComparisonRepository("remote", async repo => {
    historyPath = repo;
    started.resolve();
    await release.promise;
  });
  await started.promise;
  let cleaned = false;
  const clearing = client.clearCommitComparisonCache().then(() => { cleaned = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cleaned, false);
    await access(historyPath);
  } finally {
    release.resolve();
    await Promise.all([working, clearing]);
  }
  await assert.rejects(access(historyPath), { code: "ENOENT" });
});

test("commit comparisons retain non-tag expressions and branch precedence without aliasing noncommit tags", async context => {
  const { client, repoPath, repoUrl, initialCommit } = await createRepository(context);
  const second = await commitVersion(repoPath, "2.0.0");
  await git(repoPath, ["tag", "v2.0.0"]);
  const expression = await client.compareCommits(repoUrl, "HEAD~1", "v2.0.0");
  assert.equal(expression.fromCommitHash, initialCommit);
  assert.equal(expression.toCommitHash, second);
  const hashes = await client.compareCommits(repoUrl, initialCommit, second);
  assert.deepEqual(hashes, expression);
  await git(repoPath, ["tag", "vmain", initialCommit]);
  const branch = await client.compareCommits(repoUrl, "main", "v1.0.0");
  assert.equal(branch.fromCommitHash, second);
  assert.equal(branch.toCommitHash, initialCommit);

  const blob = await git(repoPath, ["rev-parse", "HEAD:package.json"]);
  await git(repoPath, ["tag", "blob-tag", blob]);
  await git(repoPath, ["tag", "vblob-tag", second]);
  await assert.rejects(client.compareCommits(repoUrl, "blob-tag", "v1.0.0"), error => {
    assert.ok(error instanceof GitRefNotFoundError);
    assert.equal(error.ref, "blob-tag");
    return true;
  });
  await git(repoPath, ["tag", "blob-only", blob]);
  await assert.rejects(client.compareCommits(repoUrl, "blob-only", "blob-only"), error => {
    assert.ok(error instanceof GitRefNotFoundError);
    assert.equal(error.ref, "blob-only");
    return true;
  });
});

test("the shared limiter bounds operations and releases slots after failure", async () => {
  const limiter = new ConcurrencyLimiter(2);
  const releases = Array.from({ length: 3 }, deferred);
  const started = [];
  let active = 0;
  let maximumActive = 0;
  const operations = releases.map((release, index) => limiter.run(async () => {
    started.push(index);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    try {
      await release.promise;
      if (index === 0) throw new Error("Command failed");
      return index;
    } finally {
      active -= 1;
    }
  }));
  const finished = Promise.allSettled(operations);
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(started, [0, 1]);
    releases[0].resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(started, [0, 1, 2]);
    assert.equal(maximumActive, 2);
  } finally {
    releases.forEach(release => release.resolve());
  }
  const results = await finished;
  assert.equal(results[0].status, "rejected");
  assert.equal(results[2].status, "fulfilled");
});

test("repository access allows parallel readers and gives a waiting writer exclusive access", async () => {
  const lock = new ReadWriteLock();
  const readers = deferred();
  const writer = deferred();
  const events = [];
  const operations = [
    lock.read(async () => { events.push("read-one"); await readers.promise; }),
    lock.read(async () => { events.push("read-two"); await readers.promise; }),
    lock.write(async () => { events.push("write"); await writer.promise; }),
    lock.read(async () => { events.push("read-three"); }),
  ];
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, ["read-one", "read-two"]);
    readers.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, ["read-one", "read-two", "write"]);
    writer.resolve();
    await Promise.all(operations);
    assert.deepEqual(events, ["read-one", "read-two", "write", "read-three"]);
    assert.equal(lock.idle, true);
  } finally {
    readers.resolve();
    writer.resolve();
    await Promise.allSettled(operations);
  }
});

test("tag metadata and file commands share the same Git concurrency limit", async context => {
  const client = new GitCliClient("git", 2);
  const releases = Array.from({ length: 3 }, deferred);
  const commands = [];
  let active = 0;
  let maximumActive = 0;
  context.mock.method(client, "executeGit", async args => {
    const index = commands.length;
    commands.push(args[0]);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    try {
      await releases[index].promise;
      return args[0] === "show" ? "manifest" : "";
    } finally {
      active -= 1;
    }
  });
  const operations = [
    client.getFileContent("shared-repository", "package.json", "v1"),
    client.getTags("another-repository"),
    client.getFileContent("shared-repository", "package.json", "v2"),
  ];
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(commands.length, 2);
    releases[0].resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(commands.length, 3);
    assert.equal(maximumActive, 2);
  } finally {
    releases.forEach(release => release.resolve());
    await Promise.allSettled(operations);
  }
});

test("tag synchronization waits for readers of the same clone", async context => {
  const client = new GitCliClient("git", 2);
  const pendingRead = deferred();
  const events = [];
  context.mock.method(client, "executeGit", async () => {
    events.push("read");
    await pendingRead.promise;
    return "manifest";
  });
  context.mock.method(client, "syncRepositoryTags", async (_repoUrl, targetPath) => {
    events.push("sync");
    return targetPath;
  });
  const reading = client.getFileContent("shared-clone", "package.json", "v1");
  const syncing = client.syncTags("https://example.com/root.git", "shared-clone");
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, ["read"]);
    pendingRead.resolve();
    await Promise.all([reading, syncing]);
    assert.deepEqual(events, ["read", "sync"]);
  } finally {
    pendingRead.resolve();
    await Promise.allSettled([reading, syncing]);
  }
});

test("uncached version manifests can be read concurrently from one blobless clone", async context => {
  const { client, repoPath, repoUrl, clonePath } = await createRepository(context);
  await commitVersion(repoPath, "2.0.0");
  await git(repoPath, ["tag", "v2.0.0"]);
  await client.syncTags(repoUrl, clonePath);
  const contents = await Promise.all([
    client.getFileContent(clonePath, "package.json", "v1.0.0"),
    client.getFileContent(clonePath, "package.json", "v2.0.0"),
  ]);
  assert.deepEqual(contents.map(content => JSON.parse(content).version), ["1.0.0", "2.0.0"]);
});

test("initial tag sync packs all tags including tags outside the default branch without a checkout", async context => {
  const { client, repoPath, repoUrl, clonePath } = await createRepository(context);
  await git(repoPath, ["checkout", "-b", "bump/merge"]);
  const releaseCommit = await commitVersion(repoPath, "2.0.0");
  await git(repoPath, ["tag", "v2.0.0"]);
  await git(repoPath, ["checkout", "main"]);

  assert.equal(await client.syncTags(repoUrl, clonePath), clonePath);
  assert.equal(await client.hasClone(repoUrl, clonePath), true);
  const tags = await client.getTags(clonePath);
  assert.deepEqual(tags.map(tag => tag.version).sort(), ["v1.0.0", "v2.0.0"]);
  assert.equal(tags.find(tag => tag.version === "v2.0.0").commitHash, releaseCommit);
  for (const tag of tags) {
    assert.ok(tag.creationDate instanceof Date);
    assert.ok(Number.isFinite(tag.creationDate.getTime()));
  }
  const packedRefs = await readFile(path.join(clonePath, ".git", "packed-refs"), "utf8");
  assert.match(packedRefs, / refs\/tags\/v1\.0\.0$/m);
  assert.match(packedRefs, / refs\/tags\/v2\.0\.0$/m);
  assert.equal(await git(clonePath, ["config", "--get", "remote.origin.partialclonefilter"]), "blob:none");
  assert.equal(
    JSON.parse(await client.getFileContent(clonePath, "package.json", "v2.0.0")).version,
    "2.0.0"
  );
  assert.equal(await client.fileExists(clonePath, "package.json"), false);
  assert.equal(
    await git(clonePath, ["for-each-ref", "--format=%(refname)", "refs/remotes/origin"]),
    "refs/remotes/origin/HEAD\nrefs/remotes/origin/bump/merge\nrefs/remotes/origin/main"
  );
});

test("initial tag sync preserves annotated tag dates and peeled commit hashes", async context => {
  const { client, repoPath, repoUrl, clonePath, initialCommit } = await createRepository(context);
  await git(repoPath, ["tag", "--annotate", "--message", "Release 1", "release-1"]);
  const expectedDate = await git(repoPath, [
    "for-each-ref", "--format=%(creatordate:iso-strict)", "refs/tags/release-1",
  ]);

  await client.syncTags(repoUrl, clonePath);
  const tag = (await client.getTags(clonePath)).find(tag => tag.version === "release-1");
  assert.equal(tag.commitHash, initialCommit);
  assert.equal(tag.creationDate.toISOString(), new Date(expectedDate).toISOString());
  assert.equal(await client.hasRef(clonePath, tag.commitHash), true);
});

test("scans prioritize persisted tagger and committer dates rather than version numbers or author dates", async context => {
  const { client, directory, repoPath, repoUrl } = await createRepository(context);
  await git(repoPath, ["tag", "--delete", "v1.0.0"]);
  const oldCommit = await commitVersion(repoPath, "99.0.0", {
    ...process.env,
    GIT_AUTHOR_DATE: "2026-10-24T08:00:00Z",
    GIT_COMMITTER_DATE: "2026-10-19T08:00:00Z",
  });
  await git(repoPath, ["tag", "v99.0.0"]);
  const recentCommit = await commitVersion(repoPath, "3.0.0", {
    ...process.env,
    GIT_AUTHOR_DATE: "2026-10-18T08:00:00Z",
    GIT_COMMITTER_DATE: "2026-10-21T08:00:00Z",
  });
  await git(repoPath, ["tag", "v3.0.0"]);
  await git(repoPath, [
    "tag", "--annotate", "--message", "Recent release of an older commit", "v0.5.0", oldCommit,
  ], { ...process.env, GIT_COMMITTER_DATE: "2026-10-23T08:00:00Z" });

  const project = new Project("root", "Root", repoUrl);
  const registry = new ProjectRegistry([project]);
  const treeFile = path.join(directory, "trees.json");
  const projectFile = path.join(directory, "projects.json");
  const store = new JsonFileDataStore(treeFile, projectFile);
  await store.saveProject(project);
  const cloneRoot = path.join(directory, "application-cache");
  const locator = new VersionLocatorService(registry, client, store, cloneRoot);
  const attempts = [];
  const scanner = new ScanProjectDependencies(registry, locator, {
    resolve: async (projectId, version) => {
      attempts.push(version);
      return new DependencyTree(new DependencyNode(projectId, projectId, version));
    },
  });

  assert.deepEqual(await scanner.execute(), {
    projectCount: 1, tagCount: 3, resolvedTreeCount: 3, failures: [],
  });
  assert.deepEqual(attempts, ["v0.5.0", "v3.0.0", "v99.0.0"]);

  const reloadedStore = new JsonFileDataStore(treeFile, projectFile);
  const reloadedLocator = new VersionLocatorService(registry, client, reloadedStore, cloneRoot);
  context.mock.method(client, "syncTags", async () => assert.fail("Cached dates must not refresh Git."));
  assert.deepEqual(
    (await reloadedLocator.getCachedVersions(project.id))
      .map(version => [version.version, version.creationDate.toISOString(), version.commitHash]),
    [
      ["v0.5.0", "2026-10-23T08:00:00.000Z", oldCommit],
      ["v3.0.0", "2026-10-21T08:00:00.000Z", recentCommit],
      ["v99.0.0", "2026-10-19T08:00:00.000Z", oldCommit],
    ]
  );
});

test("tag metadata stays local while nested and historical manifests are read on demand", async context => {
  const { client, directory, repoPath, repoUrl, clonePath } = await createRepository(context);
  await commitVersion(repoPath, "2.0.0");
  const nestedContent = `${JSON.stringify({ dependencies: { "@example/core": "19.2.17" } })}\n`;
  await mkdir(path.join(repoPath, "app"));
  await writeFile(path.join(repoPath, "app", "package.json"), nestedContent);
  await git(repoPath, ["add", "--", "app/package.json"]);
  await git(repoPath, ["commit", "-m", "Nested manifest"]);
  await git(repoPath, ["tag", "--annotate", "--message", "Release 2", "release-2"]);
  await client.syncTags(repoUrl, clonePath);

  const objectTypes = new Set((await git(clonePath, [
    "cat-file", "--batch-all-objects", "--batch-check=%(objecttype)",
  ])).split(/\r?\n/));
  assert.deepEqual([...objectTypes].sort(), ["commit", "tag", "tree"]);

  const offlinePath = path.join(directory, "offline");
  await rename(repoPath, offlinePath);
  const tags = await client.getTags(clonePath);
  assert.deepEqual(tags.map(tag => tag.version).sort(), ["release-2", "v1.0.0"]);
  for (const tag of tags) {
    assert.ok(Number.isFinite(tag.creationDate.getTime()));
    assert.equal(await client.hasRef(clonePath, tag.commitHash), true);
  }
  await rename(offlinePath, repoPath);

  assert.equal(await client.fileExists(clonePath, "app/package.json", "release-2"), true);
  assert.equal(await client.getFileContent(clonePath, "app/package.json", "release-2"), nestedContent);
  assert.equal(
    JSON.parse(await client.getFileContent(clonePath, "package.json", "release-2")).version,
    "2.0.0"
  );
  assert.equal(
    JSON.parse(await client.getFileContent(clonePath, "package.json", "v1.0.0")).version,
    "1.0.0"
  );
  assert.equal(await client.fileExists(clonePath, "app/package.json", "v1.0.0"), false);
  assert.equal(await client.fileExists(clonePath, "missing.xml", "release-2"), false);
});

test("tag sync ignores conflicting cached branch refs without replacing the clone", async context => {
  const { client, repoPath, repoUrl, clonePath, initialCommit } = await createRepository(context);
  await git(repoPath, ["clone", "--no-checkout", "--filter=blob:none", repoUrl, clonePath]);
  await git(clonePath, ["update-ref", "refs/remotes/origin/bump", initialCommit]);
  // Keep the cached parent outside the branch refspec so branch pruning cannot remove it.
  const branchRefspec = "+refs/heads/bump/*:refs/remotes/origin/bump/*";
  await git(clonePath, ["config", "remote.origin.fetch", branchRefspec]);
  await writeFile(path.join(clonePath, "cache-note.txt"), "Keep this clone.");
  await git(repoPath, ["branch", "bump/merge"]);
  await git(repoPath, ["tag", "v2.0.0"]);

  assert.equal(await client.syncTags(repoUrl, clonePath), clonePath);
  assert.deepEqual(
    (await client.getTags(clonePath)).map(tag => tag.version).sort(),
    ["v1.0.0", "v2.0.0"]
  );
  assert.equal(await git(clonePath, ["rev-parse", "refs/remotes/origin/bump"]), initialCommit);
  assert.equal(await git(clonePath, ["config", "--get", "remote.origin.fetch"]), branchRefspec);
  assert.equal(await git(clonePath, ["config", "--get", "remote.origin.partialclonefilter"]), "blob:none");
  assert.equal(await readFile(path.join(clonePath, "cache-note.txt"), "utf8"), "Keep this clone.");
});

test("tag sync updates moved tags, peels annotated tags and prunes deleted tags", async context => {
  const { client, repoPath, repoUrl, clonePath } = await createRepository(context);
  await git(repoPath, ["tag", "obsolete"]);
  await client.syncTags(repoUrl, clonePath);
  const releaseCommit = await commitVersion(repoPath, "2.0.0");
  await git(repoPath, ["tag", "--force", "v1.0.0"]);
  await git(repoPath, ["tag", "--annotate", "--message", "Release 2", "v2.0.0"]);
  await git(repoPath, ["tag", "--delete", "obsolete"]);

  await client.syncTags(repoUrl, clonePath);
  const tags = await client.getTags(clonePath);
  assert.deepEqual(tags.map(tag => tag.version).sort(), ["v1.0.0", "v2.0.0"]);
  for (const tag of tags) {
    assert.equal(tag.commitHash, releaseCommit);
  }
  assert.equal(
    JSON.parse(await client.getFileContent(clonePath, "package.json", "v1.0.0")).version,
    "2.0.0"
  );

  await git(repoPath, ["tag", "--delete", "v1.0.0", "v2.0.0"]);
  await client.syncTags(repoUrl, clonePath);
  assert.deepEqual(await client.getTags(clonePath), []);
});

test("failed tag refreshes reject, retain cached tags and allow a later retry", async context => {
  const { client, directory, repoPath, repoUrl, clonePath, initialCommit } = await createRepository(context);
  await client.syncTags(repoUrl, clonePath);
  const offlinePath = path.join(directory, "offline");
  await rename(repoPath, offlinePath);

  await assert.rejects(client.syncTags(repoUrl, clonePath), /Git command failed: git fetch/);
  assert.equal(await client.hasClone(repoUrl, clonePath), true);
  const tags = await client.getTags(clonePath);
  assert.deepEqual(tags.map(tag => tag.version), ["v1.0.0"]);
  assert.equal(tags[0].commitHash, initialCommit);

  await rename(offlinePath, repoPath);
  await git(repoPath, ["tag", "v2.0.0"]);
  await client.syncTags(repoUrl, clonePath);
  assert.deepEqual(
    (await client.getTags(clonePath)).map(tag => tag.version).sort(),
    ["v1.0.0", "v2.0.0"]
  );
});

test("concurrent tag sync calls serialize initial clone creation and refreshes", async context => {
  const { client, repoUrl, clonePath } = await createRepository(context);
  assert.deepEqual(
    await Promise.all([
      client.syncTags(repoUrl, clonePath),
      client.syncTags(repoUrl, clonePath),
      client.syncTags(repoUrl, clonePath),
    ]),
    [clonePath, clonePath, clonePath]
  );
  assert.deepEqual((await client.getTags(clonePath)).map(tag => tag.version), ["v1.0.0"]);
});

test("selective catalogs fetch off-branch matches shallowly and preserve exact native metadata", async context => {
  const { client, repoPath, repoUrl, clonePath } = await createRepository(context);
  await git(repoPath, ["tag", "ignored-pr"]);
  await git(repoPath, ["checkout", "-b", "side"]);
  const commit = await commitVersion(repoPath, "2.0.0");
  await git(repoPath, ["tag", "--annotate", "--message", "Second release", "v2.0.0"]);
  await git(repoPath, ["branch", "refs/tags/vfake"]);
  await git(repoPath, ["checkout", "main"]);
  const expected = (await client.getTags(repoPath)).filter(tag => /^v/.test(tag.version));

  await client.syncTags(repoUrl, clonePath, "v");
  assert.deepEqual(
    (await client.getTags(clonePath)).sort((a, b) => a.version.localeCompare(b.version)),
    expected.sort((a, b) => a.version.localeCompare(b.version))
  );
  assert.equal(await git(clonePath, ["rev-parse", "--is-shallow-repository"]), "true");
  assert.equal(await git(clonePath, ["config", "--get", "extensions.refStorage"]), "reftable");
  assert.equal(await git(clonePath, ["config", "--get", "extensions.partialClone"]), "origin");
  assert.equal((await git(clonePath, ["config", "--get-regexp", "^remote\\..*\\.promisor$"]))
    .split(/\r?\n/).length, 1);
  assert.equal(await git(clonePath, ["rev-parse", "v2.0.0^{commit}"]), commit);
  assert.equal(JSON.parse(await client.getFileContent(clonePath, "package.json", commit)).version, "2.0.0");
  assert.equal((await git(clonePath, ["cat-file", "--batch-all-objects", "--batch-check=%(objecttype)"]))
    .split(/\r?\n/).filter(type => type === "commit").length, 2);
});

test("selective refreshes handle moves, deletions, unchanged refs and pattern changes", async context => {
  const { client, repoPath, repoUrl, clonePath } = await createRepository(context);
  await git(repoPath, ["tag", "other"]);
  await client.syncTags(repoUrl, clonePath, "^v");
  await client.syncTags(repoUrl, clonePath, "^v");
  const movedCommit = await commitVersion(repoPath, "2.0.0");
  await git(repoPath, ["tag", "--force", "v1.0.0"]);
  await git(repoPath, ["tag", "--annotate", "--message", "Second release", "v2.0.0"]);
  await client.syncTags(repoUrl, clonePath, "^v");
  assert.ok((await client.getTags(clonePath)).every(tag => tag.commitHash === movedCommit));
  await client.syncTags(repoUrl, clonePath, "^v2");
  assert.deepEqual((await client.getTags(clonePath)).map(tag => tag.version), ["v2.0.0"]);
  await client.syncTags(repoUrl, clonePath, "^v");
  assert.deepEqual((await client.getTags(clonePath)).map(tag => tag.version).sort(), ["v1.0.0", "v2.0.0"]);
  await git(repoPath, ["tag", "--delete", "v1.0.0", "v2.0.0"]);
  await client.syncTags(repoUrl, clonePath, "^v");
  assert.deepEqual(await client.getTags(clonePath), []);
});

test("a failed selective refresh retains catalog refs and a later refresh succeeds", async context => {
  const { client, directory, repoPath, repoUrl, clonePath } = await createRepository(context);
  await git(repoPath, ["tag", "ignored"]);
  await client.syncTags(repoUrl, clonePath, "^v");
  const before = await client.getTags(clonePath);
  const offline = path.join(directory, "offline");
  await rename(repoPath, offline);
  await assert.rejects(client.syncTags(repoUrl, clonePath, "^v"), /Git command failed/);
  assert.deepEqual(await client.getTags(clonePath), before);
  await rename(offline, repoPath);
  await git(repoPath, ["tag", "v2.0.0"]);
  await client.syncTags(repoUrl, clonePath, "^v");
  assert.equal((await client.getTags(clonePath)).length, 2);
});

test("an existing full clone retains full-tag compatibility when a pattern is provided", async context => {
  const { repoPath, repoUrl, clonePath } = await createRepository(context);
  await git(repoPath, ["tag", "ignored"]);
  const client = new GitCliClient();
  await client.syncTags(repoUrl, clonePath);
  await client.syncTags(repoUrl, clonePath, "^v");
  assert.deepEqual((await client.getTags(clonePath)).map(tag => tag.version).sort(), ["ignored", "v1.0.0"]);
  assert.equal(await git(clonePath, ["rev-parse", "--is-shallow-repository"]), "false");
});

test("unsupported optimized storage falls back to the original packed catalog", async context => {
  const { client, repoPath, repoUrl, clonePath } = await createRepository(context);
  await git(repoPath, ["tag", "ignored"]);
  context.mock.method(client, "supportsReftable", async () => false);
  await client.syncTags(repoUrl, clonePath, "^v");
  assert.deepEqual((await client.getTags(clonePath)).map(tag => tag.version).sort(), ["ignored", "v1.0.0"]);
  assert.equal(await git(clonePath, ["rev-parse", "--is-shallow-repository"]), "false");
});

test("relative local repository paths are resolved before partial-cache origin setup", async context => {
  const { client, repoPath, clonePath } = await createRepository(context);
  await git(repoPath, ["tag", "ignored"]);
  const relative = path.relative(process.cwd(), repoPath);
  await client.syncTags(relative, clonePath, "^v");
  assert.equal(await client.hasClone(relative, clonePath), true);
  assert.equal(JSON.parse(await client.getFileContent(clonePath, "package.json", "v1.0.0")).version, "1.0.0");
  const packed = path.join(path.dirname(clonePath), "packed-cache");
  await client.syncTags(relative, packed);
  assert.equal(await client.hasClone(relative, packed), true);
  await assert.rejects(client.syncTags("", path.join(path.dirname(clonePath), "invalid")),
    /Repository URL is required/);
});

test("version lookup persists and reuses the complete selected tag catalog", async context => {
  const { client, repoPath, repoUrl, directory } = await createRepository(context);
  await git(repoPath, ["tag", "ignored-pr"]);
  const project = new Project("root", "Root", repoUrl, null, null, "^v");
  const store = new JsonFileDataStore(
    path.join(directory, "trees.json"), path.join(directory, "projects.json")
  );
  await store.saveProject(project);
  const registry = new ProjectRegistry([project]);
  const cloneRoot = path.join(directory, "application-cache");
  const locator = new VersionLocatorService(registry, client, store, cloneRoot);
  const versions = await locator.getAvailableVersions(project.id);
  assert.deepEqual(versions.map(version => version.version), ["v1.0.0"]);
  assert.equal(await client.hasClone(repoUrl, path.join(cloneRoot, project.id)), true);
  context.mock.method(client, "syncTags", async () => assert.fail("Cached versions must not refresh Git."));
  assert.deepEqual(await locator.getCachedVersions(project.id), versions);
});

test("background discovery fetches all matching nested dependency tags beyond 200 without building their trees", async context => {
  const { client, repoPath, repoUrl, directory, initialCommit } = await createRepository(context);
  const tags = Array.from({ length: 205 }, (_, index) => `release-1.0.${index}`);
  const update = execFile("git", ["update-ref", "--stdin"], { cwd: repoPath, windowsHide: true });
  update.child.stdin.end(tags.map(tag => `update refs/tags/${tag} ${initialCommit}\n`).join(""));
  await update;
  await git(repoPath, ["tag", "ignored-pr"]);
  await git(repoPath, ["tag", "root-1"]);
  const leaf = new Project("leaf", "Leaf", repoUrl, null, null, "^release-\\d+\\.\\d+\\.\\d+$");
  const middle = new Project("middle", "Middle", repoUrl, null, [
    new ProjectDependency(leaf, "package.json", "leaf"),
  ], "^middle-");
  const root = new Project("root", "Root", repoUrl, null, [
    new ProjectDependency(middle, "package.json", "middle"),
  ], "^root-\\d+$");
  const store = new JsonFileDataStore(path.join(directory, "trees.json"), path.join(directory, "projects.json"));
  await store.saveProject(root);
  const registry = new ProjectRegistry([root]);
  const locator = new VersionLocatorService(registry, client, store, path.join(directory, "application-cache"));
  const built = [];
  const scanner = new ScanProjectDependencies(registry, locator, {
    resolve: async (projectId, version) => {
      built.push(projectId);
      return new DependencyTree(new DependencyNode(projectId, projectId, version));
    },
  }, 2);

  assert.deepEqual(await scanner.execute(), {
    projectCount: 3, tagCount: 206, resolvedTreeCount: 1, failures: [],
  });
  assert.deepEqual((await locator.getCachedVersions("leaf")).map(tag => tag.version).sort(), [...tags].sort());
  assert.deepEqual(await store.getAvailableVersions("leaf"), []);
  assert.deepEqual(built, ["root"]);
  assert.ok((await locator.getCachedVersions("leaf")).every(tag => !tag.hasDependencyTree));

  const inspected = [];
  const search = new FindRootVersion(registry, new GetDependencyVersion(locator, true), {
    resolve: async (projectId, version) => {
      inspected.push(version);
      return new DependencyTree(new DependencyNode(projectId, "Root", version, [
        new DependencyNode("middle", "Middle", "1.0.0", [
          new DependencyNode("leaf", "Leaf", "release-1.0.204"),
        ]),
      ]));
    },
  }, { debug() {}, info() {}, warn() {}, error() {} });
  const selectedTag = tags[203];
  const result = await search.execute("root", "leaf", selectedTag);
  assert.equal(result.match.version, "root-1");
  assert.equal(result.minimumVersion, selectedTag);
  assert.equal(result.match.dependencyVersion, "release-1.0.204");
  assert.deepEqual(await store.getAvailableVersions("leaf"), []);

  await git(repoPath, ["tag", "-d", selectedTag]);
  await git(repoPath, ["tag", "release-1.0.205"]);
  const refreshed = await scanner.refreshTags();
  assert.equal(refreshed.failures.length, 0);
  assert.equal(refreshed.tagCount, 206);
  const catalog = await locator.getCachedVersions("leaf");
  assert.equal(catalog.length, 206);
  assert.equal(catalog.filter(tag => !tag.removed).length, 205);
  assert.equal(catalog.find(tag => tag.version === selectedTag).removed, true);
  assert.equal(catalog.find(tag => tag.version === "release-1.0.205").removed, false);
  assert.ok(catalog.every(tag => new RegExp(leaf.tagPattern).test(tag.version)));
  assert.deepEqual(built, ["root"]);
  await assert.rejects(search.execute("root", "leaf", selectedTag), VersionSearchInputError);
  assert.deepEqual(inspected, ["root-1"]);
});

test("a full sync expands a selective catalog for the unchanged resolver's history and branch refs", async context => {
  const { client, repoPath, repoUrl, clonePath } = await createRepository(context);
  const commit = await commitVersion(repoPath, "2.0.0");
  await git(repoPath, ["tag", "v2.0.0"]);
  await git(repoPath, ["tag", "ignored-pr"]);
  await git(repoPath, ["branch", "side"]);
  await client.syncTags(repoUrl, clonePath, "^v");
  assert.equal(await git(clonePath, ["rev-parse", "--is-shallow-repository"]), "true");
  await client.syncTags(repoUrl, clonePath);
  assert.equal(await git(clonePath, ["rev-parse", "--is-shallow-repository"]), "false");
  assert.equal(await client.hasRef(clonePath, "v2.0.0~1"), true);
  assert.equal(await client.hasRef(clonePath, "origin/side"), true);
  assert.equal(await git(clonePath, ["rev-parse", "HEAD"]), commit);
  assert.equal(await client.hasRef(clonePath, "HEAD@{upstream}"), true);
  assert.deepEqual((await client.getTags(clonePath)).map(tag => tag.version).sort(),
    ["ignored-pr", "v1.0.0", "v2.0.0"]);
});
