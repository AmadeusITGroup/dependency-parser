const assert = require("node:assert/strict");
const { once } = require("node:events");
const path = require("node:path");
const { test } = require("node:test");
const express = require("express");

const { DependencyTreeDTO } = require("../dist/application/dto/DependencyTreeDTO");
const { DependencyTreeMetadataService } = require("../dist/application/services/DependencyTreeMetadataService");
const { DependencyNode } = require("../dist/domain/models/DependencyNode");
const { DependencyTree } = require("../dist/domain/models/DependencyTree");
const { Project } = require("../dist/domain/models/Project");
const { ProjectDependency } = require("../dist/domain/models/ProjectDependency");
const { ProjectTag } = require("../dist/domain/models/ProjectTag");
const { Version } = require("../dist/domain/models/Version");
const { DependencyController } = require("../dist/interfaces/http/controllers/DependencyController");
const { VersionSearchController } = require("../dist/interfaces/http/controllers/VersionSearchController");

const rootDate = "2026-10-26T11:35:00.000Z";
const childDate = "2026-10-24T09:20:30.000Z";

function createMetadata(options = {}) {
  const child = new Project("child", "Child", "https://example.com/child.git");
  const root = new Project("root", "Root", "https://example.com/root.git", null, [
    new ProjectDependency(child, "package.json", "child"),
  ]);
  const reads = [];
  const localReads = [];
  const cloneChecks = [];
  const cloneRoot = path.resolve("metadata-test-clones");
  const metadata = new DependencyTreeMetadataService(
    {
      getProject: id => id === "root" ? root : null,
      getAllProjects: () => [root],
    },
    {
      hasClone: async (repoUrl, clonePath) => {
        cloneChecks.push({ repoUrl, clonePath });
        return options.hasClone ?? false;
      },
      getTags: async clonePath => {
        localReads.push(clonePath);
        if (options.localError) throw options.localError;
        return options.localTags?.[path.basename(clonePath)] ?? [];
      },
      syncTags: async () => { throw new Error("Metadata must not fetch remote tags."); },
      clone: async () => { throw new Error("Metadata must not clone repositories."); },
    },
    cloneRoot,
    options.withoutStore ? undefined : {
      getProjectTags: async id => {
        reads.push(id);
        if (options.storeError) throw options.storeError;
        return options.tags?.[id] ?? [];
      },
    }
  );
  return { metadata, reads, localReads, cloneChecks, cloneRoot };
}

function createTree() {
  return new DependencyTree(new DependencyNode("root", "Root", "v1", [
    new DependencyNode("child", "Child", "2.0.0"),
    new DependencyNode("child", "Child", "v3.0.0"),
    new DependencyNode("unknown-child", "Unknown", "unknown", [], false),
  ]));
}

test("creation dates enrich legacy trees from stored tags without modifying domain snapshots", async () => {
  const tree = createTree();
  const { metadata, reads, cloneChecks } = createMetadata({
    tags: {
      root: [new ProjectTag("root", "v1", "a", new Date(rootDate), true)],
      child: [
        new ProjectTag("child", "2.0.0", "b", new Date(childDate)),
        new ProjectTag("child", "v3.0.0", "c", null),
      ],
    },
  });
  const dto = DependencyTreeDTO.fromDomain("root", "v1", tree);
  assert.equal(dto.tree.creationDate, null);
  assert.equal(await metadata.addCreationDates(dto), dto);
  assert.equal(dto.tree.creationDate, rootDate);
  assert.deepEqual(dto.tree.dependencies.map(node => node.creationDate), [childDate, null, null]);
  assert.equal(dto.tree.dependencies[2].dependenciesResolved, false);
  assert.deepEqual(reads.sort(), ["child", "root"]);
  assert.deepEqual(cloneChecks, []);
  assert.equal(tree.root.creationDate, undefined);
  assert.equal(tree.root.dependencies[0].version, "2.0.0");
});

