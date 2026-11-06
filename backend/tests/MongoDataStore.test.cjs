const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { EventEmitter, once } = require("node:events");
const { test } = require("node:test");
const express = require("express");
const { MongoClient } = require("mongodb");

const { MongoDataStore } = require("../dist/infrastructure/storage/MongoDataStore");
const { JsonFileDataStore } = require("../dist/infrastructure/storage/JsonFileDataStore");
const { buildDataStore, createServer, startServer } = require("../dist/interfaces/http/server");
const { Project } = require("../dist/domain/models/Project");
const { ProjectDependency } = require("../dist/domain/models/ProjectDependency");
const { DependencyTree } = require("../dist/domain/models/DependencyTree");
const { DependencyNode } = require("../dist/domain/models/DependencyNode");
const { Version } = require("../dist/domain/models/Version");
const { serializeProject } = require("../dist/infrastructure/storage/DataStoreSerialization");

function createDatabase() {
  const collections = new Map();
  return {
    collection(name) {
      if (!collections.has(name)) {
        collections.set(name, createCollection());
      }
      return collections.get(name);
    },
  };
}

function createCollection() {
  let documents = [];
  const matches = (document, filter) =>
    Object.entries(filter).every(([key, value]) => document[key] === value);
  const replaceOne = async (filter, replacement, options) => {
    const index = documents.findIndex(document => matches(document, filter));
    const document = structuredClone({ ...filter, ...replacement });
    if (index >= 0) {
      documents[index] = document;
    } else if (options.upsert) {
      documents.push(document);
    }
  };
  const deleteOne = async filter => {
    const index = documents.findIndex(document => matches(document, filter));
    if (index >= 0) {
      documents.splice(index, 1);
    }
  };

  return {
    async createIndex() {},
    async findOne(filter) {
      return structuredClone(documents.find(document => matches(document, filter)) ?? null);
    },
    find(filter) {
      return {
        async toArray() {
          return documents.filter(document => matches(document, filter))
            .map(document => structuredClone(document));
        },
      };
    },
    replaceOne,
    async bulkWrite(operations) {
      for (const operation of operations) {
        if (operation.replaceOne) {
          const { filter, replacement, upsert } = operation.replaceOne;
          await replaceOne(filter, replacement, { upsert });
        } else {
          await deleteOne(operation.deleteOne.filter);
        }
      }
    },
    async distinct(field, filter) {
      return [...new Set(documents.filter(document => matches(document, filter))
        .map(document => document[field]))];
    },
    deleteOne,
    async deleteMany(filter) {
      documents = documents.filter(document => !matches(document, filter));
    },
  };
}

async function createStore(context) {
  const uri = process.env.MONGODB_TEST_URI;
  if (!uri) {
    return new MongoDataStore(createDatabase());
  }

  const databaseName = `dependency_parser_test_${randomUUID().replaceAll("-", "")}`;
  const store = await MongoDataStore.connect(uri, databaseName);
  context.after(async () => {
    const client = new MongoClient(uri);
    try {
      await client.connect();
      await client.db(databaseName).dropDatabase();
    } finally {
      await client.close();
      await store.close();
    }
  });
  return store;
}

test("MongoDB rebuilds legacy prefix-alias trees for active tags while retaining historical snapshots", async () => {
  const database = createDatabase();
  const store = new MongoDataStore(database);
  const project = new Project("root", "Root", "https://example.com/root.git");
  const tree = new DependencyTree(new DependencyNode("root", "Root", "v5.3.0"));
  await store.saveProject(project);
  await store.syncProjectTags("root", [new Version("5.3.0", null, "commit")]);
  await store.saveDependencyTree("root", "5.3.0", tree, "commit");
  const collection = database.collection("dependencyTrees");
  const snapshot = await collection.findOne({ projectId: "root", version: "5.3.0" });
  snapshot.projectConfiguration = JSON.stringify(serializeProject(project));
  await collection.replaceOne({ projectId: "root", version: "5.3.0" }, snapshot);

  assert.equal(await store.getDependencyTree("root", "5.3.0", "commit"), null);
  assert.equal(await store.hasDependencyTree("root", "5.3.0"), false);
  assert.deepEqual(await store.getAvailableVersions("root"), []);
  await store.syncProjectTags("root", []);
  assert.deepEqual(await store.getDependencyTree("root", "5.3.0", "commit", true), tree);
  assert.deepEqual(await store.getAvailableVersions("root"), ["5.3.0"]);

  await store.syncProjectTags("root", [new Version("5.3.0", null, "commit")]);
  const exactTree = new DependencyTree(new DependencyNode("root", "Root", "5.3.0"));
  await store.saveDependencyTree("root", "5.3.0", exactTree, "commit");
  assert.deepEqual(await store.getDependencyTree("root", "5.3.0", "commit"), exactTree);
  assert.equal(await store.hasDependencyTree("root", "5.3.0"), true);
  assert.deepEqual(await store.getAvailableVersions("root"), ["5.3.0"]);
});

