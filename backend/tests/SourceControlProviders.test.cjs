const assert = require("node:assert/strict");
const { test } = require("node:test");

const { DiffService } = require("../dist/application/services/DiffService");
const { ComparePackageVersions } = require("../dist/application/use-cases/ComparePackageVersions");
const { SourceControlUrlError } = require("../dist/domain/interfaces/ISourceControlProvider");
const { Project } = require("../dist/domain/models/Project");
const { NpmPackageParser } = require("../dist/infrastructure/parsers/npm/NpmPackageParser");
const { AutoDetectSourceControlProvider } = require("../dist/infrastructure/providers/AutoDetectSourceControlProvider");
const { GitHubProvider } = require("../dist/infrastructure/providers/github/GitHubProvider");
const { ProjectRegistry } = require("../dist/infrastructure/registry/ProjectRegistry");

const provider = new AutoDetectSourceControlProvider();
const hash = "a".repeat(40);
const platforms = [
  {
    name: "GitHub",
    base: "https://github.com/example/repository",
    repos: [
      "https://github.com/example/repository.git",
      " git@github.com:example/repository.git ",
      "ssh://git@github.com/example/repository.git",
      "ssh://git@github.com:22/example/repository.git",
      "https://GITHUB.COM/example/repository.git/",
    ],
    commit: `/commit/${hash}`,
    compare: "/compare/release%2Fv1...release%2Fv2",
    browse: "/tree/release%2Fv2",
    file: "/blob/release%2Fv2/src/notes%20%26%20%23%3F.txt",
  },
  {
    name: "GitLab",
    base: "https://gitlab.com/group/subgroup/repository",
    repos: [
      "https://gitlab.com/group/subgroup/repository.git",
      "git@gitlab.com:group/subgroup/repository.git",
      "ssh://git@gitlab.com/group/subgroup/repository.git",
      "ssh://git@gitlab.com:22/group/subgroup/repository.git",
      "https://GITLAB.COM/group/subgroup/repository.git/",
    ],
    commit: `/-/commit/${hash}`,
    compare: "/-/compare/release%2Fv1...release%2Fv2",
    browse: "/-/tree/release%2Fv2",
    file: "/-/blob/release%2Fv2/src/notes%20%26%20%23%3F.txt",
  },
  {
    name: "Bitbucket Cloud",
    base: "https://bitbucket.org/workspace/repository",
    repos: [
      "https://bitbucket.org/workspace/repository.git",
      "git@bitbucket.org:workspace/repository.git",
      "ssh://git@bitbucket.org/workspace/repository.git",
      "ssh://git@bitbucket.org:22/workspace/repository.git",
      "https://BITBUCKET.ORG/workspace/repository.git/",
    ],
    commit: `/commits/${hash}`,
    compare: "/branches/compare/release%2Fv2..release%2Fv1",
    browse: "/src/release%2Fv2/",
    file: "/src/release%2Fv2/src/notes%20%26%20%23%3F.txt",
  },
  ...["bitbucket.example.com", "bitbucket.internal", "bitbucket.team.example.net"].map(host => ({
    name: `Bitbucket Server (${host})`,
    base: `https://${host}/projects/EXAMPLE/repos/repository`,
    repos: [
      `https://${host}/projects/EXAMPLE/repos/repository`,
      `https://${host}/scm/example/repository.git`,
      `git@${host}:EXAMPLE/repository.git`,
      `ssh://git@${host}:7999/EXAMPLE/repository.git`,
      `ssh://git@${host}:7999/scm/example/repository.git`,
      `https://${host.toUpperCase()}/projects/EXAMPLE/repos/repository/`,
    ],
    commit: `/commits/${hash}`,
    compare: "/compare/commits?sourceBranch=release%2Fv2&targetBranch=release%2Fv1",
    browse: "/browse?at=release%2Fv2",
    file: "/browse/src/notes%20%26%20%23%3F.txt?at=release%2Fv2",
  })),
];

for (const platform of platforms) {
  for (const repo of platform.repos) {
    test(`${platform.name} detects and normalizes ${repo.trim()}`, () => {
      assert.equal(provider.getCommitUrl(repo, hash), platform.base + platform.commit);
      assert.equal(provider.getCompareUrl(repo, "release/v1", "release/v2"), platform.base + platform.compare);
      assert.equal(provider.getBrowseUrl(repo, "release/v2"), platform.base + platform.browse);
      assert.equal(provider.getFileUrl(repo, "src\\notes & #?.txt", "release/v2"), platform.base + platform.file);
    });
  }

  test(`${platform.name} strips credentials, query strings, and fragments from browser links`, () => {
    const repo = `${platform.base.replace("https://", "https://username:placeholder@")}.git/?access_token=placeholder#fragment`;
    const link = provider.getCommitUrl(repo, hash);
    assert.equal(link, platform.base + platform.commit);
    assert.doesNotMatch(link, /username|placeholder|access_token|fragment|\.git/);
  });

  test(`${platform.name} keeps baseline and comparison direction in manifest diffs`, async () => {
    let ref;
    const calls = [];
    const git = {
      clone: async repoUrl => { calls.push(["clone", repoUrl]); return "fixture-clone"; },
      checkout: async (_repoPath, requestedRef) => { ref = requestedRef; },
      getFileContent: async () => JSON.stringify({
        dependencies: ref === "release/v1"
          ? { updated: "1", removed: "1" } : { updated: "2", added: "1" },
      }),
      remove: async repoPath => { calls.push(["remove", repoPath]); },
    };
    const project = new Project("root", "Root", platform.repos[0]);
    const comparison = new ComparePackageVersions(
      new ProjectRegistry([project]),
      new DiffService(git, new NpmPackageParser(), provider)
    );
    const result = await comparison.execute("root", "release/v1", "release/v2");
    assert.equal(result.compareUrl, platform.base + platform.compare);
    assert.deepEqual(result.diffResult, {
      added: [{ name: "added", fromVersion: null, toVersion: "1" }],
      removed: [{ name: "removed", fromVersion: "1", toVersion: null }],
      updated: [{ name: "updated", fromVersion: "1", toVersion: "2" }],
    });
    assert.deepEqual(calls, [["clone", project.repoUrl], ["remove", "fixture-clone"]]);
  });
}

