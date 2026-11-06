const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { promisify } = require("node:util");

const { DependencyTreeDTO } = require("../dist/application/dto/DependencyTreeDTO");
const { DependencyResolverService } = require("../dist/application/services/DependencyResolverService");
const { ScanProjectDependencies } = require("../dist/application/use-cases/ScanProjectDependencies");
const { buildNpmRangeResolutionTtl } = require("../dist/config/app.config");
const { Project } = require("../dist/domain/models/Project");
const { ProjectDependency } = require("../dist/domain/models/ProjectDependency");
const { Version } = require("../dist/domain/models/Version");
const { MavenPackageParser } = require("../dist/infrastructure/parsers/maven/MavenPackageParser");
const { GitCliClient } = require("../dist/infrastructure/git/GitCliClient");
const { NpmPackageParser } = require("../dist/infrastructure/parsers/npm/NpmPackageParser");
const { ProjectRegistry } = require("../dist/infrastructure/registry/ProjectRegistry");
const { JsonFileDataStore } = require("../dist/infrastructure/storage/JsonFileDataStore");

const parser = new NpmPackageParser();
const versions = ["v2.3.0", "v2.3.7", "v2.4.1", "v2.9.0", "v3.0.0", "v3.1.0-beta.1", "release-9.0.0"];
const initialTime = Date.UTC(2026, 10, 4);

for (const [declaration, expected] of [
  ["^2.3.0", "v2.9.0"],
  ["~2.3.0", "v2.3.7"],
  ["2", "v2.9.0"],
  ["2.x", "v2.9.0"],
  ["2.*", "v2.9.0"],
  ["2.3", "v2.3.7"],
  ["2.3.x", "v2.3.7"],
  ["*", "v3.0.0"],
  ["", "v3.0.0"],
  [">=2.3.0 <2.9.0", "v2.4.1"],
  [">2.3.0 <=2.4.1", "v2.4.1"],
  ["2.3.0 - 2.4.1", "v2.4.1"],
  ["~2.3.0 || ^3.0.0", "v3.0.0"],
  ["=2.3.0", "v2.3.0"],
  ["^9.0.0", null],
]) {
  test(`npm resolves ${JSON.stringify(declaration)} with standard SemVer rules`, async () => {
    assert.deepEqual(await parser.resolveVersion(declaration, async () => versions), {
      resolvedVersion: expected,
    });
  });
}

test("npm handles zero-major and prerelease ranges without including unrelated prereleases", async () => {
  const candidates = [
    "v0.0.3", "v0.0.4", "v0.2.3", "v0.2.9", "v0.3.0",
    "v2.3.8-beta.1", "v2.3.8-beta.2", "v2.4.0-beta.1",
  ];
  for (const [declaration, expected] of [
    ["^0.0.3", "v0.0.3"],
    ["^0.2.3", "v0.2.9"],
    ["~0.2.3", "v0.2.9"],
    [">=2.3.8-beta.1 <2.3.8", "v2.3.8-beta.2"],
  ]) {
    assert.equal((await parser.resolveVersion(declaration, async () => candidates)).resolvedVersion, expected);
  }
});

test("exact and non-SemVer declarations do not discover or normalize Git tags", async () => {
  for (const declaration of [
    "2.3.0", "v2.3.0", "2.3.0-beta.1", "latest", "next", "workspace:*",
    "file:../local", "npm:other@^2.3.0", "git+https://example.com/other.git#main", "^invalid",
  ]) {
    assert.equal(await parser.resolveVersion(declaration, () => assert.fail(declaration)), null);
  }
  assert.equal(new MavenPackageParser().resolveVersion, undefined);
});

test("equivalent tag versions are selected deterministically without mutating their catalog", async () => {
  const candidates = ["v2.3.7", "2.3.7"];
  assert.equal((await parser.resolveVersion("~2.3.0", async () => candidates)).resolvedVersion, "2.3.7");
  assert.deepEqual(candidates, ["v2.3.7", "2.3.7"]);
  const failure = new Error("Tag discovery failed.");
  await assert.rejects(parser.resolveVersion("^2.3.0", async () => { throw failure; }), failure);
});

