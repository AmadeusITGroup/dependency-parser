const assert = require("node:assert/strict");
const { mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { DependencyResolverService } = require("../dist/application/services/DependencyResolverService");
const { VersionLocatorService } = require("../dist/application/services/VersionLocatorService");
const { GetDependencyVersion } = require("../dist/application/use-cases/GetDependencyVersion");
const { ScanProjectDependencies } = require("../dist/application/use-cases/ScanProjectDependencies");
const { buildDependencyResolutionRetries, buildDependencyScanConfig, buildGitConcurrency, buildLogLevel } = require("../dist/config/app.config");
const { DependencyNode } = require("../dist/domain/models/DependencyNode");
const { DependencyTree } = require("../dist/domain/models/DependencyTree");
const { DependencyTreeDTO } = require("../dist/application/dto/DependencyTreeDTO");
const { Project } = require("../dist/domain/models/Project");
const { ProjectDependency } = require("../dist/domain/models/ProjectDependency");
const { VersionNotFoundError } = require("../dist/domain/interfaces/IDependencyResolver");
const { reconcileProjectTags } = require("../dist/domain/models/ProjectTag");
const { Version } = require("../dist/domain/models/Version");
const { ProjectRegistry } = require("../dist/infrastructure/registry/ProjectRegistry");
const { JsonFileDataStore } = require("../dist/infrastructure/storage/JsonFileDataStore");
const { MongoDataStore } = require("../dist/infrastructure/storage/MongoDataStore");
const { NpmPackageParser } = require("../dist/infrastructure/parsers/npm/NpmPackageParser");
const { createServer } = require("../dist/interfaces/http/server");
const { DependencyController } = require("../dist/interfaces/http/controllers/DependencyController");
const { VersionController } = require("../dist/interfaces/http/controllers/VersionController");
const { ScanScheduler } = require("../dist/scheduler/ScanScheduler");
const { createLogger, logger } = require("../dist/utils/logger");

function deferred() {
  let resolve;
  const promise = new Promise(onResolve => { resolve = onResolve; });
  return { promise, resolve };
}

function emptyResult() {
  return { projectCount: 0, tagCount: 0, resolvedTreeCount: 0, failures: [] };
}

function createProjectRegistry(getProjects) {
  return {
    getAllProjects: getProjects,
    getProject: projectId => getProjects().find(project => project.id === projectId) ?? null,
  };
}

function assertCompleteScanTree(tree, project) {
  const version = tree.root.version;
  assert.ok(tree.flatten().every(node => node.version !== "unknown"),
    `${version} contains unknown dependencies`);
  const assertProject = expected => {
    const node = tree.findByProjectId(expected.id);
    assert.ok(node, `${version} is missing ${expected.name} (${expected.id})`);
    assert.equal(node.projectName, expected.name);
    for (const dependency of expected.dependencies ?? []) {
      assertProject(dependency.project);
    }
  };
  assertProject(project);
}

function createDependencyRetryScenario(options = {}) {
  const descendant = new Project("descendant", "Descendant", "https://example.com/descendant.git");
  const child = new Project("child", "Child", "https://example.com/child.git", null,
    options.withDescendants ? [new ProjectDependency(descendant, "package.json", "descendant")] : null);
  const sibling = new Project("sibling", "Sibling", "https://example.com/sibling.git");
  const project = new Project("root", "Root", "https://example.com/root.git", null, [
    new ProjectDependency(child, "package.json", "child"),
    new ProjectDependency(sibling, "package.json", "sibling"),
  ]);
  const warnings = [];
  let available = false;
  let childRefreshes = 0;
  let rootRefreshes = 0;
  const gitClient = {
    hasClone: async () => true,
    hasRef: async (repoPath) => path.basename(repoPath) === "child" ? available : !options.rootMissing,
    getTags: async () => [],
    syncTags: async (repoUrl, targetPath) => {
      if (repoUrl === child.repoUrl) {
        childRefreshes += 1;
        if (options.refreshError) throw options.refreshError;
        available = childRefreshes >= (options.availableAfter ?? Number.POSITIVE_INFINITY);
      } else {
        rootRefreshes += 1;
      }
      return targetPath;
    },
    fileExists: async () => true,
    getFileContent: async () => {
      if (options.manifestError) throw options.manifestError;
      return JSON.stringify({ dependencies: { child: "19.1.75", sibling: "1.0.0", descendant: "7.0.0" } });
    },
  };
  const resolver = new DependencyResolverService(
    new ProjectRegistry([project]), gitClient, [new NpmPackageParser()], "unused-clone-root",
    options.store, options.retries ?? 2,
    { warn: (details, message) => { warnings.push({ details, message }); } }
  );
  return {
    project, resolver, warnings,
    makeAvailable: () => { available = true; },
    get childRefreshes() { return childRefreshes; },
    get rootRefreshes() { return rootRefreshes; },
  };
}

function captureResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function captureLogOutput() {
  const entries = [];
  const output = Object.fromEntries(["error", "warn", "info", "debug"].map(level => [
    level,
    (...args) => { entries.push({ level, args }); },
  ]));
  return { entries, output };
}

function mockSchedulerTimer(context) {
  const timer = { unref() {} };
  const interval = context.mock.method(globalThis, "setInterval", () => timer);
  const clear = context.mock.method(globalThis, "clearInterval", () => {});
  const log = {
    error: context.mock.fn(),
    warn: context.mock.fn(),
    info: context.mock.fn(),
    debug: context.mock.fn(),
  };
  return {
    interval,
    clear,
    log,
    errors: log.error,
    tick: () => interval.mock.calls[0].arguments[0](),
  };
}

test("log level defaults to info and accepts only error, warn, info, and debug", () => {
  assert.equal(buildLogLevel({}), "info");
  assert.equal(buildLogLevel({ LOG_LEVEL: " " }), "info");
  for (const level of ["error", "warn", "info", "debug"]) {
    assert.equal(buildLogLevel({ LOG_LEVEL: ` ${level.toUpperCase()} ` }), level);
  }
  for (const level of ["trace", "fatal", "silent", "invalid"]) {
    assert.throws(() => buildLogLevel({ LOG_LEVEL: level }), /LOG_LEVEL/);
  }
});

test("logger filters messages according to the configured level", () => {
  const levels = ["error", "warn", "info", "debug"];
  for (const minimumLevel of levels) {
    const { entries, output } = captureLogOutput();
    const log = createLogger({ LOG_LEVEL: minimumLevel }, output);
    for (const level of levels) {
      log[level](`${level} message`);
    }
    assert.deepEqual(
      entries.map(entry => entry.level),
      levels.slice(0, levels.indexOf(minimumLevel) + 1)
    );
  }

  const { entries, output } = captureLogOutput();
  const log = createLogger({}, output);
  log.debug("Not emitted by default");
  log.info("Ready");
  assert.deepEqual(entries.map(entry => entry.level), ["info"]);
});

test("logger prefixes ISO timestamps and levels while retaining context and errors", () => {
  const { entries, output } = captureLogOutput();
  const log = createLogger({ LOG_LEVEL: "debug" }, output);
  const error = new Error("Repository unavailable");
  const context = { projectId: "root", err: error };
  log.warn(context, "Scan failed");
  log.debug("Dependency scan started.");

  assert.match(
    entries[0].args[0],
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[WARN\] Scan failed$/
  );
  assert.equal(entries[0].args[1], context);
  assert.equal(entries[0].args[1].err, error);
  assert.match(entries[1].args[0], /Z \[DEBUG\] Dependency scan started\.$/);
  assert.equal(entries[1].args.length, 1);
});

test("dependency scans default to enabled every fifteen minutes", () => {
  assert.deepEqual(buildDependencyScanConfig({}), { enabled: true, intervalMs: 900_000 });
  assert.deepEqual(buildDependencyScanConfig({
    DEPENDENCY_SCAN_ENABLED: " false ",
    DEPENDENCY_SCAN_INTERVAL_MINUTES: "0.5",
  }), { enabled: false, intervalMs: 30_000 });
});

test("Git concurrency defaults to four and accepts only positive safe integers", () => {
  assert.equal(buildGitConcurrency({}), 4);
  assert.equal(buildGitConcurrency({ GIT_MAX_CONCURRENCY: " " }), 4);
  assert.equal(buildGitConcurrency({ GIT_MAX_CONCURRENCY: " 2 " }), 2);
  for (const value of ["0", "-1", "1.5", "NaN", "Infinity", "invalid", "9007199254740992"]) {
    assert.throws(() => buildGitConcurrency({ GIT_MAX_CONCURRENCY: value }), /GIT_MAX_CONCURRENCY/);
  }
});

test("dependency retries default to two and accept zero but reject invalid counts", () => {
  assert.equal(buildDependencyResolutionRetries({}), 2);
  assert.equal(buildDependencyResolutionRetries({ DEPENDENCY_RESOLUTION_RETRIES: "0" }), 0);
  assert.equal(buildDependencyResolutionRetries({ DEPENDENCY_RESOLUTION_RETRIES: " 1 " }), 1);
  for (const value of ["-1", "0.5", "NaN", "Infinity", "invalid", "9007199254740992"]) {
    assert.throws(() => buildDependencyResolutionRetries({ DEPENDENCY_RESOLUTION_RETRIES: value }), /DEPENDENCY_RESOLUTION_RETRIES/);
  }
});

test("exhausted missing refs preserve the declared version and mark configured descendants unknown", async () => {
  const scenario = createDependencyRetryScenario({ withDescendants: true });
  const tree = await scenario.resolver.resolve("root", "3.1.574");
  const child = tree.find("child", "19.1.75");
  assert.equal(child.version, "19.1.75");
  assert.equal(child.dependenciesResolved, false);
  assert.equal(tree.find("descendant", "unknown").version, "unknown");
  assert.equal(tree.find("descendant", "unknown").dependenciesResolved, false);
  assert.equal(tree.find("sibling", "1.0.0").version, "1.0.0");
  const dto = DependencyTreeDTO.fromDomain("root", "3.1.574", tree);
  assert.equal(dto.tree.dependencies[0].version, "19.1.75");
  assert.equal(dto.tree.dependencies[0].dependenciesResolved, false);
  assert.equal(dto.tree.dependencies[0].dependencies[0].version, "unknown");
});

test("an unavailable leaf keeps its declared version without inventing dependencies", async () => {
  const scenario = createDependencyRetryScenario();
  const tree = await scenario.resolver.resolve("root", "3.1.574");
  assert.equal(scenario.childRefreshes, 3);
  assert.equal(tree.root.version, "3.1.574");
  assert.equal(tree.find("child", "19.1.75").dependenciesResolved, false);
  assert.deepEqual(tree.find("child", "19.1.75").dependencies, []);
  assert.equal(tree.find("sibling", "1.0.0").version, "1.0.0");
  assert.equal(scenario.warnings.length, 1);
  assert.equal(scenario.warnings[0].details.requestedVersion, "19.1.75");
  assert.equal(scenario.warnings[0].details.attempts, 3);
  assert.ok(scenario.warnings[0].details.err instanceof VersionNotFoundError);
});

test("unknown-descendant fallback stops at configured cycles", async () => {
  const scenario = createDependencyRetryScenario({ retries: 0 });
  const child = scenario.project.dependencies[0].project;
  child.dependencies = [new ProjectDependency(child, "package.json", "child")];
  const tree = await scenario.resolver.resolve("root", "3.1.574");
  const unavailable = tree.find("child", "19.1.75");
  assert.equal(unavailable.dependencies[0].version, "unknown");
  assert.deepEqual(unavailable.dependencies[0].dependencies, []);
});

test("a dependency that appears on retry resolves normally", async () => {
  const scenario = createDependencyRetryScenario({ availableAfter: 2 });
  const tree = await scenario.resolver.resolve("root", "3.1.574");
  assert.equal(scenario.childRefreshes, 2);
  assert.equal(tree.find("child", "19.1.75").version, "19.1.75");
  assert.equal(tree.find("child", "19.1.75").dependenciesResolved, true);
  assert.equal(scenario.warnings.length, 0);
  const noRetries = createDependencyRetryScenario({ retries: 0 });
  assert.equal((await noRetries.resolver.resolve("root", "3.1.574")).find("child", "19.1.75").dependenciesResolved, false);
  assert.equal(noRetries.childRefreshes, 1);
});

test("root ref resolution never adds or removes a v prefix", async () => {
  for (const [requested, available] of [["5.3.0", "v5.3.0"], ["v5.3.0", "5.3.0"]]) {
    const project = new Project("root", "Root", "https://example.com/root.git");
    let refreshes = 0;
    const resolver = new DependencyResolverService(
      new ProjectRegistry([project]),
      {
        hasClone: async () => true,
        hasRef: async (_repoPath, ref) => ref === available,
        getTags: async () => [new Version(available)],
        syncTags: async (_repoUrl, targetPath) => { refreshes += 1; return targetPath; },
      },
      [],
      "unused-clone-root"
    );
    await assert.rejects(resolver.resolve("root", requested), error => {
      assert.ok(error instanceof VersionNotFoundError);
      assert.equal(error.version, requested);
      return true;
    });
    assert.equal(refreshes, 1);
    assert.equal((await resolver.resolve("root", available)).root.version, available);
  }
});

test("dependency refs preserve the declared prefix instead of resolving an alternate tag", async () => {
  for (const [requested, alternate] of [["5.3.0", "v5.3.0"], ["v5.3.0", "5.3.0"]]) {
    const child = new Project("child", "Child", "https://example.com/child.git", null, null,
      "^v?\\d+\\.\\d+\\.\\d+$");
    const root = new Project("root", "Root", "https://example.com/root.git", null, [
      new ProjectDependency(child, "package.json", "child"),
    ]);
    let exactAvailable = false;
    const warnings = [];
    const resolver = new DependencyResolverService(
      new ProjectRegistry([root]),
      {
        hasClone: async () => true,
        hasRef: async (repoPath, ref) => path.basename(repoPath) === "root" ||
          ref === alternate || (exactAvailable && ref === requested),
        getTags: async () => [new Version(alternate)],
        syncTags: async (_repoUrl, targetPath) => targetPath,
        fileExists: async () => true,
        getFileContent: async () => JSON.stringify({ dependencies: { child: requested } }),
      },
      [new NpmPackageParser()],
      "unused-clone-root",
      undefined,
      0,
      { warn: details => warnings.push(details) }
    );
    const partial = await resolver.resolve("root", "root-1");
    assert.equal(partial.root.dependencies[0].version, requested);
    assert.equal(partial.root.dependencies[0].dependenciesResolved, false);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].requestedVersion, requested);

    exactAvailable = true;
    const resolved = await resolver.resolve("root", "root-1");
    assert.equal(resolved.root.dependencies[0].version, requested);
    assert.equal(resolved.root.dependencies[0].dependenciesResolved, true);
  }
});