test("missing stored metadata uses each nested project's existing local clone only once", async () => {
  const { metadata, localReads, cloneChecks, cloneRoot } = createMetadata({
    hasClone: true,
    tags: { root: [new ProjectTag("root", "v1", "a", new Date(rootDate))] },
    localTags: {
      child: [
        new Version("2.0.0", new Date(childDate)),
        new Version("v3.0.0", new Date(rootDate)),
      ],
    },
  });
  const dto = await metadata.addCreationDates(DependencyTreeDTO.fromDomain("root", "v1", createTree()));
  assert.deepEqual(dto.tree.dependencies.map(node => node.creationDate), [childDate, rootDate, null]);
  assert.deepEqual(localReads, [path.join(cloneRoot, "child")]);
  assert.deepEqual(cloneChecks, [{
    repoUrl: "https://example.com/child.git",
    clonePath: path.join(cloneRoot, "child"),
  }]);
});

test("local tag dates also work without persistence and unknown metadata stays explicitly null", async () => {
  const { metadata, reads, localReads } = createMetadata({
    withoutStore: true,
    hasClone: true,
    localTags: { root: [new Version("v1", new Date(rootDate))] },
  });
  const dto = await metadata.addCreationDates(DependencyTreeDTO.fromDomain("root", "v1", createTree()));
  assert.equal(dto.tree.creationDate, rootDate);
  assert.ok(dto.tree.dependencies.every(node => node.creationDate === null));
  assert.deepEqual(reads, []);
  assert.equal(localReads.length, 2);

  const missing = createMetadata();
  const result = await missing.metadata.addCreationDates(DependencyTreeDTO.fromDomain("root", "v1", createTree()));
  assert.equal(result.tree.creationDate, null);
  assert.ok(result.tree.dependencies.every(node => node.creationDate === null));
});

test("exact tags retain their own dates when both prefix forms exist, including known null dates", async () => {
  const { metadata } = createMetadata({
    tags: {
      root: [
        new ProjectTag("root", "v1", "a", new Date(rootDate)),
        new ProjectTag("root", "1", "b", new Date(childDate)),
      ],
      child: [
        new ProjectTag("child", "2.0.0", "c", null),
        new ProjectTag("child", "v2.0.0", "d", new Date(childDate)),
        new ProjectTag("child", "v3.0.0", "e", new Date(rootDate)),
      ],
    },
  });
  const dto = await metadata.addCreationDates(DependencyTreeDTO.fromDomain("root", "v1", createTree()));
  assert.equal(dto.tree.creationDate, rootDate);
  assert.equal(dto.tree.dependencies[0].creationDate, null);
});

test("an exact local tag supplies its date independently of a different stored prefix form", async () => {
  const { metadata } = createMetadata({
    hasClone: true,
    tags: {
      root: [new ProjectTag("root", "v1", "a", new Date(rootDate))],
      child: [new ProjectTag("child", "v2.0.0", "b", new Date(childDate))],
    },
    localTags: { child: [new Version("2.0.0", new Date(rootDate))] },
  });
  const dto = await metadata.addCreationDates(DependencyTreeDTO.fromDomain("root", "v1", createTree()));
  assert.equal(dto.tree.dependencies[0].creationDate, rootDate);
});

test("tag dates never fall back to a different v prefix in stored or local catalogs", async () => {
  for (const local of [false, true]) {
    const tags = {
      root: [new ProjectTag("root", "1", "a", new Date(rootDate))],
      child: [
        new ProjectTag("child", "v2.0.0", "b", new Date(childDate)),
        new ProjectTag("child", "3.0.0", "c", new Date(childDate)),
      ],
    };
    const { metadata } = createMetadata(local ? {
      hasClone: true,
      localTags: Object.fromEntries(Object.entries(tags).map(([id, entries]) => [
        id, entries.map(tag => new Version(tag.name, tag.creationDate)),
      ])),
    } : { tags });
    const dto = await metadata.addCreationDates(DependencyTreeDTO.fromDomain("root", "v1", createTree()));
    assert.equal(dto.tree.creationDate, null);
    assert.ok(dto.tree.dependencies.every(node => node.creationDate === null));
  }
});