test("range TTL defaults to one day and requires a positive integer number of minutes", () => {
  assert.equal(buildNpmRangeResolutionTtl({}), 86_400_000);
  assert.equal(buildNpmRangeResolutionTtl({ NPM_RANGE_RESOLUTION_TTL_MINUTES: " " }), 86_400_000);
  assert.equal(buildNpmRangeResolutionTtl({ NPM_RANGE_RESOLUTION_TTL_MINUTES: " 15 " }), 900_000);
  for (const value of ["0", "-1", "1.5", "invalid", "Infinity", String(Number.MAX_SAFE_INTEGER)]) {
    assert.throws(() => buildNpmRangeResolutionTtl({ NPM_RANGE_RESOLUTION_TTL_MINUTES: value }),
      /NPM_RANGE_RESOLUTION_TTL_MINUTES/);
  }
});

async function createScenario(context, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "npm-range-resolution-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const treePath = path.join(directory, "trees.json");
  const projectPath = path.join(directory, "projects.json");
  const ttlMs = options.ttlMs ?? 60_000;
  const store = new JsonFileDataStore(treePath, projectPath, undefined, ttlMs);
  const grandchild = new Project("grandchild", "Grandchild", "https://example.com/grandchild.git");
  const child = new Project("child", "Child", "https://example.com/child.git", null, [
    new ProjectDependency(grandchild, "package.json", "grandchild"),
  ], options.tagPattern ?? null);
  const sibling = new Project("sibling", "Sibling", "https://example.com/sibling.git");
  const manifestPath = options.maven ? "pom.xml" : "package.json";
  const root = new Project("root", "Root", "https://example.com/root.git", null, [
    new ProjectDependency(child, manifestPath, options.maven ? "example:child" : "child"),
    new ProjectDependency(sibling, manifestPath, options.maven ? "example:sibling" : "sibling"),
  ]);
  const registry = new ProjectRegistry([root]);
  const state = {
    declaration: options.declaration ?? "^2.3.0",
    catalogs: {
      root: ["1.0.0"], child: ["2.3.0", "v2.3.7", "v2.4.1"],
      grandchild: ["7.0.0", "v7.0.2", "7.1.0"], sibling: ["1.1.0"],
    },
    fetches: [],
    tagReads: [],
    manifestReads: [],
    warnings: [],
  };
  const gitClient = {
    hasClone: async () => true,
    hasRef: async (repoPath, ref) => ref === "root-commit" ||
      state.catalogs[path.basename(repoPath)].includes(ref),
    syncTags: async (repoUrl, targetPath) => {
      state.fetches.push(path.basename(targetPath));
      if (state.refreshError) throw state.refreshError;
      return targetPath;
    },
    getTags: async repoPath => {
      const id = path.basename(repoPath);
      state.tagReads.push(id);
      return state.catalogs[id].map(name => new Version(name, null, `commit-${name}`));
    },
    fileExists: async () => true,
    getFileContent: async (repoPath, filePath, ref) => {
      const id = path.basename(repoPath);
      state.manifestReads.push({ id, filePath, ref });
      if (id === "root") {
        assert.equal(ref, "root-commit");
        return options.maven
          ? `<project><dependencies><dependency><groupId>example</groupId><artifactId>child</artifactId>
            <version>${state.declaration}</version></dependency><dependency><groupId>example</groupId>
            <artifactId>sibling</artifactId><version>1.1.0</version></dependency></dependencies></project>`
          : JSON.stringify({ dependencies: { child: state.declaration, sibling: "1.1.0" } });
      }
      assert.equal(id, "child");
      assert.ok(state.catalogs.child.includes(ref), `Expected a concrete child tag, received ${ref}`);
      return JSON.stringify({ dependencies: {
        grandchild: options.nestedRange ?? (ref === "v2.8.0" ? "7.1.0" : "7.0.0"),
      } });
    },
  };
  const createResolver = dataStore => new DependencyResolverService(
    registry, gitClient, [parser, new MavenPackageParser()], directory, dataStore, 2,
    { warn: (details, message) => state.warnings.push({ details, message }) }
  );
  await store.saveProject(root);
  await store.syncProjectTags("root", [new Version("1.0.0", null, "root-commit")]);
  return {
    store, root, registry, state, treePath, projectPath, ttlMs, createResolver,
    resolver: createResolver(store),
  };
}