test("concurrent parents share the same bounded missing-ref attempts", async () => {
  const scenario = createDependencyRetryScenario();
  const trees = await Promise.all(["3.1.574", "3.1.573", "3.1.572"].map(version =>
    scenario.resolver.resolve("root", version)
  ));
  assert.equal(scenario.childRefreshes, 3);
  assert.equal(trees.length, 3);
  assert.ok(trees.every(tree => tree.find("child", "19.1.75").dependenciesResolved === false));
});

test("partial JSON trees persist and recover on a later resolution", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "retry-partial-tree-"));
  try {
    const store = new JsonFileDataStore(path.join(directory, "trees.json"), path.join(directory, "projects.json"));
    const scenario = createDependencyRetryScenario({ store });
    await store.saveProject(scenario.project);
    await scenario.resolver.resolve("root", "3.1.574");
    const reloaded = new JsonFileDataStore(path.join(directory, "trees.json"), path.join(directory, "projects.json"));
    const saved = await reloaded.getDependencyTree("root", "3.1.574");
    assert.equal(saved.find("child", "19.1.75").dependenciesResolved, false);
    assert.deepEqual(saved.find("child", "19.1.75").dependencies, []);
    scenario.makeAvailable();
    const recovered = await scenario.resolver.resolve("root", "3.1.574");
    assert.equal(recovered.find("child", "19.1.75").version, "19.1.75");
    assert.equal(recovered.find("child", "19.1.75").dependenciesResolved, true);
    assert.ok((await store.getDependencyTree("root", "3.1.574")).find("child", "19.1.75"));
    assert.equal(scenario.childRefreshes, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("root, authentication, manifest, and storage failures are not hidden as unknown", async () => {
  const missingRoot = createDependencyRetryScenario({ rootMissing: true });
  await assert.rejects(missingRoot.resolver.resolve("root", "missing-root"), VersionNotFoundError);
  assert.equal(missingRoot.rootRefreshes, 1);
  assert.equal(missingRoot.childRefreshes, 0);
  for (const message of ["Authentication failed", "Network unavailable"]) {
    const failure = new Error(message);
    const scenario = createDependencyRetryScenario({ refreshError: failure });
    await assert.rejects(scenario.resolver.resolve("root", "3.1.574"), error => error === failure);
    assert.equal(scenario.childRefreshes, 1);
    assert.equal(scenario.warnings.length, 0);
  }
  const manifestFailure = new Error("Invalid manifest configuration");
  const manifest = createDependencyRetryScenario({ manifestError: manifestFailure });
  await assert.rejects(manifest.resolver.resolve("root", "3.1.574"), error => error === manifestFailure);
  const storageFailure = new Error("Datastore unavailable");
  const storage = createDependencyRetryScenario({ availableAfter: 1, store: {
    getProjectTag: async () => null,
    getDependencyTree: async () => null,
    saveDependencyTree: async () => { throw storageFailure; },
  } });
  await assert.rejects(storage.resolver.resolve("root", "3.1.574"), error => error === storageFailure);
  assert.equal(storage.warnings.length, 0);
});

test("rejects invalid scan settings and intervals that overflow Node timers", () => {
  assert.throws(
    () => buildDependencyScanConfig({ DEPENDENCY_SCAN_ENABLED: "yes" }),
    /DEPENDENCY_SCAN_ENABLED/
  );
  for (const interval of ["0", "-1", "NaN", "Infinity", "invalid", "1000000", "0.000001"]) {
    assert.throws(
      () => buildDependencyScanConfig({ DEPENDENCY_SCAN_INTERVAL_MINUTES: interval }),
      /DEPENDENCY_SCAN_INTERVAL_MINUTES/
    );
  }
});

test("refreshes all project tags before resolving tree jobs newest first", async () => {
  const events = [];
  const tags = { first: ["2.0.0", "1.0.0"], second: ["3.0.0"] };
  const scanner = new ScanProjectDependencies(
    createProjectRegistry(() => [{ id: "first" }, { id: "second" }]),
    {
      getAvailableVersions: async projectId => {
        events.push(`tags:${projectId}`);
        return tags[projectId].map(version => new Version(version, null, null));
      },
    },
    {
      resolve: async (projectId, version) => {
        events.push(`tree:${projectId}@${version}`);
        return new DependencyTree(new DependencyNode(projectId, projectId, version));
      },
    }
  );

  assert.deepEqual(await scanner.execute(), {
    projectCount: 2, tagCount: 3, resolvedTreeCount: 3, failures: [],
  });
  assert.deepEqual(events, [
    "tags:first", "tags:second", "tree:second@3.0.0",
    "tree:first@2.0.0", "tree:first@1.0.0",
  ]);
});

test("creation dates outrank version numbers and discovery order across projects", async () => {
  const tags = {
    first: [
      new Version("99.0.0", new Date("2026-10-19T08:00:00Z"), "first-old"),
      new Version("1000.0.0", null, "first-undated"),
      new Version("3.0.0", new Date("2026-10-22T08:00:00Z"), "first-recent"),
    ],
    second: [
      new Version("2.0.0", new Date("2026-10-22T10:00:00+02:00"), "second-tied"),
      new Version("999.0.0", null, "second-undated"),
      new Version("0.5.0", new Date("2026-10-23T08:00:00Z"), "second-new"),
    ],
  };
  const attempts = [];
  const events = [];
  const scanner = new ScanProjectDependencies(
    createProjectRegistry(() => [{ id: "first" }, { id: "second" }]),
    { getAvailableVersions: async projectId => tags[projectId] },
    {
      resolve: async (projectId, version) => {
        attempts.push(`${projectId}@${version}`);
        return new DependencyTree(new DependencyNode(projectId, projectId, version));
      },
    }
  );

  await scanner.refreshTags();
  assert.deepEqual(await scanner.buildDependencyTrees(() => false, event => events.push(event)), {
    projectCount: 2, tagCount: 6, resolvedTreeCount: 6, failures: [],
  });
  const expected = [
    ["second", "0.5.0", "2026-10-23T08:00:00.000Z"],
    ["first", "3.0.0", "2026-10-22T08:00:00.000Z"],
    ["second", "2.0.0", "2026-10-22T08:00:00.000Z"],
    ["first", "99.0.0", "2026-10-19T08:00:00.000Z"],
    ["first", "1000.0.0", null],
    ["second", "999.0.0", null],
  ];
  assert.deepEqual(attempts, expected.map(([projectId, version]) => `${projectId}@${version}`));
  for (const eventType of ["started", "completed"]) {
    assert.deepEqual(
      events.filter(event => event.event === eventType)
        .map(event => [event.projectId, event.version, event.creationDate]),
      expected
    );
  }
});

test("isolates project and tag failures so remaining work continues", async () => {
  const fetchError = new Error("Repository unavailable");
  const resolveError = new Error("Manifest unavailable");
  const attempts = [];
  const scanner = new ScanProjectDependencies(
    createProjectRegistry(() => [{ id: "unavailable" }, { id: "first" }, { id: "second" }]),
    {
      getAvailableVersions: async projectId => {
        if (projectId === "unavailable") {
          throw fetchError;
        }
        return (projectId === "first" ? ["broken", "1.0.0"] : ["2.0.0"])
          .map(version => new Version(version, null, null));
      },
    },
    {
      resolve: async (projectId, version) => {
        attempts.push(`${projectId}@${version}`);
        if (version === "broken") {
          throw resolveError;
        }
        return new DependencyTree(new DependencyNode(projectId, projectId, version));
      },
    }
  );

  assert.deepEqual(await scanner.execute(), {
    projectCount: 3,
    tagCount: 3,
    resolvedTreeCount: 2,
    failures: [
      { projectId: "unavailable", error: fetchError },
      { projectId: "first", version: "broken", error: resolveError },
    ],
  });
  assert.deepEqual(attempts, ["first@broken", "second@2.0.0", "first@1.0.0"]);
});

test("reads the current registry on every scan", async () => {
  const projects = [{ id: "first" }];
  const attempts = [];
  const scanner = new ScanProjectDependencies(
    createProjectRegistry(() => [...projects]),
    { getAvailableVersions: async () => [new Version("1.0.0", null, null)] },
    {
      resolve: async (projectId, version) => {
        attempts.push(projectId);
        return new DependencyTree(new DependencyNode(projectId, projectId, version));
      },
    }
  );

  await scanner.execute();
  projects.push({ id: "second" });
  await scanner.execute();
  assert.deepEqual(attempts, ["first", "second"]);
});

test("refreshes each unique nested catalog every pass without turning dependencies into registered roots or tree jobs", async () => {
  const shared = new Project("shared", "Shared", "https://example.com/shared.git");
  const intermediate = new Project("middle", "Middle", "https://example.com/middle.git", null, [
    new ProjectDependency(shared, "package.json", "shared"),
  ]);
  const projects = [
    new Project("first", "First", "https://example.com/first.git", null, [
      new ProjectDependency(intermediate, "package.json", "middle"),
      new ProjectDependency(shared, "package.json", "shared"),
    ]),
    new Project("second", "Second", "https://example.com/second.git", null, [
      new ProjectDependency(shared, "package.json", "shared"),
    ]),
  ];
  const refreshed = [];
  const built = [];
  const scanner = new ScanProjectDependencies(
    createProjectRegistry(() => projects),
    {
      getAvailableVersions: async projectId => {
        refreshed.push(projectId);
        const count = projectId === "shared" ? 3 : projectId === "middle" ? 2 : 1;
        return Array.from({ length: count }, (_, index) => new Version(`1.0.${index}`, null));
      },
    },
    {
      resolve: async (projectId, version) => {
        built.push([projectId, version]);
        return new DependencyTree(new DependencyNode(projectId, projectId, version));
      },
    },
    2
  );

  assert.deepEqual(await scanner.execute(), {
    projectCount: 4, tagCount: 7, resolvedTreeCount: 2, failures: [],
  });
  assert.deepEqual([...refreshed].sort(), ["first", "middle", "second", "shared"]);
  assert.deepEqual(built.map(([projectId]) => projectId).sort(), ["first", "second"]);
  assert.deepEqual(projects.map(project => project.id), ["first", "second"]);
  assert.equal(scanner.pendingTreeCount, 0);

  refreshed.length = 0;
  assert.deepEqual(await scanner.execute(), {
    projectCount: 4, tagCount: 7, resolvedTreeCount: 0, failures: [],
  });
  assert.deepEqual([...refreshed].sort(), ["first", "middle", "second", "shared"]);
  assert.equal(built.length, 2);

  projects.push(shared);
  assert.equal((await scanner.execute()).resolvedTreeCount, 3);
  assert.ok(built.slice(2).every(([projectId]) => projectId === "shared"));
});

test("a failed nested catalog does not block its descendants, sibling catalogs, or root tree jobs", async () => {
  const leaf = new Project("leaf", "Leaf", "https://example.com/leaf.git");
  const broken = new Project("broken", "Broken", "https://example.com/broken.git", null, [
    new ProjectDependency(leaf, "package.json", "leaf"),
  ]);
  const sibling = new Project("sibling", "Sibling", "https://example.com/sibling.git");
  const root = new Project("root", "Root", "https://example.com/root.git", null, [
    new ProjectDependency(broken, "package.json", "broken"),
    new ProjectDependency(sibling, "package.json", "sibling"),
  ]);
  const failure = new Error("Dependency repository unavailable");
  const refreshed = [];
  const built = [];
  const scanner = new ScanProjectDependencies(
    new ProjectRegistry([root]),
    {
      getAvailableVersions: async projectId => {
        refreshed.push(projectId);
        if (projectId === "broken") throw failure;
        return [new Version("1.0.0", null)];
      },
    },
    {
      resolve: async (projectId, version) => {
        built.push(projectId);
        return new DependencyTree(new DependencyNode(projectId, projectId, version));
      },
    },
    2
  );

  assert.deepEqual(await scanner.execute(), {
    projectCount: 4, tagCount: 3, resolvedTreeCount: 1,
    failures: [{ projectId: "broken", error: failure }],
  });
  assert.deepEqual([...refreshed].sort(), ["broken", "leaf", "root", "sibling"]);
  assert.deepEqual(built, ["root"]);
});

test("shutdown stops before starting the next nested catalog refresh", async () => {
  const leaf = new Project("leaf", "Leaf", "https://example.com/leaf.git");
  const child = new Project("child", "Child", "https://example.com/child.git", null, [
    new ProjectDependency(leaf, "package.json", "leaf"),
  ]);
  const root = new Project("root", "Root", "https://example.com/root.git", null, [
    new ProjectDependency(child, "package.json", "child"),
  ]);
  let stopped = false;
  const refreshed = [];
  const scanner = new ScanProjectDependencies(
    new ProjectRegistry([root]),
    {
      getAvailableVersions: async projectId => {
        refreshed.push(projectId);
        if (projectId === "child") stopped = true;
        return [new Version("1.0.0", null)];
      },
    },
    { resolve: async () => assert.fail("Shutdown must not start queued tree jobs.") }
  );

  const result = await scanner.execute(() => stopped);
  assert.equal(result.projectCount, 2);
  assert.equal(result.resolvedTreeCount, 0);
  assert.deepEqual(refreshed, ["root", "child"]);
});

test("repeated refreshes drain 2257 tags without restarting completed or partial jobs", async () => {
  const project = new Project("root", "Root", "https://example.com/root.git");
  const versions = Array.from({ length: 2257 }, (_, index) =>
    new Version(`1.0.${index}`, new Date(index * 1000), `commit-${index}`)
  );
  const attempts = [];
  const scanner = new ScanProjectDependencies(
    new ProjectRegistry([project]),
    { getAvailableVersions: async () => versions },
    {
      resolve: async (projectId, version) => {
        attempts.push(version);
        if (attempts.length % 100 === 0) {
          await scanner.refreshTags();
        }
        return new DependencyTree(new DependencyNode(projectId, "Root", version, [
          new DependencyNode("child", "Child", "2.3.4", [
            new DependencyNode("descendant", "Descendant", "unknown", [], false),
          ], false),
        ]));
      },
    },
    4
  );

  assert.equal((await scanner.execute()).resolvedTreeCount, 2257);
  assert.equal(attempts.length, 2257);
  assert.equal(new Set(attempts).size, 2257);
  assert.ok(attempts.includes("1.0.0"));
  assert.equal(scanner.pendingTreeCount, 0);
  assert.equal((await scanner.execute()).resolvedTreeCount, 0);
  assert.equal(attempts.length, 2257);
});

test("saved partial JSON trees are skipped by scans even in a new session", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "scan-saved-partial-"));
  try {
    const treeFile = path.join(directory, "trees.json");
    const projectFile = path.join(directory, "projects.json");
    const store = new JsonFileDataStore(treeFile, projectFile);
    const scenario = createDependencyRetryScenario({ store, withDescendants: true });
    await store.saveProject(scenario.project);
    const versions = [new Version("1.2.3", null, "commit-a")];
    await store.syncProjectTags("root", versions);
    await scenario.resolver.resolve("root", "1.2.3");
    assert.equal(scenario.childRefreshes, 3);
    const reloaded = new JsonFileDataStore(treeFile, projectFile);
    const registry = new ProjectRegistry([scenario.project]);
    const locator = new VersionLocatorService(registry, {
      syncTags: async (_repoUrl, targetPath) => targetPath,
      getTags: async () => versions,
    }, reloaded, directory);
    const scanner = new ScanProjectDependencies(registry, locator, {
      resolve: async () => { throw new Error("A saved partial tree must not be rebuilt by the scan."); },
    });

    assert.equal((await locator.getAvailableVersions("root"))[0].hasDependencyTree, true);
    assert.equal((await scanner.execute()).resolvedTreeCount, 0);
    assert.equal((await scanner.execute()).resolvedTreeCount, 0);
    const saved = await reloaded.getDependencyTree("root", "1.2.3", "commit-a");
    assert.equal(saved.root.version, "1.2.3");
    assert.equal(saved.find("child", "19.1.75").dependenciesResolved, false);
    assert.equal(saved.find("descendant", "unknown").dependenciesResolved, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed background jobs stop after three attempts without blocking older tags", async () => {
  const attempts = [];
  const events = [];
  const failure = new Error("Repository unavailable");
  const scanner = new ScanProjectDependencies(
    createProjectRegistry(() => [{ id: "root" }]),
    { getAvailableVersions: async () => ["2.0.0", "1.0.0"].map(version => new Version(version, null, version)) },
    {
      resolve: async (projectId, version) => {
        attempts.push(version);
        if (version === "2.0.0") throw failure;
        return new DependencyTree(new DependencyNode(projectId, "Root", version));
      },
    }
  );
  for (let pass = 0; pass < 6; pass += 1) {
    await scanner.refreshTags();
    const result = await scanner.buildDependencyTrees(() => false, event => events.push(event));
    assert.equal(result.failures.length, pass < 3 ? 1 : 0);
    if (pass < 3) assert.equal(result.failures[0].error, failure);
  }
  assert.deepEqual(attempts, ["2.0.0", "1.0.0", "2.0.0", "2.0.0"]);
  const failures = events.filter(event => event.event === "failed");
  assert.deepEqual(failures.map(event => event.attempt), [1, 2, 3]);
  assert.ok(failures.every(event => event.maximumAttempts === 3));
  assert.deepEqual(failures.map(event => event.retryExhausted), [false, false, true]);
  assert.equal(scanner.pendingTreeCount, 0);
});

test("moved commits and changed nested configuration become eligible again", async () => {
  const child = new Project("child", "Child", "https://example.com/child.git");
  const project = new Project("root", "Root", "https://example.com/root.git", null, [
    new ProjectDependency(child, "package.json", /^child$/),
  ]);
  let commitHash = "commit-a";
  const attempts = [];
  const scanner = new ScanProjectDependencies(
    new ProjectRegistry([project]),
    { getAvailableVersions: async () => [new Version("1.2.3", null, commitHash)] },
    {
      resolve: async (projectId, version) => {
        attempts.push(version);
        return new DependencyTree(new DependencyNode(projectId, "Root", version));
      },
    }
  );
  await scanner.execute();
  await scanner.execute();
  assert.equal(attempts.length, 1);
  project.dependencies[0].versionReference = /^other$/i;
  await scanner.execute();
  assert.equal(attempts.length, 2);
  commitHash = "commit-b";
  await scanner.execute();
  assert.equal(attempts.length, 3);
  await scanner.execute();
  assert.equal(attempts.length, 3);
});

test("a temporarily removed tag retains its exhausted session retry budget", async () => {
  let versions = [new Version("1.2.3", null, "commit-a")];
  let attempts = 0;
  const scanner = new ScanProjectDependencies(
    createProjectRegistry(() => [{ id: "root" }]),
    { getAvailableVersions: async () => versions },
    { resolve: async () => { attempts += 1; throw new Error("Repository unavailable"); } }
  );
  for (let pass = 0; pass < 3; pass += 1) {
    assert.equal((await scanner.execute()).failures.length, 1);
  }
  versions = [];
  await scanner.execute();
  versions = [new Version("1.2.3", null, "commit-a")];
  assert.equal((await scanner.execute()).failures.length, 0);
  assert.equal(attempts, 3);
  versions = [new Version("1.2.3", null, "commit-b")];
  assert.equal((await scanner.execute()).failures.length, 1);
  assert.equal(attempts, 4);
});

test("an in-flight old configuration does not suppress its replacement job", async () => {
  const project = new Project("root", "Root", "https://example.com/root.git");
  const pending = deferred();
  const attempts = [];
  const scanner = new ScanProjectDependencies(
    new ProjectRegistry([project]),
    { getAvailableVersions: async () => [new Version("1.2.3", null, "commit-a")] },
    {
      resolve: async (projectId, version) => {
        attempts.push(project.repoUrl);
        if (attempts.length === 1) await pending.promise;
        return new DependencyTree(new DependencyNode(projectId, "Root", version));
      },
    }
  );
  await scanner.refreshTags();
  const building = scanner.buildDependencyTrees();
  try {
    project.repoUrl = "https://example.com/replacement.git";
    await scanner.refreshTags();
    assert.equal(scanner.pendingTreeCount, 1);
  } finally {
    pending.resolve();
    await building;
  }
  assert.deepEqual(attempts, ["https://example.com/root.git", "https://example.com/replacement.git"]);
  await scanner.execute();
  assert.equal(attempts.length, 2);
});

test("stops tree processing between jobs without starting another tree", async () => {
  let stopped = false;
  const attempts = [];
  const scanner = new ScanProjectDependencies(
    createProjectRegistry(() => [{ id: "first" }, { id: "second" }]),
    {
      getAvailableVersions: async () => ["2.0.0", "1.0.0"]
        .map(version => new Version(version, null, null)),
    },
    {
      resolve: async (projectId, version) => {
        attempts.push(`${projectId}@${version}`);
        stopped = true;
        return new DependencyTree(new DependencyNode(projectId, projectId, version));
      },
    }
  );

  assert.deepEqual(await scanner.execute(() => stopped), {
    projectCount: 2, tagCount: 4, resolvedTreeCount: 1, failures: [],
  });
  assert.deepEqual(attempts, ["first@2.0.0"]);
  assert.deepEqual(await scanner.execute(() => true), emptyResult());
});

test("a refreshed recent tag outranks older queued tags without interrupting the active tree", async () => {
  const pendingTree = deferred();
  const projects = [{ id: "first" }, { id: "second" }];
  const tags = {
    first: [
      new Version("3.0.0", new Date("2026-10-20T08:00:00Z"), "first-new"),
      new Version("2.0.0", new Date("2026-10-19T08:00:00Z"), "first-old"),
    ],
    second: [new Version("1.0.0", new Date("2026-10-18T08:00:00Z"), "second-old")],
  };
  const attempts = [];
  const scanner = new ScanProjectDependencies(
    createProjectRegistry(() => projects),
    { getAvailableVersions: async projectId => tags[projectId] },
    {
      resolve: async (projectId, version) => {
        attempts.push(`${projectId}@${version}`);
        if (attempts.length === 1) await pendingTree.promise;
        return new DependencyTree(new DependencyNode(projectId, projectId, version));
      },
    }
  );

  await scanner.refreshTags();
  const building = scanner.buildDependencyTrees();
  try {
    assert.deepEqual(attempts, ["first@3.0.0"]);
    tags.second.push(new Version("0.5.0", new Date("2026-10-21T08:00:00Z"), "second-recent"));
    await scanner.refreshTags();
    await scanner.refreshTags();
    assert.equal(scanner.pendingTreeCount, 3);
    assert.deepEqual(await scanner.buildDependencyTrees(), emptyResult());
    assert.deepEqual(attempts, ["first@3.0.0"]);
  } finally {
    pendingTree.resolve();
    await building;
  }
  assert.deepEqual(attempts, [
    "first@3.0.0", "second@0.5.0", "first@2.0.0", "second@1.0.0",
  ]);
  assert.equal(scanner.pendingTreeCount, 0);
});

test("refresh removes obsolete pending commits, removed tags, and deleted projects", async () => {
  const projects = [{ id: "root" }];
  let versions = [new Version("v1", null, "old-commit")];
  const attempts = [];
  const scanner = new ScanProjectDependencies(
    createProjectRegistry(() => projects),
    { getAvailableVersions: async () => versions },
    {
      resolve: async (projectId, version) => {
        attempts.push(version);
        return new DependencyTree(new DependencyNode(projectId, projectId, version));
      },
    }
  );
  await scanner.refreshTags();
  versions = [new Version("v1", null, "new-commit")];
  await scanner.refreshTags();
  assert.equal(scanner.pendingTreeCount, 1);
  versions = [new Version("v1", null, "new-commit", true)];
  await scanner.refreshTags();
  assert.equal(scanner.pendingTreeCount, 0);
  versions = [new Version("v2", null, "another-commit")];
  await scanner.refreshTags();
  projects.length = 0;
  await scanner.refreshTags();
  assert.equal(scanner.pendingTreeCount, 0);
  await scanner.buildDependencyTrees();
  assert.deepEqual(attempts, []);
});

test("parallel tag refreshes respect the worker limit and recover from project failures", async () => {
  const releases = Array.from({ length: 3 }, deferred);
  const projects = ["first", "second", "third"].map(id => ({ id }));
  const started = [];
  let active = 0;
  let maximumActive = 0;
  const scanner = new ScanProjectDependencies(
    createProjectRegistry(() => projects),
    {
      getAvailableVersions: async projectId => {
        const index = projects.findIndex(project => project.id === projectId);
        started.push(projectId);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          await releases[index].promise;
          if (projectId === "first") throw new Error("Remote unavailable");
          return [new Version("1.0.0", null, projectId)];
        } finally {
          active -= 1;
        }
      },
    },
    { resolve: async () => assert.fail("Tag refresh must not build trees") },
    2
  );
  const refreshing = scanner.refreshTags();
  try {
    assert.deepEqual(started, ["first", "second"]);
    releases[0].resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(started, ["first", "second", "third"]);
    assert.equal(maximumActive, 2);
  } finally {
    releases.forEach(release => release.resolve());
  }
  const result = await refreshing;
  assert.equal(result.failures.length, 1);
  assert.equal(result.projectCount, 3);
  assert.equal(result.tagCount, 2);
});