test("MongoDB returns empty results for missing projects and trees", async context => {
  const store = await createStore(context);
  assert.deepEqual(await store.getAllProjects(), []);
  assert.equal(await store.getProjectById("missing"), null);
  assert.equal(await store.getDependencyTree("missing", "1.0.0"), null);
  assert.equal(await store.hasDependencyTree("missing", "1.0.0"), false);
  assert.deepEqual(await store.getAvailableVersions("missing"), []);
  assert.deepEqual(await store.getProjectTags("missing"), []);
  assert.equal(await store.getProjectTag("missing", "v1"), null);
});

test("MongoDB persists range metadata and expires only range-containing trees across reloads", async context => {
  const now = Date.UTC(2026, 10, 4);
  context.mock.timers.enable({ apis: ["Date"], now });
  const database = createDatabase();
  const ttlMs = 60_000;
  const store = new MongoDataStore(database, undefined, ttlMs);
  const tree = new DependencyTree(new DependencyNode("root", "Root", "1.0.0", [
    new DependencyNode("child", "Child", "v2.3.7", [], true, "~2.3.0", "v2.3.7", new Date()),
  ]));
  await store.saveDependencyTree("root", "1.0.0", tree);
  const exact = new DependencyTree(new DependencyNode("root", "Root", "2.0.0"));
  await store.saveDependencyTree("root", "2.0.0", exact);
  const snapshot = await database.collection("dependencyTrees").findOne({ projectId: "root", version: "1.0.0" });
  assert.equal(snapshot.root.dependencies[0].declaredVersion, "~2.3.0");
  assert.equal(snapshot.root.dependencies[0].resolvedVersion, "v2.3.7");
  assert.equal(snapshot.root.dependencies[0].resolutionCheckedAt, new Date(now).toISOString());
  const reloaded = new MongoDataStore(database, undefined, ttlMs);
  context.mock.timers.setTime(now + ttlMs - 1);
  assert.deepEqual(await reloaded.getDependencyTree("root", "1.0.0"), tree);
  context.mock.timers.setTime(now + ttlMs);
  assert.equal(await reloaded.getDependencyTree("root", "1.0.0"), null);
  assert.equal(await reloaded.hasDependencyTree("root", "1.0.0"), false);
  assert.deepEqual(await reloaded.getAvailableVersions("root"), ["2.0.0"]);
  assert.deepEqual(await reloaded.getDependencyTree("root", "2.0.0"), exact);
  assert.deepEqual(await reloaded.getDependencyTree("root", "1.0.0", undefined, true), tree);
});

test("MongoDB preserves declared versions and unresolved dependency inspection", async context => {
  const store = await createStore(context);
  const tree = new DependencyTree(new DependencyNode("root", "Root", "3.1.574", [
    new DependencyNode("child", "Child", "19.1.75", [
      new DependencyNode("descendant", "Descendant", "unknown", [], false),
    ], false),
  ]));
  await store.saveDependencyTree("root", "3.1.574", tree);
  const saved = await store.getDependencyTree("root", "3.1.574");
  assert.equal(saved.root.dependenciesResolved, true);
  assert.equal(saved.find("child", "19.1.75").dependenciesResolved, false);
  assert.equal(saved.find("descendant", "unknown").dependenciesResolved, false);
  assert.deepEqual(saved, tree);
});