test("builds the selected subtree and persists declared/resolved values without changing display versions", async context => {
  const { resolver, state, treePath } = await createScenario(context);
  const tree = await resolver.resolve("root", "1.0.0");
  const child = tree.root.dependencies[0];
  assert.equal(child.version, "v2.4.1");
  assert.equal(child.declaredVersion, "^2.3.0");
  assert.equal(child.resolvedVersion, "v2.4.1");
  assert.ok(child.resolutionCheckedAt instanceof Date);
  assert.equal(child.dependencies[0].version, "7.0.0");
  assert.equal(tree.root.dependencies[1].version, "1.1.0");
  assert.deepEqual(state.tagReads, ["child"]);
  assert.ok(state.manifestReads.some(read => read.id === "child" && read.ref === "v2.4.1"));
  const snapshot = JSON.parse(await readFile(treePath, "utf8")).projects.root.versions["1.0.0"][0];
  assert.equal(snapshot.root.dependencies[0].declaredVersion, "^2.3.0");
  assert.equal(snapshot.root.dependencies[0].resolvedVersion, "v2.4.1");
  assert.equal(snapshot.root.dependencies[0].resolutionCheckedAt, child.resolutionCheckedAt.toISOString());
  const dto = DependencyTreeDTO.fromDomain("root", "1.0.0", tree);
  assert.equal(dto.tree.dependencies[0].version, "v2.4.1");
  assert.equal(dto.tree.dependencies[0].declaredVersion, "^2.3.0");
  assert.equal(dto.tree.dependencies[0].resolvedVersion, "v2.4.1");
  assert.equal(dto.tree.dependencies[1].version, "1.1.0");
  assert.equal(dto.tree.dependencies[1].resolvedVersion, undefined);
});

test("respects the configured tag pattern rather than choosing an excluded compatible tag", async context => {
  const { resolver } = await createScenario(context, { tagPattern: "^v?2\\.3\\." });
  const tree = await resolver.resolve("root", "1.0.0");
  assert.equal(tree.root.dependencies[0].version, "v2.3.7");
});

test("JSON range TTL survives reload and recomputes at the exact expiry boundary", async context => {
  context.mock.timers.enable({ apis: ["Date"], now: initialTime });
  const scenario = await createScenario(context);
  const { resolver, state, treePath, projectPath, ttlMs, createResolver } = scenario;
  await resolver.resolve("root", "1.0.0");
  const reads = state.manifestReads.length;
  state.catalogs.child.push("v2.8.0");
  const reloaded = new JsonFileDataStore(treePath, projectPath, undefined, ttlMs);
  context.mock.timers.setTime(initialTime + ttlMs - 1);
  assert.equal((await createResolver(reloaded).resolve("root", "1.0.0")).root.dependencies[0].version, "v2.4.1");
  assert.equal(state.manifestReads.length, reads);
  assert.deepEqual(state.fetches, ["child"]);
  context.mock.timers.setTime(initialTime + ttlMs);
  assert.equal(await reloaded.getDependencyTree("root", "1.0.0"), null);
  assert.equal(await reloaded.hasDependencyTree("root", "1.0.0"), false);
  assert.deepEqual(await reloaded.getAvailableVersions("root"), []);
  const refreshed = await createResolver(reloaded).resolve("root", "1.0.0");
  assert.equal(refreshed.root.dependencies[0].version, "v2.8.0");
  assert.equal(refreshed.root.dependencies[0].declaredVersion, "^2.3.0");
  assert.equal(refreshed.root.dependencies[0].dependencies[0].version, "7.1.0");
  assert.equal(refreshed.root.dependencies[0].resolutionCheckedAt.getTime(), initialTime + ttlMs);
  assert.deepEqual(state.fetches, ["child", "child"]);
});

test("range expiry works below an exact dependency while exact-only trees never expire", async context => {
  context.mock.timers.enable({ apis: ["Date"], now: initialTime });
  const nested = await createScenario(context, { declaration: "2.3.0", nestedRange: "~7.0.0" });
  const tree = await nested.resolver.resolve("root", "1.0.0");
  assert.equal(tree.root.dependencies[0].version, "2.3.0");
  assert.equal(tree.root.dependencies[0].dependencies[0].version, "v7.0.2");
  assert.deepEqual(nested.state.tagReads, ["grandchild"]);
  const exact = await createScenario(context, { declaration: "2.3.0" });
  await exact.resolver.resolve("root", "1.0.0");
  context.mock.timers.setTime(initialTime + nested.ttlMs);
  assert.equal(await nested.store.hasDependencyTree("root", "1.0.0"), false);
  assert.equal(await exact.store.hasDependencyTree("root", "1.0.0"), true);
  const cached = await exact.resolver.resolve("root", "1.0.0");
  assert.equal(cached.root.dependencies[0].declaredVersion, "2.3.0");
  assert.equal(cached.root.dependencies[0].resolvedVersion, null);
  assert.equal(cached.root.dependencies[0].resolutionCheckedAt, null);
  assert.deepEqual(exact.state.tagReads, []);
});