test("parallel same-project trees prioritize dates and wake idle workers for lower-numbered new tags", async () => {
  const releases = new Map(["3.0.0", "2.0.0", "1.0.0", "0.5.0"].map(version => [version, deferred()]));
  const versions = [
    new Version("3.0.0", new Date("2026-10-22T08:00:00Z"), "3.0.0"),
    new Version("2.0.0", new Date("2026-10-21T08:00:00Z"), "2.0.0"),
    new Version("1.0.0", new Date("2026-10-20T08:00:00Z"), "1.0.0"),
  ];
  const attempts = [];
  let active = 0;
  let maximumActive = 0;
  const scanner = new ScanProjectDependencies(
    createProjectRegistry(() => [{ id: "root" }]),
    { getAvailableVersions: async () => [...versions] },
    {
      resolve: async (projectId, version) => {
        attempts.push(version);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          await releases.get(version).promise;
          return new DependencyTree(new DependencyNode(projectId, projectId, version));
        } finally {
          active -= 1;
        }
      },
    },
    2
  );
  await scanner.refreshTags();
  const building = scanner.buildDependencyTrees();
  try {
    assert.deepEqual(attempts, ["3.0.0", "2.0.0"]);
    versions.push(new Version("0.5.0", new Date("2026-10-23T08:00:00Z"), "0.5.0"));
    await scanner.refreshTags();
    releases.get("3.0.0").resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(attempts, ["3.0.0", "2.0.0", "0.5.0"]);
    releases.get("0.5.0").resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(attempts, ["3.0.0", "2.0.0", "0.5.0", "1.0.0"]);
    releases.get("1.0.0").resolve();
    await new Promise(resolve => setImmediate(resolve));
    versions.splice(0, versions.length,
      new Version("2.0.0", new Date("2026-10-21T08:00:00Z"), "2.0.0"),
      new Version("0.1.0", new Date("2026-10-24T08:00:00Z"), "0.1.0"));
    releases.set("0.1.0", deferred());
    await scanner.refreshTags();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(attempts, ["3.0.0", "2.0.0", "0.5.0", "1.0.0", "0.1.0"]);
    assert.equal(maximumActive, 2);
    assert.equal(scanner.activeTreeCount, 2);
    assert.deepEqual(await scanner.buildDependencyTrees(), emptyResult());
  } finally {
    releases.forEach(release => release.resolve());
    await building;
  }
  assert.equal(scanner.activeTreeCount, 0);
  assert.equal(scanner.pendingTreeCount, 0);
});