test("MongoDB retains project-linked tag metadata after removal and reappearance", async context => {
  const store = await createStore(context);
  const creationDate = new Date("2026-10-14T08:00:00Z");
  await store.syncProjectTags("root", [new Version("v1", creationDate, "commit-a")]);
  await store.syncProjectTags("other", [new Version("v1", null, "other-commit")]);
  await store.syncProjectTags("root", []);
  const removed = await store.getProjectTag("root", "v1");
  assert.equal(removed.removed, true);
  assert.equal(removed.projectId, "root");
  assert.equal(removed.commitHash, "commit-a");
  assert.deepEqual(removed.creationDate, creationDate);
  assert.deepEqual(Object.keys(removed).sort(), ["projectId", "name", "commitHash", "creationDate", "removed"].sort());
  await store.syncProjectTags("root", [new Version("v1", creationDate, "commit-b")]);
  const returned = await store.getProjectTag("root", "v1");
  assert.equal(returned.removed, false);
  assert.equal(returned.commitHash, "commit-b");
  assert.deepEqual(returned.creationDate, creationDate);
  await store.deleteProject("root");
  assert.deepEqual(await store.getProjectTags("root"), []);
  assert.equal((await store.getProjectTag("other", "v1")).removed, false);
});

test("MongoDB synchronizes a large tag catalog in one bulk write scoped to its project", async context => {
  const database = createDatabase();
  const store = new MongoDataStore(database);
  await store.syncProjectTags("root", [new Version("v0", null, "old"), new Version("excluded")]);
  await store.syncProjectTags("other", [new Version("excluded", null, "unrelated")]);
  const collection = database.collection("tags");
  const bulkWrite = context.mock.method(collection, "bulkWrite");
  const replaceOne = context.mock.method(collection, "replaceOne");
  const deleteOne = context.mock.method(collection, "deleteOne");
  const tags = Array.from({ length: 2352 }, (_, index) =>
    new Version(`v${index + 1}`, new Date("2026-10-20T08:00:00Z"), `commit-${index}`)
  );

  const updated = await store.syncProjectTags("root", tags, "^v");
  assert.equal(bulkWrite.mock.callCount(), 1);
  const [operations, options] = bulkWrite.mock.calls[0].arguments;
  assert.deepEqual(options, { ordered: false });
  assert.equal(operations.filter(operation => operation.replaceOne).length, 2353);
  assert.deepEqual(operations.filter(operation => operation.deleteOne), [
    { deleteOne: { filter: { projectId: "root", name: "excluded" } } },
  ]);
  assert.equal(replaceOne.mock.callCount(), 0);
  assert.equal(deleteOne.mock.callCount(), 0);
  assert.equal(updated.length, 2353);
  assert.equal((await store.getProjectTag("root", "v0")).removed, true);
  assert.equal(await store.getProjectTag("root", "excluded"), null);
  assert.equal((await store.getProjectTag("other", "excluded")).commitHash, "unrelated");
});

test("MongoDB skips empty bulk writes and propagates tag persistence failures", async context => {
  const database = createDatabase();
  const store = new MongoDataStore(database);
  const failure = new Error("Tag bulk write failed");
  const bulkWrite = context.mock.method(database.collection("tags"), "bulkWrite", async () => {
    throw failure;
  });

  assert.deepEqual(await store.syncProjectTags("root", []), []);
  assert.equal(bulkWrite.mock.callCount(), 0);
  await assert.rejects(store.syncProjectTags("root", [new Version("v1")]), error => error === failure);
  assert.equal(bulkWrite.mock.callCount(), 1);
});

