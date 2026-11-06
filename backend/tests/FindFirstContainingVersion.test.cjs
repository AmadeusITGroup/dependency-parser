const assert = require("node:assert/strict");
const { once } = require("node:events");
const { test } = require("node:test");
const express = require("express");

const {
  FindFirstContainingVersion,
  VersionSearchInputError,
} = require("../dist/application/use-cases/FindFirstContainingVersion");
const { FindRootVersion } = require("../dist/application/use-cases/FindRootVersion");
const { DependencyResolverService } = require("../dist/application/services/DependencyResolverService");
const { VersionNotFoundError } = require("../dist/domain/interfaces/IDependencyResolver");
const { DependencyNode } = require("../dist/domain/models/DependencyNode");
const { DependencyTree } = require("../dist/domain/models/DependencyTree");
const { Project } = require("../dist/domain/models/Project");
const { ProjectDependency } = require("../dist/domain/models/ProjectDependency");
const { Version } = require("../dist/domain/models/Version");
const { VersionSearchController } = require("../dist/interfaces/http/controllers/VersionSearchController");
const { createRoutes } = require("../dist/interfaces/http/routes/routes");

function createSearch(releases, dependencyVersions, options = {}) {
  const dependency = new Project("c", "c", "https://example.com/c.git", null, null,
    options.dependencyPattern ?? null);
  const intermediate = new Project("b", "b", "https://example.com/b.git", null, [
    new ProjectDependency(dependency, "package.json", "c"),
  ]);
  const project = new Project("a", "a", "https://example.com/a.git", null, [
    new ProjectDependency(intermediate, "package.json", "b"),
  ], options.tagPattern ?? null);
  const checked = [];
  const warnings = [];
  const resolver = {
    resolve: async (projectId, version) => {
      checked.push(version);
      const value = dependencyVersions[version];
      if (value instanceof Error) {
        throw value;
      }
      if (value instanceof DependencyTree) {
        return value;
      }
      const child = new DependencyNode("b", "b", "2.0.0", value === null ? [] : [
        new DependencyNode("c", "c", value),
      ]);
      return new DependencyTree(new DependencyNode(projectId, "a", version, [child]));
    },
  };
  const search = new FindFirstContainingVersion(
    { getProject: projectId => projectId === "a" ? project : null },
    {
      getAvailableVersions: async () => releases.map(release =>
        typeof release === "string" ? new Version(release, null) : release),
    },
    resolver,
    {
      debug: () => {},
      info: () => {},
      error: () => {},
      warn: (context, message) => warnings.push({ context, message }),
    }
  );
  return { search, checked, warnings, project, resolver };
}

test("newest-first search stops at the first non-match without resolving older broken trees", async () => {
  const { search, checked } = createSearch(["3.0.510", "3.1.0", "3.0.511", "3.1.1"], {
    "3.0.510": new Error('Dependency "Unrelated dependency" has an unknown version.'),
    "3.0.511": "1.0.1",
    "3.1.0": "1.1.1",
    "3.1.1": "1.1.3",
  });

  const result = await search.execute("a", "c", "1.0.9");

  assert.equal(result.match.version, "3.1.0");
  assert.equal(result.checkedVersions, 3);
  assert.deepEqual(checked, ["3.1.1", "3.1.0", "3.0.511"]);
});

test("newest-first search ignores unknown versions outside the requested dependency path", async () => {
  const tree = new DependencyTree(new DependencyNode("a", "a", "3.1.0", [
    new DependencyNode("unrelated", "Unrelated dependency", "unknown"),
    new DependencyNode("b", "b", "2.0.0", [new DependencyNode("c", "c", "1.1.1")]),
  ]));
  const { search, checked } = createSearch(["3.0.9", "3.1.0"], {
    "3.0.9": "1.0.1", "3.1.0": tree,
  });

  const result = await search.execute("a", "c", "1.0.9");

  assert.equal(result.match.version, "3.1.0");
  assert.equal(result.match.tree, tree);
  assert.deepEqual(checked, ["3.1.0", "3.0.9"]);
});