test("unmatched ranges remain explicitly unresolved, retain siblings, and retry after TTL", async context => {
  context.mock.timers.enable({ apis: ["Date"], now: initialTime });
  const { resolver, state, ttlMs } = await createScenario(context, { declaration: "^9.0.0" });
  const tree = await resolver.resolve("root", "1.0.0");
  const child = tree.root.dependencies[0];
  assert.equal(child.version, "^9.0.0");
  assert.equal(child.declaredVersion, "^9.0.0");
  assert.equal(child.resolvedVersion, null);
  assert.equal(child.dependenciesResolved, false);
  assert.equal(child.dependencies[0].version, "unknown");
  assert.equal(tree.root.dependencies[1].version, "1.1.0");
  assert.match(state.warnings[0].message, /No available dependency tag/);
  state.catalogs.child.push("v9.0.0");
  await resolver.resolve("root", "1.0.0");
  assert.equal(state.warnings.length, 1);
  context.mock.timers.setTime(initialTime + ttlMs);
  assert.equal((await resolver.resolve("root", "1.0.0")).root.dependencies[0].version, "v9.0.0");
});

test("tag discovery failures propagate instead of saving a success-shaped fallback", async context => {
  const { resolver, store, state } = await createScenario(context);
  state.refreshError = new Error("Remote unavailable");
  await assert.rejects(resolver.resolve("root", "1.0.0"), state.refreshError);
  assert.equal(await store.hasDependencyTree("root", "1.0.0"), false);
  assert.deepEqual(state.warnings, []);
});

test("recovering an unrelated partial branch keeps still-fresh range selections", async context => {
  context.mock.timers.enable({ apis: ["Date"], now: initialTime });
  const { resolver, state } = await createScenario(context);
  state.catalogs.sibling = [];
  const partial = await resolver.resolve("root", "1.0.0");
  assert.equal(partial.root.dependencies[1].dependenciesResolved, false);
  state.catalogs.child.push("v2.8.0");
  state.catalogs.sibling = ["1.1.0"];
  context.mock.timers.setTime(initialTime + 1_000);
  const recovered = await resolver.resolve("root", "1.0.0");
  assert.equal(recovered.root.dependencies[1].dependenciesResolved, true);
  assert.equal(recovered.root.dependencies[0].version, "v2.4.1");
  assert.equal(recovered.root.dependencies[0].resolutionCheckedAt.getTime(), initialTime);
  assert.deepEqual(state.tagReads, ["child"]);
});

test("a failed refresh after TTL expiry does not serve the old inferred tree", async context => {
  context.mock.timers.enable({ apis: ["Date"], now: initialTime });
  const { resolver, store, state, ttlMs } = await createScenario(context);
  await resolver.resolve("root", "1.0.0");
  context.mock.timers.setTime(initialTime + ttlMs);
  state.refreshError = new Error("Cannot refresh expired resolution");
  await assert.rejects(resolver.resolve("root", "1.0.0"), state.refreshError);
  assert.equal(await store.getDependencyTree("root", "1.0.0"), null);
});

test("Maven declarations are not interpreted using npm range rules", async context => {
  const { resolver, state } = await createScenario(context, { maven: true });
  const tree = await resolver.resolve("root", "1.0.0");
  assert.equal(tree.root.dependencies[0].version, "^2.3.0");
  assert.equal(tree.root.dependencies[0].dependenciesResolved, false);
  assert.equal(tree.root.dependencies[0].resolutionCheckedAt, null);
  assert.deepEqual(state.tagReads, []);
});

test("removed root snapshots remain historical even after their range resolution TTL expires", async context => {
  context.mock.timers.enable({ apis: ["Date"], now: initialTime });
  const { resolver, store, state, ttlMs } = await createScenario(context);
  const original = await resolver.resolve("root", "1.0.0");
  await store.syncProjectTags("root", []);
  context.mock.timers.setTime(initialTime + ttlMs);
  assert.deepEqual(await resolver.resolve("root", "1.0.0"), original);
  assert.deepEqual(await store.getAvailableVersions("root"), ["1.0.0"]);
  assert.deepEqual(state.fetches, ["child"]);
});