test("parallel shutdown waits for active trees without starting pending jobs", async context => {
  const clock = mockSchedulerTimer(context);
  const pending = deferred();
  const attempts = [];
  const scanner = new ScanProjectDependencies(
    createProjectRegistry(() => [{ id: "root" }]),
    { getAvailableVersions: async () => ["3.0.0", "2.0.0", "1.0.0"].map(version => new Version(version, null, version)) },
    {
      resolve: async (projectId, version) => {
        attempts.push(version);
        await pending.promise;
        return new DependencyTree(new DependencyNode(projectId, projectId, version));
      },
    },
    2
  );
  const scheduler = new ScanScheduler(scanner, 60_000, clock.log);
  try {
    scheduler.start();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(attempts, ["3.0.0", "2.0.0"]);
    let stopped = false;
    const stopping = scheduler.stop().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false);
    pending.resolve();
    await stopping;
    assert.equal(stopped, true);
    assert.deepEqual(attempts, ["3.0.0", "2.0.0"]);
    assert.equal(scanner.activeTreeCount, 0);
  } finally {
    pending.resolve();
    await scheduler.stop();
  }
});

test("ready-clone revision checks overlap for different versions of the same project", async () => {
  const pendingChecks = deferred();
  const project = new Project("root", "Root", "https://example.com/root.git");
  const checkedRefs = [];
  let syncCount = 0;
  const resolver = new DependencyResolverService(
    new ProjectRegistry([project]),
    {
      hasClone: async () => true,
      hasRef: async (_repoPath, ref) => {
        checkedRefs.push(ref);
        await pendingChecks.promise;
        return true;
      },
      syncTags: async () => { syncCount += 1; throw new Error("Ready clones must not fetch"); },
    },
    [],
    "unused-clone-root"
  );
  const resolving = Promise.all([resolver.resolve("root", "2.0.0"), resolver.resolve("root", "1.0.0")]);
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(checkedRefs, ["2.0.0", "1.0.0"]);
    assert.equal(syncCount, 0);
  } finally {
    pendingChecks.resolve();
  }
  assert.deepEqual((await resolving).map(tree => tree.root.version), ["2.0.0", "1.0.0"]);
});