test("returns the first parent version in the newest matching run using numeric order, not Git dates", async () => {
  const { search, checked } = createSearch([
    new Version("3.1.1", new Date("2020-01-01")),
    new Version("3.1.0", new Date("2021-01-01")),
    new Version("3.0.9", new Date("2022-01-01")),
  ], { "3.1.1": "1.1.3", "3.1.0": "1.1.1", "3.0.9": "1.0.1" });

  const result = await search.execute("a", "c", "1.0.9");

  assert.equal(result.match.version, "3.1.0");
  assert.equal(result.match.dependencyVersion, "1.1.1");
  assert.deepEqual(result.match.path.map(node => node.projectId), ["a", "b", "c"]);
  assert.equal(result.match.tree.root.version, "3.1.0");
  assert.deepEqual(checked, ["3.1.1", "3.1.0", "3.0.9"]);
  assert.equal(result.checkedVersions, 3);
  assert.equal(result.totalVersions, 3);
});

test("returns the newest matching run without searching an older disconnected matching run", async () => {
  const { search, checked } = createSearch(["4.0.0", "3.0.0", "2.0.0", "1.0.0"], {
    "1.0.0": "1.0.0", "2.0.0": "1.0.9", "3.0.0": "0.9.0", "4.0.0": "1.1.0",
  });

  const result = await search.execute("a", "c", "1.0.9");

  assert.equal(result.match.version, "4.0.0");
  assert.equal(result.match.dependencyVersion, "1.1.0");
  assert.deepEqual(checked, ["4.0.0", "3.0.0"]);
});

test("compares major, minor, release, and optional patch captures from left to right", async () => {
  const pattern = "^release-(\\d+)\\.(\\d+)\\.(\\d+)(?:\\.(\\d+))?$";
  const { search, checked } = createSearch([
    "release-3.10.0", "release-3.2.9.1", "release-3.2.9",
  ], {
    "release-3.10.0": "fix-1.1.0", "release-3.2.9.1": "fix-1.0.9.1",
    "release-3.2.9": "fix-1.0.9",
  }, { tagPattern: pattern, dependencyPattern: pattern.replace("release-", "fix-") });

  const result = await search.execute("a", "c", "1.0.9.0");

  assert.equal(result.match.version, "release-3.2.9");
  assert.deepEqual(checked, ["release-3.10.0", "release-3.2.9.1", "release-3.2.9"]);
});

test("falls back to dotted numbers when a pattern only has unmatched optional captures", async () => {
  const tagPattern = "^\\d+\\.\\d+\\.\\d+(-patch\\.\\d+)?$";
  const { search, checked } = createSearch(["3.10.0", "3.2.0"], {
    "3.2.0": "1.0.1", "3.10.0": "1.1.0",
  }, { tagPattern, dependencyPattern: tagPattern });

  const result = await search.execute("a", "c", "1.0.9");

  assert.equal(result.match.version, "3.10.0");
  assert.deepEqual(checked, ["3.10.0", "3.2.0"]);
});

test("orders numbered suffixes independently of labels and capture-group structure", async () => {
  for (const label of ["patch", "fix", "hotfix", "revision"]) {
    for (const tagPattern of [
      null,
      `^\\d+\\.\\d+\\.\\d+(-${label}\\.\\d+)?$`,
      `^(\\d+)\\.(\\d+)\\.(\\d+)(-${label}\\.(\\d+))?$`,
      `^\\d+\\.\\d+\\.\\d+(?:-${label}\\.(\\d+))?$`,
      `^(\\d+\\.\\d+\\.\\d+(?:-${label}\\.\\d+)?)$`,
      `^\\d+\\.\\d+\\.\\d+(?:-${label}\\.\\d+)?$`,
    ]) {
      const first = `3.3.29-${label}.1`;
      const second = `3.3.29-${label}.2`;
      const twelfth = `3.3.29-${label}.12`;
      const { search, checked } = createSearch([
        "3.3.30", twelfth, second, first, "3.3.29",
      ], {
        "3.3.29": "19.1.0",
        [first]: "19.1.1",
        [second]: "19.2.0",
        [twelfth]: "19.3.0",
        "3.3.30": "20.0.0",
      }, { tagPattern });

      const result = await search.execute("a", "c", "19.2.0");

      assert.equal(result.match.version, second);
      assert.deepEqual(checked, ["3.3.30", twelfth, second, first]);
      assert.equal((await search.execute("a", "c", "19.3.0")).match.version, twelfth);
    }
  }
});