test("MongoDB filters tag catalogs by the project regex and preserves saved trees", async context => {
  const store = await createStore(context);
  const pattern = "^\\d+\\.\\d+\\.\\d+(-patch\\.\\d+)?$";
  const excluded = "3.3.0-PR-5049.3";
  const tags = ["3.2.0", "3.3.0", "3.3.0-patch.1", excluded]
    .map(name => new Version(name, null, `commit-${name}`));
  await store.syncProjectTags("root", tags);
  await store.syncProjectTags("other", tags);
  const tree = new DependencyTree(new DependencyNode("root", "Root", excluded));
  await store.saveDependencyTree("root", excluded, tree, `commit-${excluded}`);

  await store.syncProjectTags("root", tags.slice(1), pattern);
  assert.deepEqual((await store.getProjectTags("root")).map(tag => tag.name).sort(), [
    "3.2.0", "3.3.0", "3.3.0-patch.1",
  ]);
  assert.equal((await store.getProjectTag("root", "3.2.0")).removed, true);
  assert.equal((await store.getProjectTag("root", "3.3.0")).removed, false);
  assert.equal((await store.getProjectTag("root", "3.3.0-patch.1")).removed, false);
  assert.equal(await store.getProjectTag("root", excluded), null);
  assert.deepEqual(await store.getDependencyTree("root", excluded, `commit-${excluded}`, true), tree);
  assert.equal((await store.getProjectTags("other")).length, 4);

  await store.syncProjectTags("root", [], "^3\\.3\\.0$");
  assert.deepEqual((await store.getProjectTags("root")).map(tag => tag.name), ["3.3.0"]);
  assert.equal((await store.getProjectTag("root", "3.3.0")).removed, true);
});

test("MongoDB retains historical commits and excludes stale active trees", async context => {
  const store = await createStore(context);
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
  const updated = new DependencyTree(new DependencyNode("root", "Root", "v1", [
    new DependencyNode("child", "Child", "2.0.0"),
  ]));
  await store.saveDependencyTree("root", "v1", updated, "commit-b");
  assert.deepEqual(await store.getDependencyTree("root", "v1", "commit-b"), updated);
  assert.deepEqual(await store.getDependencyTree("root", "v1", "commit-a", true), tree);
});

test("MongoDB round-trips nested projects, regex flags, strings, nulls and tag patterns", async context => {
  const store = await createStore(context);
  const leaf = new Project("leaf", "Leaf", "https://example.com/leaf.git");
  const child = new Project("child", "Child", "https://example.com/child.git", null, [
    new ProjectDependency(leaf, null, null),
  ], "release-*");
  const project = new Project("root", "Root", "https://example.com/root.git", "Root project", [
    new ProjectDependency(child, "package.json", /^@example\/core$/gi),
    new ProjectDependency(leaf, "pom.xml", "leaf.version"),
  ], "v*");

  await store.saveProject(project);
  const saved = await store.getProjectById("root");
  assert.deepEqual(saved, project);
  assert.ok(saved instanceof Project);
  assert.ok(saved.dependencies[0] instanceof ProjectDependency);
  assert.ok(saved.dependencies[0].project instanceof Project);
  assert.ok(saved.dependencies[0].versionReference instanceof RegExp);
  assert.deepEqual(await store.getAllProjects(), [project]);
});

test("MongoDB invalidates changed project trees but preserves unchanged and unrelated trees", async context => {
  const store = await createStore(context);
  const child = new Project("child", "Child", "https://example.com/child.git");
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
  assert.equal((await store.getAllProjects()).length, 1);
  assert.deepEqual(await store.getProjectById("root"), project);
});

test("MongoDB round-trips dependency trees and replaces an existing version", async context => {
  const store = await createStore(context);
  const child = new DependencyNode("child", "Child", "2.0.0");
  const tree = new DependencyTree(new DependencyNode("root", "Root", "1.0.0", [child]));
  await store.saveDependencyTree("root", "1.0.0", tree);

  const saved = await store.getDependencyTree("root", "1.0.0");
  assert.deepEqual(saved, tree);
  assert.ok(saved instanceof DependencyTree);
  assert.ok(saved.root instanceof DependencyNode);
  assert.deepEqual(saved.find("child", "2.0.0"), child);
  assert.equal(await store.getDependencyTree("other", "1.0.0"), null);

  const updated = new DependencyTree(new DependencyNode("root", "Root", "1.0.0", [
    new DependencyNode("child", "Child", "3.0.0"),
  ]));
  await store.saveDependencyTree("root", "1.0.0", updated);
  assert.deepEqual(await store.getDependencyTree("root", "1.0.0"), updated);
  assert.deepEqual(await store.getAvailableVersions("root"), ["1.0.0"]);
});