test("refs and paths are encoded without leaking query delimiters or double-encoding repository paths", () => {
  const repo = "https://gitlab.com/group/sub%20group/repository.git";
  assert.equal(provider.getCommitUrl(repo, "hash/#?&"),
    "https://gitlab.com/group/sub%20group/repository/-/commit/hash%2F%23%3F%26");
  assert.equal(provider.getFileUrl(repo, "folder\\100%.txt", "release/v2 +fix?#&"),
    "https://gitlab.com/group/sub%20group/repository/-/blob/release%2Fv2%20%2Bfix%3F%23%26/folder/100%25.txt");
  const server = "https://bitbucket.example.com/scm/example/repository.git";
  const compare = new URL(provider.getCompareUrl(server, "release/v1?x=1", "release/v2&x=2"));
  assert.deepEqual([...compare.searchParams], [
    ["sourceBranch", "release/v2&x=2"], ["targetBranch", "release/v1?x=1"],
  ]);
});

test("HTTPS web ports are preserved while SSH transport ports are not used as web ports", () => {
  assert.equal(provider.getCommitUrl(
    "https://bitbucket.example.com:8443/scm/example/repository.git", hash
  ), `https://bitbucket.example.com:8443/projects/EXAMPLE/repos/repository/commits/${hash}`);
  assert.equal(provider.getCommitUrl(
    "ssh://git@bitbucket.example.com:7999/example/repository.git", hash
  ), `https://bitbucket.example.com/projects/EXAMPLE/repos/repository/commits/${hash}`);
});

test("Bitbucket Cloud detection takes precedence over the Server hostname pattern", () => {
  assert.equal(provider.getCommitUrl("https://bitbucket.org/workspace/repository.git", hash),
    `https://bitbucket.org/workspace/repository/commits/${hash}`);
  assert.throws(() => provider.getCommitUrl("https://bitbucket.org/scm/example/repository.git", hash),
    /Bitbucket Cloud repository URL/);
  assert.equal(provider.getCommitUrl("https://bitbucket.org.example.invalid/scm/example/repository.git", hash),
    `https://bitbucket.org.example.invalid/projects/EXAMPLE/repos/repository/commits/${hash}`);
});

test("unknown hosts and nonmatching hostname patterns fail explicitly", () => {
  for (const host of [
    "example.invalid", "github.company.invalid", "gitlab.company.invalid",
    "github.com.example.invalid", "not-bitbucket.example.com", "bitbucket-example.com",
    "git.bitbucket.example.com", "bitbucket", "bitbucket.",
  ]) {
    assert.throws(() => provider.getCommitUrl(`https://${host}/group/repository.git`, hash), error => {
      assert.ok(error instanceof SourceControlUrlError);
      assert.equal(error.message, `Unsupported source-control host "${host}".`);
      return true;
    });
  }
});

test("malformed or unsupported repository addresses fail without including credentials in errors", () => {
  for (const repo of [
    "", "not a URL", "C:\\repositories\\repo", "file:///repository",
    "ftp://github.com/group/repository", "javascript:alert(1)",
    "https://github.com", "https://github.com/group", "https://gitlab.com/group",
    "https://bitbucket.org/workspace/repository/src/main",
    "https://bitbucket.example.com/EXAMPLE/repository.git",
    "https://bitbucket.example.com/projects/EXAMPLE/repos",
    "https://github.com/group/%2F", "https://github.com/group/%ZZ",
    "https://github.com/group/re\npo", "https://username:placeholder@github.com/group",
  ]) {
    assert.throws(() => provider.getCommitUrl(repo, hash), error => {
      assert.ok(error instanceof SourceControlUrlError);
      assert.doesNotMatch(error.message, /username|placeholder/);
      return true;
    });
  }
});

test("GitHub adapter remains GitHub-only and preserves existing public URL shapes", () => {
  const github = new GitHubProvider();
  const repo = "git@github.com:example/repository.git";
  assert.equal(github.getCommitUrl(repo, hash), `https://github.com/example/repository/commit/${hash}`);
  assert.equal(github.getCompareUrl(repo, "v1", "v2"), "https://github.com/example/repository/compare/v1...v2");
  assert.equal(github.getBrowseUrl(repo, "main"), "https://github.com/example/repository/tree/main");
  assert.equal(github.getFileUrl(repo, "src\\index.ts", "main"),
    "https://github.com/example/repository/blob/main/src/index.ts");
  assert.throws(() => github.getCommitUrl("https://gitlab.com/example/repository.git", hash), SourceControlUrlError);
});

test("file links reject empty and traversal paths", () => {
  for (const file of ["", "../secret", "src\\..\\secret", "src/./index.ts"]) {
    assert.throws(() => provider.getFileUrl("https://github.com/example/repository", file, "main"),
      SourceControlUrlError);
  }
});