test("compares labeled dependency versions and minimums numerically from left to right", async () => {
  for (const label of ["patch", "fix", "revision"]) {
    const { search, checked } = createSearch(["1.0.3", "1.0.2", "1.0.1", "1.0.0"], {
      "1.0.0": "19.2.0",
      "1.0.1": `19.2.0-${label}.1`,
      "1.0.2": `19.2.0-${label}.2`,
      "1.0.3": `19.2.0-${label}.12`,
    }, { dependencyPattern: `^\\d+\\.\\d+\\.\\d+(-${label}\\.\\d+)?$` });

    const result = await search.execute("a", "c", `19.2.0-${label}.2`);

    assert.equal(result.match.version, "1.0.2");
    assert.equal(result.match.dependencyVersion, `19.2.0-${label}.2`);
    assert.deepEqual(checked, ["1.0.3", "1.0.2", "1.0.1"]);
    assert.equal((await search.execute("a", "c", `19.2.0-${label}.11`)).match.version, "1.0.3");
    assert.equal((await search.execute("a", "c", "19.2.1")).match, null);
  }
});

test("extracts digit sequences from arbitrary regex layouts without duplicating nested captures", async () => {
  const tagPattern = "^product_(\\d+)_r(\\d+)(?:_(fix(\\d+)_build(\\d+)))?$";
  const { search, checked } = createSearch([
    "product_3_r10", "product_3_r2_fix12_build1", "product_3_r2_fix2_build12",
    "product_3_r2_fix2_build2", "product_3_r2",
  ], {
    "product_3_r2": "1.0.0",
    "product_3_r2_fix2_build2": "1.0.1",
    "product_3_r2_fix2_build12": "1.0.2",
    "product_3_r2_fix12_build1": "1.0.3",
    "product_3_r10": "1.0.4",
  }, { tagPattern });

  const result = await search.execute("a", "c", "1.0.3");

  assert.equal(result.match.version, "product_3_r2_fix12_build1");
  assert.deepEqual(checked, ["product_3_r10", "product_3_r2_fix12_build1", "product_3_r2_fix2_build12"]);
});

test("preserves numeric ordering for version components larger than safe integers", async () => {
  const { search, checked } = createSearch(["1.0.9007199254740993", "1.0.9007199254740992"], {
    "1.0.9007199254740992": "1.0.9007199254740992",
    "1.0.9007199254740993": "1.0.9007199254740993",
  });

  const result = await search.execute("a", "c", "1.0.9007199254740993");

  assert.equal(result.match.version, "1.0.9007199254740993");
  assert.deepEqual(checked, ["1.0.9007199254740993", "1.0.9007199254740992"]);
});

test("checks other occurrences when the first occurrence is below the minimum", async () => {
  const tree = new DependencyTree(new DependencyNode("a", "a", "1.0.0", [
    new DependencyNode("b", "b", "2.0.0", [new DependencyNode("c", "c", "1.0.1")]),
    new DependencyNode("other", "other", "1.0.0", [new DependencyNode("c", "c", "1.0.9")]),
  ]));
  const { search } = createSearch(["1.0.0"], { "1.0.0": tree });

  const result = await search.execute("a", "c", "1.0.9");

  assert.deepEqual(result.match.path.map(node => node.projectId), ["a", "other", "c"]);
  assert.equal(result.match.tree, tree);
});

test("returns no match immediately when the newest inspectable release is below the minimum", async () => {
  const { search, checked } = createSearch(["v1.0.10", "v1.0.2", "v1.0.1"], {
    "v1.0.1": null, "v1.0.2": "1.0.1", "v1.0.10": "1.0.8",
  });

  const result = await search.execute(" a ", " c ", " 1.0.9 ");

  assert.equal(result.match, null);
  assert.equal(result.minimumVersion, "1.0.9");
  assert.equal(result.checkedVersions, 1);
  assert.deepEqual(checked, ["v1.0.10"]);
});

test("does not search older matches when the newest inspectable tree lacks the dependency", async () => {
  const { search, checked } = createSearch(["1.0.0", "2.0.0"], {
    "1.0.0": "1.1.0", "2.0.0": null,
  });

  const result = await search.execute("a", "c", "1.0.9");

  assert.equal(result.match, null);
  assert.deepEqual(checked, ["2.0.0"]);
});