test("MongoDB lists only the requested project's versions in descending numeric order", async context => {
  const store = await createStore(context);
  const tree = new DependencyTree(new DependencyNode("root", "Root", "1.0.0"));
  for (const version of ["2.9.0", "1.0.0", "2.10.0"]) {
    await store.saveDependencyTree("root", version, tree);
  }
  await store.saveDependencyTree("other", "9.0.0", tree);
  assert.deepEqual(await store.getAvailableVersions("root"), ["2.10.0", "2.9.0", "1.0.0"]);
});

test("MongoDB deletes a project and all its trees without deleting unrelated data", async context => {
  const store = await createStore(context);
  const tree = new DependencyTree(new DependencyNode("root", "Root", "1.0.0"));
  await store.saveProject(new Project("root", "Root", "https://example.com/root.git"));
  await store.saveProject(new Project("other", "Other", "https://example.com/other.git"));
  await store.saveDependencyTree("root", "1.0.0", tree);
  await store.saveDependencyTree("root", "2.0.0", tree);
  await store.saveDependencyTree("other", "1.0.0", tree);

  await store.deleteProject("root");
  await store.deleteProject("root");
  assert.equal(await store.getProjectById("root"), null);
  assert.deepEqual(await store.getAvailableVersions("root"), []);
  assert.equal(await store.hasDependencyTree("root", "1.0.0"), false);
  assert.equal((await store.getAllProjects()).length, 1);
  assert.equal(await store.hasDependencyTree("other", "1.0.0"), true);
});

test("MongoDB initializes unique project/tag and project/version/commit indexes before use", async context => {
  const database = createDatabase();
  let closed = false;
  const index = context.mock.method(database.collection("dependencyTrees"), "createIndex", async () => {});
  const tagIndex = context.mock.method(database.collection("tags"), "createIndex", async () => {});
  const connect = context.mock.method(MongoClient.prototype, "connect", async function () { return this; });
  const selectDatabase = context.mock.method(MongoClient.prototype, "db", () => database);
  context.mock.method(MongoClient.prototype, "close", async () => { closed = true; });

  const store = await MongoDataStore.connect("mongodb://localhost:27017", "custom_database");
  assert.equal(connect.mock.callCount(), 1);
  assert.deepEqual(selectDatabase.mock.calls[0].arguments, ["custom_database"]);
  assert.deepEqual(index.mock.calls[0].arguments, [{ projectId: 1, version: 1, commitHash: 1 }, { unique: true }]);
  assert.deepEqual(tagIndex.mock.calls[0].arguments, [{ projectId: 1, name: 1 }, { unique: true }]);
  await store.close();
  assert.equal(closed, true);
});

test("MongoDB closes the client when connection or index initialization fails", async context => {
  const database = createDatabase();
  const failure = new Error("MongoDB initialization failed");
  const connect = context.mock.method(MongoClient.prototype, "connect", async () => { throw failure; });
  const close = context.mock.method(MongoClient.prototype, "close", async () => {});

  await assert.rejects(MongoDataStore.connect("mongodb://localhost:27017", "test"), failure);
  assert.equal(close.mock.callCount(), 1);

  connect.mock.mockImplementation(async function () { return this; });
  context.mock.method(MongoClient.prototype, "db", () => database);
  context.mock.method(database.collection("dependencyTrees"), "createIndex", async () => { throw failure; });
  await assert.rejects(MongoDataStore.connect("mongodb://localhost:27017", "test"), failure);
  assert.equal(close.mock.callCount(), 2);
});

test("runtime configuration selects JSON or nonpersistent storage", async () => {
  assert.ok(await buildDataStore({ DATASTORE: "json" }) instanceof JsonFileDataStore);
  assert.equal(await buildDataStore({}), undefined);
  assert.equal(await buildDataStore({ DATASTORE: "" }), undefined);
  assert.equal(await buildDataStore({ DATASTORE: "memory" }), undefined);
});

