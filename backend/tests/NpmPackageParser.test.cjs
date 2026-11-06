const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { NpmPackageParser } = require("../dist/infrastructure/parsers/npm/NpmPackageParser");
const { DependencyResolverService } = require("../dist/application/services/DependencyResolverService");
const { JsonFileDataStore } = require("../dist/infrastructure/storage/JsonFileDataStore");
const { Project } = require("../dist/domain/models/Project");
const { ProjectDependency } = require("../dist/domain/models/ProjectDependency");

const parser = new NpmPackageParser();
const sampleDependencies = {
  "@other/core": "22.2.1",
  "@example-addon/model": "3.1.0",
  "@example/parser": "2.0.15",
  "@example/adapter": "5.2.40",
  "@example/core-utils": "3.0.6",
  "@example/core": "19.2.3",
  "@example/feature": "19.2.3",
  "@example/feature-utils": "3.0.6",
  "utility": "^7.8.2",
};

function createResolver(references, cloneRoot, dataStore) {
  const project = new Project("root", "Root", "https://example.com/root.git", null,
    references.map((reference, index) => new ProjectDependency(
      new Project(`child-${index}`, `Dependency ${index}`, `https://example.com/dependency-${index}.git`, null, null),
      "apps/web/package.json",
      reference
    ))
  );
  const state = { manifestReads: 0 };
  const gitClient = {
    hasClone: async () => true,
    hasRef: async () => true,
    syncTags: async () => assert.fail("Existing clones and tags should be reused."),
    fileExists: async () => true,
    getFileContent: async (repoPath, filePath, ref) => {
      assert.equal(repoPath, path.join(cloneRoot, "root"));
      assert.equal(filePath, "apps/web/package.json");
      assert.equal(ref, "1.0.0");
      state.manifestReads += 1;
      return JSON.stringify({ dependencies: sampleDependencies });
    },
  };
  const resolver = new DependencyResolverService(
    { getProject: (projectId) => projectId === project.id ? project : undefined },
    gitClient,
    [parser],
    cloneRoot,
    dataStore
  );
  return { resolver, project, state };
}

test("supports package.json without claiming Maven or lock files", () => {
  assert.equal(parser.supports("package.json"), true);
  assert.equal(parser.supports("pom.xml"), false);
  assert.equal(parser.supports("package-lock.json"), false);
});

test("preserves scoped names, manifest order, and declared version strings", () => {
  const dependencies = {
    ...sampleDependencies,
    "@example-ui/component": "~0.11.0",
    "local-package": "workspace:*",
  };
  const result = parser.parseDependencies(JSON.stringify({ dependencies }));
  assert.deepEqual(
    result.dependencies.map(({ name, version }) => [name, version]),
    Object.entries(dependencies)
  );
  assert.equal(result.metadata.packageManager, "npm");
});

test("ignores dev, peer, and optional dependencies", () => {
  const result = parser.parseDependencies(JSON.stringify({
    dependencies: { "@example/core": "19.2.3" },
    devDependencies: { "dev-tool": "5.7.2" },
    peerDependencies: { "@other/core": "22.2.1" },
    optionalDependencies: { optional: "1.0.0" },
  }));
  assert.deepEqual(result.dependencies.map(({ name }) => name), ["@example/core"]);
});

test("skips non-string dependency versions", () => {
  const result = parser.parseDependencies(JSON.stringify({
    dependencies: {
      valid: "1.0.0", numeric: 123, missing: null, object: {}, array: [], boolean: true,
    },
  }));
  assert.deepEqual(result.dependencies.map(({ name, version }) => [name, version]), [["valid", "1.0.0"]]);
});

test("returns no dependencies for absent or invalid dependency sections", () => {
  for (const dependencies of [undefined, null, [], "invalid", 123, true]) {
    assert.deepEqual(parser.parseDependencies(JSON.stringify({ dependencies })).dependencies, []);
  }
});

test("rejects malformed JSON and non-object manifests with clear errors", () => {
  assert.throws(() => parser.parseDependencies('{"dependencies":'), (error) => {
    assert.match(error.message, /Invalid package\.json content:/);
    assert.ok(error.cause instanceof SyntaxError);
    return true;
  });
  for (const content of ["null", "[]", '"text"', "123", "true"]) {
    assert.throws(() => parser.parseDependencies(content), /package\.json must contain a JSON object\./);
  }
});

test("resolves scoped references against names and returns the first matching version", async () => {
  const cases = [
    { reference: "@example/core", expected: "19.2.3" },
    { reference: /^@example\/core$/, expected: "19.2.3" },
    { reference: /^@example\//, expected: "2.0.15" },
    { reference: /^@example(-addon)?\//, expected: "3.1.0" },
    { reference: /^@example\/missing$/, expected: "unknown" },
    { reference: /19\.2\.3/, expected: "unknown" },
  ];
  for (const { reference, expected } of cases) {
    const { resolver } = createResolver([reference], path.join(os.tmpdir(), "npm-test-clones"));
    const tree = await resolver.resolve("root", "1.0.0");
    assert.equal(tree.root.dependencies[0].version, expected, String(reference));
  }
});

test("resets a shared global regex for each dependency reference", async () => {
  const reference = /^@example\/core$/g;
  reference.lastIndex = 100;
  const { resolver } = createResolver([reference, reference], path.join(os.tmpdir(), "npm-test-clones"));
  const tree = await resolver.resolve("root", "1.0.0");
  assert.deepEqual(tree.root.dependencies.map(({ version }) => version), ["19.2.3", "19.2.3"]);
});

test("reuses an unchanged npm tree and re-resolves after the reference changes", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dependency-parser-npm-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonFileDataStore(path.join(directory, "trees.json"), path.join(directory, "projects.json"));
  const { resolver, project, state } = createResolver([/^@example\//], path.join(directory, "clones"), store);
  await store.saveProject(project);
  const original = await resolver.resolve("root", "1.0.0");
  assert.equal(original.root.dependencies[0].version, "2.0.15");
  assert.equal(state.manifestReads, 1);

  await store.saveProject(project);
  await resolver.resolve("root", "1.0.0");
  assert.equal(state.manifestReads, 1);

  project.dependencies[0].versionReference = /^@example\/core$/;
  await store.saveProject(project);
  const refreshed = await resolver.resolve("root", "1.0.0");
  assert.equal(refreshed.root.dependencies[0].version, "19.2.3");
  assert.equal(state.manifestReads, 2);
});