test("accepts a non-match boundary with an unrelated unknown branch", async () => {
  const tree = new DependencyTree(new DependencyNode("a", "a", "2.0.0", [
    new DependencyNode("unrelated", "Unrelated dependency", "unknown"),
    new DependencyNode("b", "b", "2.0.0", [new DependencyNode("c", "c", "1.0.1")]),
  ]));
  const { search, checked } = createSearch(["1.0.0", "2.0.0"], {
    "1.0.0": "1.1.0", "2.0.0": tree,
  });

  assert.equal((await search.execute("a", "c", "1.0.9")).match, null);
  assert.deepEqual(checked, ["2.0.0"]);
});

test("a known matching occurrence qualifies even if another target occurrence is unknown", async () => {
  const tree = new DependencyTree(new DependencyNode("a", "a", "1.0.0", [
    new DependencyNode("b", "b", "2.0.0", [new DependencyNode("c", "c", "unknown")]),
    new DependencyNode("other", "other", "2.0.0", [new DependencyNode("c", "c", "1.0.9")]),
  ]));
  const { search } = createSearch(["1.0.0"], { "1.0.0": tree });

  const result = await search.execute("a", "c", "1.0.9");

  assert.deepEqual(result.match.path.map(node => node.projectId), ["a", "other", "c"]);
});

test("tracks all configured ancestor paths before treating an unknown branch as unrelated", async () => {
  const tree = new DependencyTree(new DependencyNode("a", "a", "1.0.0", [
    new DependencyNode("b", "b", "2.0.0", [new DependencyNode("c", "c", "1.0.1")]),
    new DependencyNode("other", "other", "unknown"),
  ]));
  const { search, project } = createSearch(["1.0.0"], { "1.0.0": tree });
  const dependency = project.dependencies[0].project.dependencies[0].project;
  const other = new Project("other", "other", "https://example.com/other.git", null, [
    new ProjectDependency(dependency, "package.json", "c"),
  ]);
  project.dependencies.push(new ProjectDependency(other, "package.json", "other"));

  await assert.rejects(search.execute("a", "c", "1.0.9"), /Dependency "other" has an unknown version/);
});

test("returns no match without resolving a tree when there are no tags", async () => {
  const { search, checked } = createSearch([], {});

  const result = await search.execute("a", "c", "1.0.9");

  assert.equal(result.match, null);
  assert.equal(result.checkedVersions, 0);
  assert.equal(result.totalVersions, 0);
  assert.deepEqual(checked, []);
});

test("includes a removed release when its retained tree contains the fix", async () => {
  const { search, checked } = createSearch([
    new Version("1.0.0", null, "old-commit", true, true), "2.0.0",
  ], { "1.0.0": "1.0.9", "2.0.0": "1.1.0" });

  const result = await search.execute("a", "c", "1.0.9");

  assert.equal(result.match.version, "1.0.0");
  assert.deepEqual(checked, ["2.0.0", "1.0.0"]);
});

test("skips a deleted PR dependency ref without treating it as a non-match boundary", async () => {
  const { search, checked, warnings } = createSearch([
    "3.0.404", "3.0.403", "3.0.402-patch.7", "3.0.401",
  ], {
    "3.0.401": "19.1.0",
    "3.0.402-patch.7": new VersionNotFoundError("1.0.0-pr-15867.0", "https://example.com/c.git"),
    "3.0.403": "19.2.0",
    "3.0.404": "19.3.0",
  });

  const result = await search.execute("a", "c", "19.2.0");

  assert.equal(result.match.version, "3.0.403");
  assert.equal(result.match.dependencyVersion, "19.2.0");
  assert.equal(result.checkedVersions, 4);
  assert.equal(result.totalVersions, 4);
  assert.deepEqual(checked, ["3.0.404", "3.0.403", "3.0.402-patch.7", "3.0.401"]);
  assert.deepEqual(warnings, [{
    context: { projectId: "a", projectName: "a", version: "3.0.402-patch.7", missingVersion: "1.0.0-pr-15867.0" },
    message: "Skipping root release because a referenced version was not found.",
  }]);
});

test("starts from the newest inspectable release after skipping a missing newest ref", async () => {
  const { search, checked } = createSearch(["1.0.0", "2.0.0", "3.0.0"], {
    "3.0.0": new VersionNotFoundError("1.0.0-pr-42.0", "https://example.com/c.git"),
    "2.0.0": "1.0.9", "1.0.0": "1.0.1",
  });

  const result = await search.execute("a", "c", "1.0.9");

  assert.equal(result.match.version, "2.0.0");
  assert.deepEqual(checked, ["3.0.0", "2.0.0", "1.0.0"]);
});