test("runtime configuration selects MongoDB with a custom or default database", async context => {
  const store = new MongoDataStore(createDatabase());
  const connect = context.mock.method(MongoDataStore, "connect", async () => store);
  const uri = "mongodb://localhost:27017";

  assert.equal(await buildDataStore({
    DATASTORE: " MongoDB ",
    MONGODB_URI: uri,
    MONGODB_DATABASE: "custom_database",
  }), store);
  assert.deepEqual(connect.mock.calls[0].arguments, [uri, "custom_database", 86_400_000]);

  assert.equal(await buildDataStore({ DATASTORE: "mongodb", MONGODB_URI: uri }), store);
  assert.deepEqual(connect.mock.calls[1].arguments, [uri, "dependency_parser", 86_400_000]);

  await buildDataStore({ DATASTORE: "mongodb", MONGODB_URI: uri, NPM_RANGE_RESOLUTION_TTL_MINUTES: "30" });
  assert.deepEqual(connect.mock.calls[2].arguments, [uri, "dependency_parser", 1_800_000]);
});

test("runtime configuration rejects missing MongoDB URIs and unsupported datastores", async context => {
  const connect = context.mock.method(MongoDataStore, "connect", async () => {});
  await assert.rejects(buildDataStore({ DATASTORE: "mongodb" }), /MONGODB_URI is required/);
  await assert.rejects(buildDataStore({ DATASTORE: "mongodb", MONGODB_URI: " " }), /MONGODB_URI is required/);
  await assert.rejects(buildDataStore({ DATASTORE: "unsupported" }), /Unsupported DATASTORE/);
  assert.equal(connect.mock.callCount(), 0);
});