test("background scans requeue expired range trees without restarting or rebuilding fresh trees", async context => {
  context.mock.timers.enable({ apis: ["Date"], now: initialTime });
  const { resolver, registry, state, store, ttlMs } = await createScenario(context);
  const locator = {
    getAvailableVersions: async id => Promise.all(state.catalogs[id].map(async name =>
      new Version(name, null, id === "root" ? "root-commit" : `commit-${name}`, false,
        id === "root" && await store.hasDependencyTree(id, name))
    )),
  };
  const scan = new ScanProjectDependencies(registry, locator, resolver, 2, ttlMs);
  assert.equal((await scan.execute()).resolvedTreeCount, 1);
  state.catalogs.child.push("v2.8.0");
  context.mock.timers.setTime(initialTime + ttlMs - 1);
  assert.equal((await scan.execute()).resolvedTreeCount, 0);
  context.mock.timers.setTime(initialTime + ttlMs);
  assert.equal((await scan.execute()).resolvedTreeCount, 1);
  assert.equal((await store.getDependencyTree("root", "1.0.0")).root.dependencies[0].version, "v2.8.0");
  assert.equal((await scan.execute()).resolvedTreeCount, 0);
});

test("real Git repositories resolve and refresh a concrete tagged subtree after TTL expiry", async context => {
  context.mock.timers.enable({ apis: ["Date"], now: initialTime });
  const directory = await mkdtemp(path.join(os.tmpdir(), "npm-range-real-git-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const execute = promisify(execFile);
  const git = (repoPath, ...args) => execute("git", ["-C", repoPath, ...args]);
  const repositories = {};
  for (const id of ["root", "child", "grandchild"]) {
    const repoPath = path.join(directory, `source-${id}`);
    await mkdir(repoPath);
    await git(repoPath, "init", "--quiet", "--initial-branch=main");
    repositories[id] = repoPath;
  }
  const release = async (id, tag, dependencies) => {
    const repoPath = repositories[id];
    await writeFile(path.join(repoPath, "package.json"), JSON.stringify({ name: id, dependencies }));
    await git(repoPath, "add", "package.json");
    await git(repoPath, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", tag);
    await git(repoPath, "tag", tag);
  };
  await release("grandchild", "7.0.0", {});
  await release("grandchild", "7.1.0", {});
  await release("child", "v2.3.0", { grandchild: "7.0.0" });
  await release("child", "v2.4.0", { grandchild: "7.1.0" });
  await release("child", "v3.0.0", { grandchild: "7.0.0" });
  await release("root", "1.0.0", { child: "^2.3.0" });
  const grandchild = new Project("grandchild", "Grandchild", repositories.grandchild);
  const child = new Project("child", "Child", repositories.child, null, [
    new ProjectDependency(grandchild, "package.json", "grandchild"),
  ], "^v2\\.");
  const root = new Project("root", "Root", repositories.root, null, [
    new ProjectDependency(child, "package.json", "child"),
  ]);
  const ttlMs = 60_000;
  const store = new JsonFileDataStore(
    path.join(directory, "trees.json"), path.join(directory, "projects.json"), undefined, ttlMs
  );
  await store.saveProject(root);
  const resolver = new DependencyResolverService(
    new ProjectRegistry([root]), new GitCliClient("git", 2), [parser],
    path.join(directory, "clones"), store
  );
  const first = await resolver.resolve("root", "1.0.0");
  assert.equal(first.root.dependencies[0].version, "v2.4.0");
  assert.equal(first.root.dependencies[0].dependencies[0].version, "7.1.0");
  await release("child", "v2.5.0", { grandchild: "7.0.0" });
  assert.equal((await resolver.resolve("root", "1.0.0")).root.dependencies[0].version, "v2.4.0");
  context.mock.timers.setTime(initialTime + ttlMs);
  const refreshed = await resolver.resolve("root", "1.0.0");
  assert.equal(refreshed.root.dependencies[0].declaredVersion, "^2.3.0");
  assert.equal(refreshed.root.dependencies[0].resolvedVersion, "v2.5.0");
  assert.equal(refreshed.root.dependencies[0].dependencies[0].version, "7.0.0");
});