test("missing clones retain serialized preparation across concurrent versions", async () => {
  const pendingSync = deferred();
  const project = new Project("root", "Root", "https://example.com/root.git");
  let ready = false;
  let syncCount = 0;
  const resolver = new DependencyResolverService(
    new ProjectRegistry([project]),
    {
      hasClone: async () => ready,
      hasRef: async () => ready,
      syncTags: async (_repoUrl, targetPath) => {
        syncCount += 1;
        await pendingSync.promise;
        ready = true;
        return targetPath;
      },
      getTags: async () => [],
    },
    [],
    "unused-clone-root"
  );
  const resolving = Promise.all([resolver.resolve("root", "2.0.0"), resolver.resolve("root", "1.0.0")]);
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(syncCount, 1);
  } finally {
    pendingSync.resolve();
  }
  assert.equal((await resolving).length, 2);
  assert.equal(syncCount, 1);
});

test("tree-job logs expose priority dates, overlapping jobs, durations, and failures", async context => {
  const clock = mockSchedulerTimer(context);
  const pendingTrees = deferred();
  const creationDates = {
    "2.0.0": "2026-10-23T08:00:00.000Z",
    "1.0.0": "2026-10-22T08:00:00.000Z",
  };
  const scanner = new ScanProjectDependencies(
    createProjectRegistry(() => [{ id: "root" }]),
    {
      getAvailableVersions: async () => Object.entries(creationDates)
        .map(([version, date]) => new Version(version, new Date(date), version)),
    },
    {
      resolve: async (projectId, version) => {
        await pendingTrees.promise;
        if (version === "1.0.0") throw new Error("Build failed");
        return new DependencyTree(new DependencyNode(projectId, projectId, version));
      },
    },
    2
  );
  const scheduler = new ScanScheduler(scanner, 60_000, clock.log);
  try {
    scheduler.start();
    await new Promise(resolve => setImmediate(resolve));
    const starts = clock.log.debug.mock.calls
      .filter(call => call.arguments[1] === "Dependency tree job started.")
      .map(call => call.arguments[0]);
    assert.deepEqual(starts.map(event => event.activeTreeCount), [1, 2]);
    assert.deepEqual(starts.map(event => event.version), ["2.0.0", "1.0.0"]);
    assert.deepEqual(starts.map(event => event.creationDate), Object.values(creationDates));
    pendingTrees.resolve();
    await new Promise(resolve => setImmediate(resolve));
    const endings = clock.log.debug.mock.calls
      .filter(call => ["Dependency tree job completed.", "Dependency tree job failed."].includes(call.arguments[1]))
      .map(call => call.arguments[0]);
    assert.equal(endings.length, 2);
    assert.equal(endings.filter(event => event.event === "failed").length, 1);
    assert.ok(endings.every(event => event.projectId === "root" && event.durationMs >= 0 &&
      event.creationDate === creationDates[event.version]));
    assert.equal(clock.errors.mock.callCount(), 1);
    assert.equal(clock.errors.mock.calls[0].arguments[0].creationDate, creationDates["1.0.0"]);
  } finally {
    pendingTrees.resolve();
    await scheduler.stop();
  }
});

test("a failed tree logs its cause before the other active trees finish", async context => {
  const clock = mockSchedulerTimer(context);
  const pendingTree = deferred();
  const failure = new Error('Version "19.1.75" was not found in "https://example.com/child.git".');
  const scanner = new ScanProjectDependencies(
    createProjectRegistry(() => [{ id: "root" }]),
    { getAvailableVersions: async () => ["2.0.0", "1.0.0"].map(version => new Version(version, null, version)) },
    {
      resolve: async (projectId, version) => {
        if (version === "2.0.0") throw failure;
        await pendingTree.promise;
        return new DependencyTree(new DependencyNode(projectId, projectId, version));
      },
    },
    2
  );
  const scheduler = new ScanScheduler(scanner, 60_000, clock.log);
  try {
    scheduler.start();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(scanner.activeTreeCount, 1);
    assert.equal(clock.errors.mock.callCount(), 1);
    const details = clock.errors.mock.calls[0].arguments[0];
    assert.equal(details.err, failure);
    assert.equal(details.version, "2.0.0");
    assert.equal(details.projectId, "root");
    assert.equal(details.creationDate, null);
    assert.ok(details.durationMs >= 0);
    pendingTree.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(scanner.activeTreeCount, 0);
    assert.equal(clock.errors.mock.callCount(), 1);
  } finally {
    pendingTree.resolve();
    await scheduler.stop();
  }
});

test("version lookup filters fetched tags before passing them to persistence", async () => {
  const pattern = "^\\d+\\.\\d+\\.\\d+(-patch\\.\\d+)?$";
  const project = new Project("root", "Root", "https://example.com/root.git", null, [], pattern);
  const registry = new ProjectRegistry([project]);
  const tags = ["3.3.0", "3.3.0-patch.1", "3.3.0-PR-5049.3"];
  let persistedNames;
  let persistedPattern;
  const store = {
    syncProjectTags: async (projectId, versions, tagPattern) => {
      persistedNames = versions.map(version => version.version);
      persistedPattern = tagPattern;
      return reconcileProjectTags(projectId, [], versions, tagPattern);
    },
    getAvailableVersions: async () => [],
  };
  const gitClient = {
    syncTags: async (_repoUrl, targetPath) => targetPath,
    getTags: async () => tags.map(name => new Version(name, null, null)),
  };
  const locator = new VersionLocatorService(registry, gitClient, store, "unused-clone-root");
  assert.deepEqual((await locator.getAvailableVersions("root")).map(version => version.version), [
    "3.3.0-patch.1", "3.3.0",
  ]);
  assert.deepEqual(persistedNames, ["3.3.0", "3.3.0-patch.1"]);
  assert.equal(persistedPattern, pattern);
});

test("version lookup keeps prefixed and unprefixed identities distinct in fresh and cached catalogs", async () => {
  for (const source of ["fresh", "local", "persisted"]) {
    for (const [requested, alternate] of [["5.3.0", "v5.3.0"], ["v5.3.0", "5.3.0"]]) {
      const project = new Project("root", "Root", "https://example.com/root.git", null, null,
        "^v?\\d+\\.\\d+\\.\\d+$");
      let tags = [
        new Version(alternate, new Date("2026-10-25T00:00:00Z"), "alternate"),
        new Version(requested, new Date("2026-10-24T00:00:00Z"), "exact"),
      ];
      const store = source === "persisted" ? {
        getProjectTags: async () => reconcileProjectTags("root", [], tags),
        getAvailableVersions: async () => [],
        syncProjectTags: async (projectId, discovered, pattern) =>
          reconcileProjectTags(projectId, [], discovered, pattern),
      } : undefined;
      const locator = new VersionLocatorService(new ProjectRegistry([project]), {
        hasClone: async () => source === "local",
        syncTags: async (_repoUrl, targetPath) => targetPath,
        getTags: async () => [...tags],
      }, store, "unused-clone-root");

      const exact = await locator.resolveVersion("root", requested);
      assert.equal(exact.version, requested, source);
      assert.equal(exact.commitHash, "exact", source);
      tags = tags.filter(tag => tag.version !== requested);
      assert.equal(await locator.resolveVersion("root", requested), null, source);
      assert.equal((await locator.resolveVersion("root", alternate)).version, alternate, source);
    }
  }
});

test("tag patterns explicitly choose prefixed tags, unprefixed tags, or both", async () => {
  for (const [pattern, expected] of [
    ["^v\\d+\\.\\d+\\.\\d+$", ["v5.3.0"]],
    ["^\\d+\\.\\d+\\.\\d+$", ["5.3.0"]],
    ["^v?\\d+\\.\\d+\\.\\d+$", ["5.3.0", "v5.3.0"]],
  ]) {
    const project = new Project("root", "Root", "https://example.com/root.git", null, null, pattern);
    const locator = new VersionLocatorService(new ProjectRegistry([project]), {
      hasClone: async () => true,
      syncTags: async (_repoUrl, targetPath) => targetPath,
      getTags: async () => ["v5.3.0", "5.3.0"].map(name => new Version(name)),
    }, undefined, "unused-clone-root");
    for (const versions of [
      await locator.getAvailableVersions("root"),
      await locator.getCachedVersions("root"),
    ]) {
      assert.deepEqual(versions.map(version => version.version).sort(), expected);
    }
  }
});