function setEnvironment(context, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  context.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

test("server initialization loads projects from the selected MongoDB datastore and exposes cleanup", async context => {
  const { GitCliClient } = require("../dist/infrastructure/git/GitCliClient");
  const clearHistory = context.mock.method(GitCliClient.prototype, "clearCommitComparisonCache", async () => {});
  const store = new MongoDataStore(createDatabase());
  const projects = context.mock.method(store, "getAllProjects", async () => []);
  const close = context.mock.method(store, "close", async () => {});
  context.mock.method(MongoDataStore, "connect", async () => store);
  setEnvironment(context, { DATASTORE: "mongodb", MONGODB_URI: "mongodb://localhost:27017" });

  const app = await createServer();
  assert.equal(projects.mock.callCount(), 1);
  await app.locals.closeDataStore();
  assert.equal(close.mock.callCount(), 1);
  assert.equal(clearHistory.mock.callCount(), 1);
});

test("server cleanup still closes the datastore if comparison history cleanup fails", async context => {
  const { GitCliClient } = require("../dist/infrastructure/git/GitCliClient");
  const failure = new Error("History cleanup failed");
  context.mock.method(GitCliClient.prototype, "clearCommitComparisonCache", async () => { throw failure; });
  const store = new MongoDataStore(createDatabase());
  const close = context.mock.method(store, "close", async () => {});
  context.mock.method(MongoDataStore, "connect", async () => store);
  setEnvironment(context, { DATASTORE: "mongodb", MONGODB_URI: "mongodb://localhost:27017" });

  const app = await createServer();
  await assert.rejects(app.locals.closeDataStore(), failure);
  assert.equal(close.mock.callCount(), 1);
});

test("server initialization closes MongoDB if loading stored projects fails", async context => {
  const store = new MongoDataStore(createDatabase());
  const failure = new Error("Could not load stored projects");
  context.mock.method(store, "getAllProjects", async () => { throw failure; });
  const close = context.mock.method(store, "close", async () => {});
  context.mock.method(MongoDataStore, "connect", async () => store);
  setEnvironment(context, { DATASTORE: "mongodb", MONGODB_URI: "mongodb://localhost:27017" });

  await assert.rejects(createServer(), failure);
  assert.equal(close.mock.callCount(), 1);
});

test("server shutdown closes MongoDB and removes signal handlers", async context => {
  const store = new MongoDataStore(createDatabase());
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const close = context.mock.method(store, "close", async () => { resolveClosed(); });
  context.mock.method(MongoDataStore, "connect", async () => store);
  context.mock.method(console, "log", () => {});
  setEnvironment(context, { DATASTORE: "mongodb", MONGODB_URI: "mongodb://localhost:27017" });

  const server = new EventEmitter();
  server.close = () => { server.emit("close"); };
  context.mock.method(express.application, "listen", () => {
    queueMicrotask(() => server.emit("listening"));
    return server;
  });
  const previousInterrupt = process.listeners("SIGINT");
  const previousTerminate = process.listeners("SIGTERM");
  context.after(() => server.emit("close"));

  await startServer(3100);
  const shutdown = process.listeners("SIGTERM").find(listener => !previousTerminate.includes(listener));
  assert.equal(typeof shutdown, "function");
  shutdown();
  await closed;
  assert.equal(close.mock.callCount(), 1);
  assert.deepEqual(process.listeners("SIGINT"), previousInterrupt);
  assert.deepEqual(process.listeners("SIGTERM"), previousTerminate);
});

for (const failureMode of ["listen error", "synchronous listen failure"]) {
  test(`server closes MongoDB after a ${failureMode}`, async context => {
    const store = new MongoDataStore(createDatabase());
    const failure = new Error("Cannot listen on the requested port");
    const close = context.mock.method(store, "close", async () => {});
    context.mock.method(MongoDataStore, "connect", async () => store);
    setEnvironment(context, { DATASTORE: "mongodb", MONGODB_URI: "mongodb://localhost:27017" });

    const server = new EventEmitter();
    context.mock.method(express.application, "listen", () => {
      if (failureMode === "synchronous listen failure") {
        throw failure;
      }
      queueMicrotask(() => server.emit("error", failure));
      return server;
    });

    await assert.rejects(startServer(3100), failure);
    assert.equal(close.mock.callCount(), 1);
  });
}

async function closeHttpServer(server) {
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

test("MongoDB API persists projects across restart and supports updates and deletion", {
  skip: !process.env.MONGODB_TEST_URI,
}, async context => {
  const uri = process.env.MONGODB_TEST_URI;
  const databaseName = `dependency_parser_api_test_${randomUUID().replaceAll("-", "")}`;
  const client = new MongoClient(uri);
  let app;
  let server;
  setEnvironment(context, {
    DATASTORE: "mongodb",
    MONGODB_URI: uri,
    MONGODB_DATABASE: databaseName,
  });
  context.after(async () => {
    try {
      if (server) {
        await closeHttpServer(server);
      }
      await app?.locals.closeDataStore();
      await client.db(databaseName).dropDatabase();
    } finally {
      await client.close();
    }
  });
  await client.connect();

  const openServer = async () => {
    app = await createServer();
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    return `http://127.0.0.1:${server.address().port}/api/projects`;
  };
  let endpoint = await openServer();
  const indexes = await client.db(databaseName).collection("dependencyTrees").indexes();
  assert.ok(indexes.some(index => index.unique && index.key.projectId === 1 && index.key.version === 1
    && index.key.commitHash === 1));

  const createdResponse = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "MongoDB project", repoUrl: "https://example.com/project.git", dependencies: [] }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();

  await closeHttpServer(server);
  server = undefined;
  await app.locals.closeDataStore();
  app = undefined;
  endpoint = await openServer();

  const listResponse = await fetch(endpoint);
  assert.equal(listResponse.status, 200);
  assert.deepEqual((await listResponse.json()).projects, [created]);

  const updatedResponse = await fetch(`${endpoint}/${created.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...created, name: "Updated MongoDB project" }),
  });
  assert.equal(updatedResponse.status, 200);
  assert.equal((await updatedResponse.json()).name, "Updated MongoDB project");
  assert.equal((await client.db(databaseName).collection("projects").findOne({ _id: created.id })).name, "Updated MongoDB project");

  const deletedResponse = await fetch(`${endpoint}/${created.id}`, { method: "DELETE" });
  assert.equal(deletedResponse.status, 204);
  assert.equal(await client.db(databaseName).collection("projects").findOne({ _id: created.id }), null);
});