const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { JsonFileDataStore } = require("../dist/infrastructure/storage/JsonFileDataStore");
const { Project } = require("../dist/domain/models/Project");
const { ProjectDependency } = require("../dist/domain/models/ProjectDependency");
const { DependencyTree } = require("../dist/domain/models/DependencyTree");
const { DependencyNode } = require("../dist/domain/models/DependencyNode");
const { Version } = require("../dist/domain/models/Version");
const { serializeProject } = require("../dist/infrastructure/storage/DataStoreSerialization");

test("legacy prefix-alias trees are rebuilt for active tags but retained as historical snapshots", async context => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "legacy-tag-resolution-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const treePath = path.join(directory, "trees.json");
  const projectPath = path.join(directory, "projects.json");
  const store = new JsonFileDataStore(treePath, projectPath);
  const project = new Project("root", "Root", "https://example.com/root.git");
  const tree = new DependencyTree(new DependencyNode("root", "Root", "v5.3.0"));
  await store.saveProject(project);
  await store.syncProjectTags("root", [new Version("5.3.0", null, "commit")]);
  await store.saveDependencyTree("root", "5.3.0", tree, "commit");
  const document = JSON.parse(await readFile(treePath, "utf8"));
  document.projects.root.versions["5.3.0"][0].projectConfiguration = JSON.stringify(serializeProject(project));
  await writeFile(treePath, JSON.stringify(document));

  const reloaded = new JsonFileDataStore(treePath, projectPath);
  assert.equal(await reloaded.getDependencyTree("root", "5.3.0", "commit"), null);
  assert.equal(await reloaded.hasDependencyTree("root", "5.3.0"), false);
  assert.deepEqual(await reloaded.getAvailableVersions("root"), []);
  await reloaded.syncProjectTags("root", []);
  assert.deepEqual(await reloaded.getDependencyTree("root", "5.3.0", "commit", true), tree);
  assert.deepEqual(await reloaded.getAvailableVersions("root"), ["5.3.0"]);

  await reloaded.syncProjectTags("root", [new Version("5.3.0", null, "commit")]);
  const exactTree = new DependencyTree(new DependencyNode("root", "Root", "5.3.0"));
  await reloaded.saveDependencyTree("root", "5.3.0", exactTree, "commit");
  assert.deepEqual(await reloaded.getDependencyTree("root", "5.3.0", "commit"), exactTree);
  assert.equal(await reloaded.hasDependencyTree("root", "5.3.0"), true);
  assert.deepEqual(await reloaded.getAvailableVersions("root"), ["5.3.0"]);
});