test("persists matching tags, retains removed trees, and survives refresh failure", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dependency-scan-"));
  try {
    const store = new JsonFileDataStore(
      path.join(directory, "trees.json"), path.join(directory, "projects.json")
    );
    const project = new Project("root", "Root", "https://example.com/root.git", null, [], "^v");
    await store.saveProject(project);
    const registry = new ProjectRegistry([project]);
    const tags = ["v2.0.0", "v1.0.0", "ignored"];
    const resolvedRefs = [];
    let syncCount = 0;
    let refreshFailed = false;
    const gitClient = {
      syncTags: async (_repoUrl, targetPath) => {
        if (refreshFailed) throw new Error("Remote unavailable");
        syncCount += 1;
        return targetPath;
      },
      getTags: async () => tags.map(version => new Version(version, null, null)),
      hasClone: async () => true,
      hasRef: async (_repoPath, ref) => { resolvedRefs.push(ref); return true; },
    };
    const cloneRoot = path.join(directory, "clones");
    const scanner = new ScanProjectDependencies(
      registry,
      new VersionLocatorService(registry, gitClient, store, cloneRoot),
      new DependencyResolverService(registry, gitClient, [], cloneRoot, store)
    );

    assert.deepEqual(await scanner.execute(), {
      projectCount: 1, tagCount: 2, resolvedTreeCount: 2, failures: [],
    });
    await store.saveDependencyTree(
      "root", "v1.0.0", new DependencyTree(new DependencyNode("root", "Root", "unknown"))
    );
    tags.push("v3.0.0");
    assert.deepEqual(await scanner.execute(), {
      projectCount: 1, tagCount: 3, resolvedTreeCount: 1, failures: [],
    });

    assert.equal(syncCount, 2);
    assert.deepEqual(resolvedRefs, ["v2.0.0", "v1.0.0", "v3.0.0"]);
    const reloadedStore = new JsonFileDataStore(
      path.join(directory, "trees.json"), path.join(directory, "projects.json")
    );
    assert.deepEqual(await reloadedStore.getAvailableVersions("root"), ["v3.0.0", "v2.0.0", "v1.0.0"]);
    assert.equal((await reloadedStore.getDependencyTree("root", "v1.0.0")).root.version, "unknown");
    assert.equal((await reloadedStore.getDependencyTree("root", "v3.0.0")).root.version, "v3.0.0");
    assert.deepEqual(
      (await store.getProjectTags("root")).map(tag => tag.name).sort(),
      tags.filter(tag => tag.startsWith("v")).sort()
    );

    tags.splice(tags.indexOf("v3.0.0"), 1);
    assert.deepEqual(await scanner.execute(), {
      projectCount: 1, tagCount: 2, resolvedTreeCount: 0, failures: [],
    });
    assert.equal((await store.getProjectTag("root", "v3.0.0")).removed, true);
    const offlineGit = {
      hasClone: async () => { throw new Error("Cached listing must not use Git"); },
      syncTags: async () => { throw new Error("Cached listing must not use Git"); },
    };
    const offlineLocator = new VersionLocatorService(registry, offlineGit, reloadedStore, cloneRoot);
    const cached = await offlineLocator.getCachedVersions("root");
    assert.equal(cached.find(version => version.version === "v3.0.0").removed, true);
    assert.equal(cached.find(version => version.version === "v3.0.0").hasDependencyTree, true);
    assert.equal((await offlineLocator.resolveVersion("root", "v3.0.0")).removed, true);
    const offlineResolver = new DependencyResolverService(registry, offlineGit, [], cloneRoot, reloadedStore);
    assert.equal((await offlineResolver.resolve("root", "v3.0.0")).root.version, "v3.0.0");
    const locator = new VersionLocatorService(registry, gitClient, store, cloneRoot);
    assert.equal((await locator.resolveVersion("root", "latest")).version, "v2.0.0");

    const previousCatalog = await store.getProjectTags("root");
    refreshFailed = true;
    await assert.rejects(locator.getAvailableVersions("root"), /Remote unavailable/);
    assert.deepEqual(await store.getProjectTags("root"), previousCatalog);
    refreshFailed = false;
    tags.push("v3.0.0");
    await locator.getAvailableVersions("root");
    assert.equal((await store.getProjectTag("root", "v3.0.0")).removed, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("background refresh persists every regex-matching dependency tag and updates nested catalogs independently of trees", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nested-tag-catalog-"));
  try {
    const treeFile = path.join(directory, "trees.json");
    const projectFile = path.join(directory, "projects.json");
    const store = new JsonFileDataStore(treeFile, projectFile);
    const leaf = new Project("leaf", "Leaf", "https://example.com/leaf.git", null, null, "^release-");
    const child = new Project("child", "Child", "https://example.com/child.git", null, [
      new ProjectDependency(leaf, "package.json", "leaf"),
    ], "^v\\d+\\.\\d+\\.\\d+$");
    const root = new Project("root", "Root", "https://example.com/root.git", null, [
      new ProjectDependency(child, "package.json", "child"),
    ], "^root-");
    await store.saveProject(root);
    const registry = new ProjectRegistry([root]);
    const tags = {
      root: ["root-1", "ignored"],
      child: ["v1.0.0", "v2.0.0", "v3.0.0", "ignored"],
      leaf: ["release-1.0.0", "release-2.0.0", "ignored"],
    };
    const refreshes = [];
    const locator = new VersionLocatorService(registry, {
      syncTags: async (repoUrl, targetPath, tagPattern) => {
        refreshes.push([repoUrl, tagPattern]);
        return targetPath;
      },
      getTags: async repoPath => tags[path.basename(repoPath)].map(version => new Version(version, null, version)),
    }, store, path.join(directory, "clones"));
    const built = [];
    const scanner = new ScanProjectDependencies(registry, locator, {
      resolve: async (projectId, version) => {
        built.push([projectId, version]);
        const tree = new DependencyTree(new DependencyNode(projectId, "Root", version, [
          new DependencyNode("child", "Child", "v1.0.0", [
            new DependencyNode("leaf", "Leaf", "release-1.0.0"),
          ]),
        ]));
        await store.saveDependencyTree(projectId, version, tree, version, root);
        return tree;
      },
    }, 2);

    assert.deepEqual(await scanner.execute(), {
      projectCount: 3, tagCount: 6, resolvedTreeCount: 1, failures: [],
    });
    assert.deepEqual((await store.getProjectTags("child")).map(tag => tag.name).sort(),
      ["v1.0.0", "v2.0.0", "v3.0.0"]);
    assert.deepEqual((await store.getProjectTags("leaf")).map(tag => tag.name).sort(),
      ["release-1.0.0", "release-2.0.0"]);
    assert.deepEqual(await store.getAvailableVersions("child"), []);
    assert.deepEqual(await store.getAvailableVersions("leaf"), []);

    tags.child = ["v2.0.0", "v3.0.0", "v4.0.0", "ignored"];
    tags.leaf.push("release-3.0.0");
    assert.deepEqual(await scanner.execute(), {
      projectCount: 3, tagCount: 7, resolvedTreeCount: 0, failures: [],
    });
    assert.deepEqual(built, [["root", "root-1"]]);
    assert.equal(refreshes.length, 6);
    for (const project of [root, child, leaf]) {
      assert.equal(refreshes.filter(([repoUrl, pattern]) =>
        repoUrl === project.repoUrl && pattern === project.tagPattern).length, 2);
    }

    const reloaded = new JsonFileDataStore(treeFile, projectFile);
    assert.equal((await reloaded.getProjectTag("child", "v1.0.0")).removed, true);
    assert.equal((await reloaded.getProjectTag("child", "v4.0.0")).removed, false);
    const response = captureResponse();
    await new VersionController(new GetDependencyVersion(locator, true)).getAvailableVersions({
      params: { projectId: "child" }, query: {},
    }, response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body.versions.map(version => version.version), ["v4.0.0", "v3.0.0", "v2.0.0", "v1.0.0"]);
    assert.ok(response.body.versions.every(version => !version.hasDependencyTree));
    assert.equal(response.body.latest.version, "v4.0.0");
    assert.equal(refreshes.length, 6);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stores discovered tags even when their trees fail and skips removed metadata-only entries", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "failed-tag-tree-"));
  try {
    const store = new JsonFileDataStore(path.join(directory, "trees.json"), path.join(directory, "projects.json"));
    const project = new Project("root", "Root", "https://example.com/root.git");
    await store.saveProject(project);
    const registry = new ProjectRegistry([project]);
    let tags = [new Version("v1", null, "commit-a")];
    const gitClient = {
      syncTags: async (_repoUrl, targetPath) => targetPath,
      getTags: async () => tags,
    };
    const locator = new VersionLocatorService(registry, gitClient, store, directory);
    let attempts = 0;
    const scanner = new ScanProjectDependencies(registry, locator, {
      resolve: async () => { attempts += 1; throw new Error("Invalid manifest"); },
    });
    assert.equal((await scanner.execute()).failures.length, 1);
    assert.equal((await store.getProjectTag("root", "v1")).removed, false);
    assert.equal((await locator.getCachedVersions("root"))[0].hasDependencyTree, false);
    tags = [];
    assert.deepEqual(await scanner.execute(), {
      projectCount: 1, tagCount: 0, resolvedTreeCount: 0, failures: [],
    });
    assert.equal(attempts, 1);
    const resolver = new DependencyResolverService(registry, gitClient, [], directory, store);
    await assert.rejects(resolver.resolve("root", "v1"), /removed and has no saved dependency tree/);
    assert.equal(await locator.resolveVersion("root", "latest"), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recomputes moved tags at their new commit and retains the previous snapshot", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "moved-tag-"));
  try {
    const store = new JsonFileDataStore(path.join(directory, "trees.json"), path.join(directory, "projects.json"));
    const project = new Project("root", "Root", "https://example.com/root.git");
    await store.saveProject(project);
    const registry = new ProjectRegistry([project]);
    let commitHash = "commit-a";
    const resolvedRefs = [];
    const gitClient = {
      syncTags: async (_repoUrl, targetPath) => targetPath,
      getTags: async () => [new Version("v1", null, commitHash)],
      hasClone: async () => true,
      hasRef: async (_repoPath, ref) => { resolvedRefs.push(ref); return true; },
    };
    const locator = new VersionLocatorService(registry, gitClient, store, directory);
    const resolver = new DependencyResolverService(registry, gitClient, [], directory, store);
    await locator.getAvailableVersions("root");
    await resolver.resolve("root", "v1");
    commitHash = "commit-b";
    await locator.getAvailableVersions("root");
    assert.equal((await locator.getCachedVersions("root"))[0].hasDependencyTree, false);
    await resolver.resolve("root", "v1");
    assert.deepEqual(resolvedRefs, ["commit-a", "commit-b"]);
    assert.equal((await store.getDependencyTree("root", "v1", "commit-a", true)).root.version, "v1");
    assert.equal((await store.getDependencyTree("root", "v1", "commit-b")).root.version, "v1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("version API exposes catalog metadata and excludes removed tags from latest", async () => {
  const creationDate = new Date("2026-10-14T08:00:00Z");
  const versions = [
    new Version("v3", creationDate, "commit-c", true, true),
    new Version("v2", creationDate, "commit-b", false, false),
  ];
  const refreshRequests = [];
  const controller = new VersionController({
    getAvailableVersions: async (_projectId, forceRefresh) => {
      refreshRequests.push(forceRefresh);
      return versions;
    },
  });
  for (const forceRefresh of ["false", "true"]) {
    const response = captureResponse();
    await controller.getAvailableVersions({ params: { projectId: "root" }, query: { forceRefresh } }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.latest.version, "v2");
    assert.equal(response.body.versions[0].removed, true);
    assert.equal(response.body.versions[0].hasDependencyTree, true);
    assert.equal(response.body.versions[0].creationDate, creationDate.toISOString());
    assert.equal(response.body.versions[0].commitHash, "commit-c");
    assert.deepEqual(Object.keys(response.body.versions[0]).sort(), [
      "version", "creationDate", "commitHash", "removed", "hasDependencyTree",
    ].sort());
  }
  assert.deepEqual(refreshRequests, [false, true]);
});

test("version listing follows scan configuration unless a source refresh is forced", async () => {
  for (const scanEnabled of [true, false]) {
    for (const forceRefresh of [undefined, "false", "true"]) {
      const requests = [];
      const storedVersions = [new Version("stored")];
      const sourceVersions = [new Version("source")];
      const locator = {
        getCachedVersions: async projectId => { requests.push(["stored", projectId]); return storedVersions; },
        getAvailableVersions: async projectId => { requests.push(["source", projectId]); return sourceVersions; },
      };
      const controller = new VersionController(new GetDependencyVersion(locator, scanEnabled));
      const response = captureResponse();
      const query = forceRefresh === undefined ? {} : { forceRefresh };
      await controller.getAvailableVersions({ params: { projectId: "root" }, query }, response);
      const expectedSource = scanEnabled && forceRefresh !== "true" ? "stored" : "source";
      assert.equal(response.statusCode, 200);
      assert.equal(response.body.versions[0].version, expectedSource);
      assert.deepEqual(requests, [[expectedSource, "root"]]);
    }
  }
});

test("an empty stored version list refreshes the source when scans are enabled", async () => {
  for (const forceRefresh of [undefined, "false"]) {
    const requests = [];
    const sourceVersions = [new Version("3.3.0", null, "commit-a")];
    const useCase = new GetDependencyVersion({
      getCachedVersions: async projectId => { requests.push(["stored", projectId]); return []; },
      getAvailableVersions: async projectId => { requests.push(["source", projectId]); return sourceVersions; },
    }, true);
    const controller = new VersionController(useCase);
    const response = captureResponse();
    const query = forceRefresh === undefined ? {} : { forceRefresh };
    await controller.getAvailableVersions({ params: { projectId: "root" }, query }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.versions[0].version, "3.3.0");
    assert.deepEqual(requests, [["stored", "root"], ["source", "root"]]);
  }
});

test("an empty source result is returned without repeated refreshes", async () => {
  let sourceRequests = 0;
  const useCase = new GetDependencyVersion({
    getCachedVersions: async () => [],
    getAvailableVersions: async () => { sourceRequests += 1; return []; },
  }, true);
  assert.deepEqual(await useCase.getAvailableVersions("root"), []);
  assert.equal(sourceRequests, 1);
});

test("an empty-cache refresh failure follows normal API error handling", async () => {
  const controller = new VersionController(new GetDependencyVersion({
    getCachedVersions: async () => [],
    getAvailableVersions: async () => { throw new Error("Remote unavailable"); },
  }, true));
  const response = captureResponse();
  await controller.getAvailableVersions({ params: { projectId: "root" }, query: {} }, response);
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.body, { error: "Remote unavailable" });
});

test("dependency API returns 404 for a removed tag without a saved tree", async () => {
  const controller = new DependencyController({
    execute: async () => { throw new Error('Tag "v1" was removed and has no saved dependency tree.'); },
  }, { addCreationDates: async tree => tree });
  const response = captureResponse();
  await controller.resolveDependencies({ params: { projectId: "root", version: "v1" }, query: {} }, response);
  assert.equal(response.statusCode, 404);
  assert.match(response.body.error, /removed and has no saved dependency tree/);
});

test("starts immediately, deduplicates tag refreshes, and waits for refresh on stop", async context => {
  const clock = mockSchedulerTimer(context);
  const pending = deferred();
  let runs = 0;
  let shouldStop;
  const scheduler = new ScanScheduler({
    refreshTags: stopRequested => {
      runs += 1;
      shouldStop = stopRequested;
      return pending.promise;
    },
    buildDependencyTrees: async () => { throw new Error("Trees must not start after shutdown"); },
    pendingTreeCount: 1,
  }, 60_000, clock.log);

  try {
    scheduler.start();
    scheduler.start();
    assert.equal(runs, 1);
    assert.equal(clock.interval.mock.callCount(), 1);
    assert.equal(clock.interval.mock.calls[0].arguments[1], 60_000);
    assert.equal(clock.log.debug.mock.calls[0].arguments[0], "Dependency tag refresh started.");
    clock.tick();
    assert.equal(runs, 1);
    assert.equal(
      clock.log.debug.mock.calls[1].arguments[0],
      "Tag refresh skipped: previous tag refresh is still running."
    );

    let finished = false;
    const stopping = scheduler.stop().then(() => { finished = true; });
    assert.equal(shouldStop(), true);
    assert.equal(clock.clear.mock.callCount(), 1);
    await Promise.resolve();
    assert.equal(finished, false);
    clock.tick();
    assert.equal(runs, 1);
    pending.resolve(emptyResult());
    await stopping;
    assert.equal(finished, true);
    assert.equal(clock.log.info.mock.callCount(), 1);
    const summary = clock.log.info.mock.calls[0].arguments[0];
    assert.equal(summary.phase, "tags");
    assert.equal(summary.status, "stopped");
    assert.equal(summary.failureCount, 0);
    assert.ok(summary.durationMs >= 0);
  } finally {
    pending.resolve(emptyResult());
    await scheduler.stop();
  }
});

test("tag refresh continues during tree processing and shutdown waits for both", async context => {
  const clock = mockSchedulerTimer(context);
  const pendingTree = deferred();
  const pendingRefresh = deferred();
  let refreshCount = 0;
  let treeCount = 0;
  let pendingTreeCount = 1;
  let treeShouldStop;
  let refreshShouldStop;
  const scheduler = new ScanScheduler({
    refreshTags: async shouldStop => {
      refreshCount += 1;
      refreshShouldStop = shouldStop;
      return refreshCount === 1 ? emptyResult() : pendingRefresh.promise;
    },
    buildDependencyTrees: shouldStop => {
      treeCount += 1;
      treeShouldStop = shouldStop;
      return pendingTree.promise;
    },
    get pendingTreeCount() { return pendingTreeCount; },
  }, 60_000, clock.log);

  try {
    scheduler.start();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(treeCount, 1);
    clock.tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(refreshCount, 2);
    assert.equal(treeCount, 1);
    clock.tick();
    assert.equal(refreshCount, 2);

    let stopped = false;
    const stopping = scheduler.stop().then(() => { stopped = true; });
    assert.equal(treeShouldStop(), true);
    assert.equal(refreshShouldStop(), true);
    pendingRefresh.resolve(emptyResult());
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false);
    pendingTreeCount = 0;
    pendingTree.resolve(emptyResult());
    await stopping;
    assert.equal(stopped, true);
    assert.equal(treeCount, 1);
    assert.equal(clock.errors.mock.callCount(), 0);
  } finally {
    pendingTreeCount = 0;
    pendingRefresh.resolve(emptyResult());
    pendingTree.resolve(emptyResult());
    await scheduler.stop();
  }
});

test("a scheduled refresh prioritizes a new tag while the current tree stays active", async context => {
  const clock = mockSchedulerTimer(context);
  const pendingTree = deferred();
  const versions = [
    new Version("2.0.0", new Date("2026-10-20T08:00:00Z"), "commit-two"),
    new Version("1.0.0", new Date("2026-10-19T08:00:00Z"), "commit-one"),
  ];
  const attempts = [];
  let refreshes = 0;
  let activeBuilds = 0;
  let maximumBuilds = 0;
  const scanner = new ScanProjectDependencies(
    createProjectRegistry(() => [{ id: "root" }]),
    { getAvailableVersions: async () => { refreshes += 1; return [...versions]; } },
    {
      resolve: async (projectId, version) => {
        attempts.push(version);
        activeBuilds += 1;
        maximumBuilds = Math.max(maximumBuilds, activeBuilds);
        try {
          if (attempts.length === 1) await pendingTree.promise;
          return new DependencyTree(new DependencyNode(projectId, projectId, version));
        } finally {
          activeBuilds -= 1;
        }
      },
    }
  );
  const scheduler = new ScanScheduler(scanner, 60_000, clock.log);
  try {
    scheduler.start();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(attempts, ["2.0.0"]);
    versions.push(new Version("0.5.0", new Date("2026-10-21T08:00:00Z"), "commit-recent"));
    clock.tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(refreshes, 2);
    assert.equal(scanner.pendingTreeCount, 2);
    assert.deepEqual(attempts, ["2.0.0"]);
    pendingTree.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(attempts, ["2.0.0", "0.5.0", "1.0.0"]);
    assert.equal(maximumBuilds, 1);
    assert.equal(scanner.pendingTreeCount, 0);
    assert.equal(clock.errors.mock.callCount(), 0);
  } finally {
    pendingTree.resolve();
    await scheduler.stop();
  }
});

test("a failed tag refresh is logged and later interval ticks still run", async context => {
  const clock = mockSchedulerTimer(context);
  let runs = 0;
  const scheduler = new ScanScheduler({
    refreshTags: async () => {
      runs += 1;
      if (runs === 1) {
        throw new Error("Scan failed");
      }
      return emptyResult();
    },
    buildDependencyTrees: async () => emptyResult(),
    pendingTreeCount: 0,
  }, 60_000, clock.log);

  try {
    scheduler.start();
    await new Promise(resolve => setImmediate(resolve));
    clock.tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(runs, 2);
    assert.equal(clock.errors.mock.callCount(), 1);
    assert.equal(clock.errors.mock.calls[0].arguments[0].err.message, "Scan failed");
    assert.equal(clock.errors.mock.calls[0].arguments[0].phase, "tags");
    assert.equal(clock.log.info.mock.callCount(), 1);
  } finally {
    await scheduler.stop();
  }
});

test("an unexpected tree-worker failure retries only after a later tag refresh", async context => {
  const clock = mockSchedulerTimer(context);
  let attempts = 0;
  let pendingTreeCount = 1;
  const scheduler = new ScanScheduler({
    refreshTags: async () => emptyResult(),
    buildDependencyTrees: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Worker failed");
      pendingTreeCount = 0;
      return emptyResult();
    },
    get pendingTreeCount() { return pendingTreeCount; },
  }, 60_000, clock.log);
  try {
    scheduler.start();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(attempts, 1);
    assert.equal(clock.errors.mock.calls[0].arguments[0].phase, "trees");
    clock.tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(attempts, 2);
  } finally {
    pendingTreeCount = 0;
    await scheduler.stop();
  }
});

test("scan verification supports arbitrary project names, nesting, siblings, and leaf projects", () => {
  const leaf = new Project("leaf", "Utility", "https://example.com/utility.git");
  const child = new Project("child", "Module", "https://example.com/module.git", null, [
    new ProjectDependency(leaf, "package.json", "utility"),
  ]);
  const sibling = new Project("sibling", "Utility", "https://example.com/other-utility.git", null, []);
  const project = new Project("root", "Product", "https://example.com/product.git", null, [
    new ProjectDependency(child, "package.json", "module"),
    new ProjectDependency(sibling, "package.json", "other-utility"),
  ]);
  const tree = new DependencyTree(new DependencyNode("root", "Product", "1.0.0", [
    new DependencyNode("child", "Module", "2.0.0", [
      new DependencyNode("leaf", "Utility", "3.0.0"),
    ]),
    new DependencyNode("sibling", "Utility", "4.0.0"),
  ]));

  assertCompleteScanTree(tree, project);
  assertCompleteScanTree(new DependencyTree(new DependencyNode("leaf", "Utility", "3.0.0")), leaf);
  assertCompleteScanTree(new DependencyTree(new DependencyNode("sibling", "Utility", "4.0.0")), sibling);
});

test("scan verification rejects missing, renamed, and unknown configured dependencies", () => {
  const child = new Project("child", "Shared name", "https://example.com/child.git");
  const project = new Project("root", "Shared name", "https://example.com/root.git", null, [
    new ProjectDependency(child, "package.json", "child"),
  ]);
  for (const dependencies of [
    [],
    [new DependencyNode("other", "Shared name", "2.0.0")],
    [new DependencyNode("child", "Renamed", "2.0.0")],
    [new DependencyNode("child", "Shared name", "unknown")],
  ]) {
    const tree = new DependencyTree(new DependencyNode("root", "Shared name", "1.0.0", dependencies));
    assert.throws(() => assertCompleteScanTree(tree, project), assert.AssertionError);
  }
});

test("live project scan persists real Git trees to an isolated JSON datastore", {
  skip: !process.env.SCAN_TEST_PROJECT,
  timeout: 540_000,
}, async context => {
  const fixture = JSON.parse(await readFile(process.env.SCAN_TEST_PROJECT, "utf8"));
  const dataRoot = path.resolve(__dirname, "../data");
  await mkdir(dataRoot, { recursive: true });
  const directory = await mkdtemp(path.join(dataRoot, "scan-verification-"));
  const originalDirectory = process.cwd();
  const environment = {
    DATASTORE: "json",
    GIT_MAX_CONCURRENCY: "4",
    DEPENDENCY_SCAN_ENABLED: "true",
    DEPENDENCY_SCAN_INTERVAL_MINUTES: "0.1",
    CLONE_ROOT: path.join(directory, "repositories"),
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
  };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  const enoughTrees = deferred();
  const savedTrees = [];
  const failures = [];
  const events = [];
  let maximumActiveTrees = 0;
  let activeGitCommands = 0;
  let maximumActiveGitCommands = 0;
  let tagRefreshesDuringTrees = 0;
  let projectId;
  let app;
  let server;
  let deadline;
  let failure;
  const startedAt = Date.now();
  const { GitCliClient } = require("../dist/infrastructure/git/GitCliClient");
  const saveTree = JsonFileDataStore.prototype.saveDependencyTree;
  const executeGit = GitCliClient.prototype.executeGit;
  context.mock.method(JsonFileDataStore.prototype, "saveDependencyTree", async function (...args) {
    await saveTree.apply(this, args);
    savedTrees.push({ projectId: args[0], version: args[1], commitHash: args[3] });
    if (savedTrees.length >= 3) enoughTrees.resolve();
  });
  context.mock.method(GitCliClient.prototype, "executeGit", async function (...args) {
    activeGitCommands += 1;
    maximumActiveGitCommands = Math.max(maximumActiveGitCommands, activeGitCommands);
    try {
      return await executeGit.apply(this, args);
    } finally {
      activeGitCommands -= 1;
    }
  });
  context.mock.method(logger, "debug", (details, message) => {
    if (typeof details === "object" && details?.phase === "trees") {
      maximumActiveTrees = Math.max(maximumActiveTrees, details.activeTreeCount);
      events.push({ elapsedMs: Date.now() - startedAt, message, ...details });
      if (details.event === "started") {
        console.log("LIVE tree started", details.version, "active", details.activeTreeCount);
      }
    }
  });
  context.mock.method(logger, "info", (details, message) => {
    if (typeof details === "object" && details?.phase === "tags") {
      if (details.activeTreeCount > 0) tagRefreshesDuringTrees += 1;
      events.push({ elapsedMs: Date.now() - startedAt, message, ...details });
      console.log("LIVE tags saved", details.tagCount, "active trees", details.activeTreeCount);
    }
  });
  context.mock.method(logger, "error", (details, message) => {
    failures.push({ message, projectId: details?.projectId, version: details?.version,
      error: details?.err instanceof Error ? details.err.message : String(details?.err ?? "") });
  });

  try {
    Object.assign(process.env, environment);
    process.chdir(directory);
    app = await createServer();
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}/api/projects`;
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fixture),
      signal: AbortSignal.timeout(15_000),
    });
    const created = await response.json();
    assert.equal(response.status, 201, JSON.stringify(created));
    projectId = created.id;
    assert.notEqual(projectId, fixture.id);
    app.locals.startBackgroundJobs();
    await Promise.race([
      enoughTrees.promise,
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error("No three saved trees within four minutes")), 240_000);
      }),
    ]);
    clearTimeout(deadline);
    await app.locals.stopBackgroundJobs();

    const treeDocument = JSON.parse(await readFile(path.join(directory, "data/dependency-trees.json"), "utf8"));
    const tagDocument = JSON.parse(await readFile(path.join(directory, "data/tags.json"), "utf8"));
    const versions = Object.keys(treeDocument.projects[projectId]?.versions ?? {});
    assert.ok(versions.length >= 3, "Expected at least three persisted version snapshots");
    assert.ok(tagDocument.projects[projectId].length >= versions.length);
    const tagPattern = new RegExp(created.tagPattern ?? "");
    assert.ok(tagDocument.projects[projectId].every(tag => tagPattern.test(tag.name)));
    assert.ok(maximumActiveTrees > 1, "Expected overlapping real tree jobs");
    assert.ok(maximumActiveGitCommands > 1 && maximumActiveGitCommands <= 4);
    const reopened = new JsonFileDataStore(
      path.join(directory, "data/dependency-trees.json"), path.join(directory, "data/projects.json")
    );
    for (const version of versions) {
      const tree = await reopened.getDependencyTree(projectId, version);
      assert.ok(tree, `Persisted ${version} could not be reloaded`);
      assertCompleteScanTree(tree, created);
    }
    console.log("LIVE JSON verification passed", JSON.stringify({
      projectId,
      tags: tagDocument.projects[projectId].length,
      savedVersions: versions.length,
      maximumActiveTrees,
      maximumActiveGitCommands,
      tagRefreshesDuringTrees,
      directory,
    }));
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    clearTimeout(deadline);
    try {
      await app?.locals.stopBackgroundJobs();
      if (server) await new Promise(resolve => server.close(resolve));
      await app?.locals.closeDataStore();
      await writeFile(path.join(directory, "verification.json"), JSON.stringify({
        projectId,
        elapsedMs: Date.now() - startedAt,
        failure: failure ?? null,
        maximumActiveTrees,
        maximumActiveGitCommands,
        tagRefreshesDuringTrees,
        savedTrees,
        failures,
        events,
      }, null, 2) + "\n");
      console.log("LIVE JSON artifacts", directory);
    } finally {
      process.chdir(originalDirectory);
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
});

test("server factory defers scanning and waits for the job before closing storage", async context => {
  const previousEnvironment = Object.fromEntries([
    "DATASTORE", "MONGODB_URI", "DEPENDENCY_SCAN_ENABLED", "DEPENDENCY_SCAN_INTERVAL_MINUTES",
  ].map(key => [key, process.env[key]]));
  const events = [];
  const pendingStop = deferred();
  for (const level of ["error", "warn", "info", "debug"]) {
    context.mock.method(logger, level, () => {});
  }
  context.mock.method(MongoDataStore, "connect", async () => ({
    getAllProjects: async () => [],
    close: async () => { events.push("closed"); },
  }));
  context.mock.method(ScanScheduler.prototype, "start", () => { events.push("started"); });
  context.mock.method(ScanScheduler.prototype, "stop", () => {
    events.push("stopping");
    return pendingStop.promise;
  });

  try {
    process.env.DATASTORE = "mongodb";
    process.env.MONGODB_URI = "mongodb://example.invalid";
    process.env.DEPENDENCY_SCAN_ENABLED = "true";
    process.env.DEPENDENCY_SCAN_INTERVAL_MINUTES = "15";
    const app = await createServer();
    assert.deepEqual(events, []);
    app.locals.startBackgroundJobs();
    assert.deepEqual(events, ["started"]);
    const closing = app.locals.closeDataStore();
    assert.deepEqual(events, ["started", "stopping"]);
    pendingStop.resolve();
    await closing;
    assert.deepEqual(events, ["started", "stopping", "closed"]);

    events.length = 0;
    process.env.DEPENDENCY_SCAN_ENABLED = "false";
    const disabledApp = await createServer();
    disabledApp.locals.startBackgroundJobs();
    await disabledApp.locals.stopBackgroundJobs();
    assert.deepEqual(events, []);
    await disabledApp.locals.closeDataStore();
    assert.deepEqual(events, ["closed"]);
  } finally {
    pendingStop.resolve();
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});