test("returns no match after skipping every missing root or dependency ref", async () => {
  const { search, checked, warnings } = createSearch(["2.0.0", "1.0.0"], {
    "1.0.0": new VersionNotFoundError("1.0.0", "https://example.com/a.git"),
    "2.0.0": new VersionNotFoundError("1.0.0-pr-42.0", "https://example.com/c.git"),
  });

  const result = await search.execute("a", "c", "1.0.9");

  assert.equal(result.match, null);
  assert.equal(result.checkedVersions, 2);
  assert.equal(result.totalVersions, 2);
  assert.deepEqual(checked, ["2.0.0", "1.0.0"]);
  assert.equal(warnings.length, 2);
});

test("resolver classifies missing refs only after refresh and preserves refresh failures", async () => {
  const project = new Project("a", "a", "https://example.com/a.git");
  const calls = [];
  const gitClient = {
    hasClone: async () => true,
    hasRef: async (_repoPath, ref) => { calls.push(["hasRef", ref]); return false; },
    getTags: async () => [],
    syncTags: async () => { calls.push(["syncTags"]); },
  };
  const resolver = new DependencyResolverService({ getProject: () => project }, gitClient, [], "unused-clones");

  await assert.rejects(resolver.resolve("a", "1.0.0-pr-15867.0"), error => {
    assert.ok(error instanceof VersionNotFoundError);
    assert.equal(error.version, "1.0.0-pr-15867.0");
    assert.equal(error.message, 'Version "1.0.0-pr-15867.0" was not found in "https://example.com/a.git".');
    return true;
  });
  assert.deepEqual(calls, [
    ["hasRef", "1.0.0-pr-15867.0"], ["hasRef", "1.0.0-pr-15867.0"],
    ["syncTags"], ["hasRef", "1.0.0-pr-15867.0"],
  ]);

  const failure = new Error("Authentication failed while refreshing tags.");
  gitClient.syncTags = async () => { throw failure; };
  await assert.rejects(resolver.resolve("a", "1.0.0-pr-15867.0"), error => error === failure);
});

test("does not skip authentication, network, manifest, or unclassified missing-version errors", async () => {
  for (const message of [
    "Authentication failed.", "Network unavailable.", "Manifest unavailable.",
    'Version "1.0.0" was not found in "https://example.com/c.git".',
  ]) {
    const { search, checked, warnings } = createSearch(["2.0.0", "1.0.0"], {
      "1.0.0": new Error(message), "2.0.0": "1.1.0",
    });

    await assert.rejects(search.execute("a", "c", "1.0.9"), error => {
      assert.ok(error.message.includes(message));
      return true;
    });
    assert.deepEqual(checked, ["2.0.0", "1.0.0"]);
    assert.deepEqual(warnings, []);
  }
});

test("does not silently cross an unreadable release before finding the matching-run boundary", async () => {
  const { search, checked } = createSearch(["2.0.0", "1.0.0"], {
    "1.0.0": new Error("Manifest unavailable"), "2.0.0": "1.1.0",
  });

  await assert.rejects(search.execute("a", "c", "1.0.9"),
    /Cannot inspect "a@1.0.0".*Manifest unavailable.*start of the latest containing release run cannot be confirmed/);
  assert.deepEqual(checked, ["2.0.0", "1.0.0"]);
});

test("stops on unknown versions that could hide the requested dependency", async () => {
  const tree = new DependencyTree(new DependencyNode("a", "a", "1.0.0", [
    new DependencyNode("unrelated", "Unrelated dependency", "unknown"),
    new DependencyNode("b", "b", "unknown"),
  ]));
  const { search, checked } = createSearch(["2.0.0", "1.0.0"], {
    "1.0.0": tree, "2.0.0": "1.1.0",
  });

  await assert.rejects(search.execute("a", "c", "1.0.9"), /Dependency "b" has an unknown version/);
  assert.deepEqual(checked, ["2.0.0", "1.0.0"]);
});