test("invalidates changed project trees and preserves unchanged and unrelated trees", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dependency-cache-"));
  try {
    const store = new JsonFileDataStore(
      path.join(directory, "trees.json"),
      path.join(directory, "projects.json")
    );
    const child = new Project("child", "Child", "https://example.com/child.git", null, null);
    const project = new Project("root", "Root", "https://example.com/root.git", null, [
      new ProjectDependency(child, "package.json", /^@example\/core$/),
    ]);
    const tree = new DependencyTree(new DependencyNode("root", "Root", "1.0.0"));
    await store.saveProject(project);
    await store.saveDependencyTree("root", "1.0.0", tree);
    await store.saveDependencyTree("root", "2.0.0", tree);
    await store.saveDependencyTree("other", "1.0.0", tree);

    await store.saveProject(await store.getProjectById("root"));
    assert.equal(await store.hasDependencyTree("root", "1.0.0"), true);
    assert.equal(await store.hasDependencyTree("root", "2.0.0"), true);

    project.dependencies[0].versionReference = /^@example\/feature$/;
    await store.saveProject(project);
    assert.equal(await store.hasDependencyTree("root", "1.0.0"), false);
    assert.equal(await store.hasDependencyTree("root", "2.0.0"), false);
    assert.equal(await store.hasDependencyTree("other", "1.0.0"), true);
    const saved = await store.getProjectById("root");
    assert.equal(saved.dependencies[0].versionReference.source, "^@example\\/feature$");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("serializes concurrent project and dependency-tree operations", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dependency-concurrency-"));
  try {
    const store = new JsonFileDataStore(
      path.join(directory, "trees.json"),
      path.join(directory, "projects.json")
    );
    const projects = ["first", "second", "third"].map(projectId =>
      new Project(projectId, projectId, `https://example.com/${projectId}.git`, null, null)
    );
    await Promise.all(projects.map(project => store.saveProject(project)));
    assert.deepEqual(
      (await store.getAllProjects()).map(project => project.id).sort(),
      projects.map(project => project.id).sort()
    );

    const versions = ["1.0.0", "2.0.0", "3.0.0"];
    await Promise.all(projects.flatMap(project => versions.flatMap(version => [
      store.saveDependencyTree(
        project.id,
        version,
        new DependencyTree(new DependencyNode(project.id, project.name, version))
      ),
      store.getAvailableVersions(project.id),
    ])));

    for (const project of projects) {
      assert.deepEqual((await store.getAvailableVersions(project.id)).sort(), versions);
      for (const version of versions) {
        assert.equal((await store.getDependencyTree(project.id, version)).root.version, version);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persists tag metadata, retains removed tags, and clears removal on reappearance", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "project-tags-"));
  try {
    const store = new JsonFileDataStore(path.join(directory, "trees.json"), path.join(directory, "projects.json"));
    const creationDate = new Date("2026-10-01T08:00:00Z");
    await store.syncProjectTags("root", [new Version("v1", creationDate, "commit-a")]);
    await store.syncProjectTags("other", [new Version("v1", null, "other-commit")]);
    await store.syncProjectTags("root", []);

    const reloaded = new JsonFileDataStore(path.join(directory, "trees.json"), path.join(directory, "projects.json"));
    const removed = await reloaded.getProjectTag("root", "v1");
    assert.equal(removed.removed, true);
    assert.equal(removed.projectId, "root");
    assert.equal(removed.commitHash, "commit-a");
    assert.deepEqual(removed.creationDate, creationDate);
    assert.deepEqual(Object.keys(removed).sort(), ["projectId", "name", "commitHash", "creationDate", "removed"].sort());
    await reloaded.syncProjectTags("root", [new Version("v1", creationDate, "commit-b")]);
    const returned = await reloaded.getProjectTag("root", "v1");
    assert.equal(returned.removed, false);
    assert.equal(returned.commitHash, "commit-b");
    assert.deepEqual(returned.creationDate, creationDate);
    await reloaded.deleteProject("root");
    assert.deepEqual(await reloaded.getProjectTags("root"), []);
    assert.equal((await reloaded.getProjectTag("other", "v1")).removed, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("filters the tag catalog by the project regex without deleting saved trees", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "filtered-project-tags-"));
  try {
    const store = new JsonFileDataStore(path.join(directory, "trees.json"), path.join(directory, "projects.json"));
    const pattern = "^\\d+\\.\\d+\\.\\d+(-patch\\.\\d+)?$";
    const excluded = "3.3.0-PR-5049.3";
    const tags = ["3.2.0", "3.3.0", "3.3.0-patch.1", excluded]
      .map(name => new Version(name, null, `commit-${name}`));
    await store.syncProjectTags("root", tags);
    await store.syncProjectTags("other", tags);
    const tree = new DependencyTree(new DependencyNode("root", "Root", excluded));
    await store.saveDependencyTree("root", excluded, tree, `commit-${excluded}`);

    await store.syncProjectTags("root", tags.slice(1), pattern);
    const reloaded = new JsonFileDataStore(path.join(directory, "trees.json"), path.join(directory, "projects.json"));
    const catalog = await reloaded.getProjectTags("root");
    assert.deepEqual(catalog.map(tag => tag.name).sort(), ["3.2.0", "3.3.0", "3.3.0-patch.1"]);
    assert.equal((await reloaded.getProjectTag("root", "3.2.0")).removed, true);
    assert.equal((await reloaded.getProjectTag("root", "3.3.0")).removed, false);
    assert.equal((await reloaded.getProjectTag("root", "3.3.0-patch.1")).removed, false);
    assert.equal(await reloaded.getProjectTag("root", excluded), null);
    assert.deepEqual(await reloaded.getDependencyTree("root", excluded, `commit-${excluded}`, true), tree);
    assert.equal((await reloaded.getProjectTags("other")).length, 4);

    await reloaded.syncProjectTags("root", [], "^3\\.3\\.0$");
    assert.deepEqual((await reloaded.getProjectTags("root")).map(tag => tag.name), ["3.3.0"]);
    assert.equal((await reloaded.getProjectTag("root", "3.3.0")).removed, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retains commit-aware historical trees without reusing invalid active caches", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tag-snapshots-"));
  try {
    const store = new JsonFileDataStore(path.join(directory, "trees.json"), path.join(directory, "projects.json"));
    const project = new Project("root", "Root", "https://example.com/root.git");
    const tree = new DependencyTree(new DependencyNode("root", "Root", "v1"));
    await store.saveProject(project);
    await store.syncProjectTags("root", [new Version("v1", null, "commit-a")]);
    await store.saveDependencyTree("root", "v1", tree, "commit-a");
    const originalConfiguration = await store.getProjectById("root");
    project.description = "Updated configuration";
    await store.saveProject(project);
    await store.saveDependencyTree("root", "v1", tree, "commit-a", originalConfiguration);
    assert.equal(await store.getDependencyTree("root", "v1", "commit-a"), null);
    assert.deepEqual(await store.getDependencyTree("root", "v1", "commit-a", true), tree);

    await store.syncProjectTags("root", []);
    assert.deepEqual(await store.getAvailableVersions("root"), ["v1"]);
    await store.syncProjectTags("root", [new Version("v1", null, "commit-b")]);
    assert.deepEqual(await store.getAvailableVersions("root"), []);
    const updatedTree = new DependencyTree(new DependencyNode("root", "Root", "v1", [
      new DependencyNode("child", "Child", "2.0.0"),
    ]));
    await store.saveDependencyTree("root", "v1", updatedTree, "commit-b");
    assert.deepEqual(await store.getDependencyTree("root", "v1", "commit-b"), updatedTree);
    assert.deepEqual(await store.getDependencyTree("root", "v1", "commit-a", true), tree);
    await store.deleteProject("root");
    assert.equal(await store.getDependencyTree("root", "v1", "commit-a", true), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});