test("historical nodes no longer configured can still use retained tag dates", async () => {
  const tree = new DependencyTree(new DependencyNode("historical", "Historical", "v1"));
  const { metadata } = createMetadata({
    tags: { historical: [new ProjectTag("historical", "v1", "a", new Date(childDate), true)] },
  });
  const dto = await metadata.addCreationDates(DependencyTreeDTO.fromDomain("historical", "v1", tree));
  assert.equal(dto.tree.creationDate, childDate);
});

test("metadata read failures and invalid stored dates are not disguised as missing dates", async () => {
  for (const options of [
    { storeError: new Error("Tag catalog unavailable") },
    { hasClone: true, localError: new Error("Local tag read failed") },
    { tags: { root: [new ProjectTag("root", "v1", "a", new Date("invalid"))] } },
  ]) {
    await assert.rejects(createMetadata(options).metadata.addCreationDates(
      DependencyTreeDTO.fromDomain("root", "v1", createTree())
    ));
  }
});

test("dependency and root-version HTTP responses include the same node timestamps", async context => {
  const { metadata } = createMetadata({
    tags: {
      root: [new ProjectTag("root", "v1", "a", new Date(rootDate))],
      child: [new ProjectTag("child", "2.0.0", "b", new Date(childDate))],
    },
  });
  const tree = createTree();
  const dependency = new DependencyController({ execute: async () => tree }, metadata);
  const result = {
    projectId: "root", dependencyProjectId: "child", minimumVersion: "2.0.0",
    checkedVersions: 1, totalVersions: 1, warnings: [],
    match: { version: "v1", dependencyVersion: "2.0.0", path: [tree.root, tree.root.dependencies[0]], tree },
  };
  const search = new VersionSearchController({ execute: async () => result }, metadata);
  const app = express();
  app.get("/api/projects/:projectId/versions/:version/dependencies", dependency.resolveDependencies);
  app.get("/api/projects/:projectId/find-root-version", search.findVersion);
  const server = app.listen(0, "127.0.0.1");
  context.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  }));
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/api/projects/root`;
  const response = await fetch(`${base}/versions/v1/dependencies`);
  assert.equal(response.status, 200);
  const dependencies = await response.json();
  assert.equal(dependencies.tree.creationDate, rootDate);
  assert.equal(dependencies.tree.dependencies[0].creationDate, childDate);
  const searchResponse = await fetch(`${base}/find-root-version?dependencyProjectId=child&minimumVersion=2.0.0`);
  assert.equal(searchResponse.status, 200);
  assert.deepEqual((await searchResponse.json()).match.dependencyTree, dependencies);
  assert.equal(tree.root.creationDate, undefined);
});

test("root-version misses skip metadata reads and metadata failures remain API errors", async () => {
  const captureResponse = () => ({
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  });
  const request = {
    params: { projectId: "root", version: "v1" },
    query: { dependencyProjectId: "child", minimumVersion: "2.0.0" },
  };
  const missing = new VersionSearchController({
    execute: async () => ({
      projectId: "root", dependencyProjectId: "child", minimumVersion: "2.0.0",
      checkedVersions: 1, totalVersions: 1, warnings: [], match: null,
    }),
  }, { addCreationDates: async () => { throw new Error("No tree should be enriched."); } });
  const noMatch = captureResponse();
  await missing.findVersion(request, noMatch);
  assert.equal(noMatch.statusCode, 200);
  assert.equal(noMatch.body.match, null);

  const { metadata } = createMetadata({ storeError: new Error("Tag catalog unavailable") });
  const dependency = new DependencyController({ execute: async () => createTree() }, metadata);
  const error = captureResponse();
  await dependency.resolveDependencies(request, error);
  assert.equal(error.statusCode, 500);
  assert.deepEqual(error.body, { error: "Tag catalog unavailable" });
});