test("rejects missing values, unregistered projects, and unrelated dependencies", async () => {
  const { search, checked } = createSearch(["1.0.0"], { "1.0.0": "1.1.0" });
  for (const args of [[" ", "c", "1.0.9"], ["a", " ", "1.0.9"],
    ["a", "c", " "], ["missing", "c", "1.0.9"], ["a", "other", "1.0.9"],
    ["a", "a", "1.0.9"], ["a", "c", "^1.0.9"]]) {
    await assert.rejects(search.execute(...args), VersionSearchInputError);
  }
  assert.deepEqual(checked, []);
});

test("refuses to silently order nonnumeric tags or dependency versions", async () => {
  const invalidTag = createSearch(["stable", "1.0.0"], { "stable": "1.1.0", "1.0.0": "1.1.0" });
  await assert.rejects(invalidTag.search.execute("a", "c", "1.0.9"), /Cannot compare version "stable"/);
  assert.deepEqual(invalidTag.checked, []);

  const invalidDependency = createSearch(["1.0.0"], { "1.0.0": "1.1.0-beta" });
  await assert.rejects(invalidDependency.search.execute("a", "c", "1.0.9"),
    /Cannot inspect.*Cannot compare version "1.1.0-beta"/);
});

test("HTTP lookup returns the full tree, path, no-match result, and explicit errors", async context => {
  const trees = { "3.1.1": "1.1.3", "3.1.0": "1.1.1", "3.0.9": "1.0.1" };
  const releases = ["3.1.1", "3.1.0", "3.0.9"];
  const { project, resolver } = createSearch(releases, trees);
  const search = new FindRootVersion(
    { getProject: projectId => projectId === "a" ? project : null },
    {
      getAvailableVersions: async projectId =>
        (projectId === "c" ? ["1.0.9", "9.0.0"] : releases)
          .map(version => new Version(version, null)),
    },
    resolver
  );
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
    new VersionSearchController(search, { addCreationDates: async tree => tree })
  ));
  const server = app.listen(0, "127.0.0.1");
  context.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  }));
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/api/projects/a/find-root-version`;

  const success = await fetch(`${url}?dependencyProjectId=c&minimumVersion=1.0.9`);
  assert.equal(success.status, 200);
  const result = await success.json();
  assert.equal(result.match.version, "3.1.0");
  assert.equal(result.match.dependencyVersion, "1.1.1");
  assert.deepEqual(result.match.path, [
    { projectId: "a", projectName: "a", version: "3.1.0" },
    { projectId: "b", projectName: "b", version: "2.0.0" },
    { projectId: "c", projectName: "c", version: "1.1.1" },
  ]);
  assert.equal(result.match.dependencyTree.version, "3.1.0");
  assert.equal(result.match.dependencyTree.tree.dependencies[0].dependencies[0].version, "1.1.1");
  assert.equal(result.checkedVersions, 3);

  const noMatch = await fetch(`${url}?dependencyProjectId=c&minimumVersion=9.0.0`);
  assert.equal(noMatch.status, 200);
  const noMatchResult = await noMatch.json();
  assert.equal(noMatchResult.match, null);
  assert.equal(noMatchResult.checkedVersions, 1);

  for (const query of ["dependencyProjectId=c", "dependencyProjectId=other&minimumVersion=1.0.9",
    "dependencyProjectId=c&minimumVersion=invalid", "dependencyProjectId=c&dependencyProjectId=b&minimumVersion=1.0.9"]) {
    const invalid = await fetch(`${url}?${query}`);
    assert.equal(invalid.status, 400);
    assert.equal(typeof (await invalid.json()).error, "string");
  }

  trees["3.0.9"] = new VersionNotFoundError("1.0.0-pr-15867.0", "https://example.com/c.git");
  const skipped = await fetch(`${url}?dependencyProjectId=c&minimumVersion=1.0.9`);
  assert.equal(skipped.status, 200);
  const skippedResult = await skipped.json();
  assert.equal(skippedResult.match.version, "3.1.0");
  assert.equal(skippedResult.checkedVersions, 3);
  assert.equal(skippedResult.warnings.length, 1);
  assert.equal(skippedResult.warnings[0].reason, "tree_unavailable");

  trees["3.0.9"] = new Error("Manifest unavailable");
  const incomplete = await fetch(`${url}?dependencyProjectId=c&minimumVersion=1.0.9`);
  assert.equal(incomplete.status, 500);
  assert.match((await incomplete.json()).error, /start of the latest containing release run cannot be confirmed/);
});