const assert = require("node:assert/strict");
const { mkdtemp, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { DependencyResolverService } = require("../dist/application/services/DependencyResolverService");
const { MavenPackageParser } = require("../dist/infrastructure/parsers/maven/MavenPackageParser");
const { JsonFileDataStore } = require("../dist/infrastructure/storage/JsonFileDataStore");

const parser = new MavenPackageParser();

function parseVersions(content) {
  return Object.fromEntries(
    parser.parseDependencies(content).dependencies.map(({ name, version }) => [name, version])
  );
}

test("supports Maven POMs without claiming npm manifests", () => {
  assert.equal(parser.supports("pom.xml"), true);
  assert.equal(parser.supports("package.json"), false);
});

test("exposes POM properties by their exact names and preserves version strings", () => {
  const result = parser.parseDependencies(`
    <project xmlns="http://maven.apache.org/POM/4.0.0">
      <version>3.3-SNAPSHOT</version>
      <properties>
        <!-- Version references identify these properties, not the root version. -->
        <example-app.version>2.1.397</example-app.version>
        <example-service.version>main.68</example-service.version>
        <numeric.version>001.020</numeric.version>
        <image-version>\${project.version}</image-version>
      </properties>
    </project>
  `);

  assert.deepEqual(
    result.dependencies.map(({ name, version }) => ({ name, version })),
    [
      { name: "example-app.version", version: "2.1.397" },
      { name: "example-service.version", version: "main.68" },
      { name: "numeric.version", version: "001.020" },
      { name: "image-version", version: "3.3-SNAPSHOT" },
    ]
  );
  assert.equal(result.metadata.packageManager, "maven");
});

test("handles namespace-prefixed POM elements", () => {
  assert.deepEqual(parseVersions(`
    <m:project xmlns:m="http://maven.apache.org/POM/4.0.0">
      <m:properties>
        <m:example-app.version>2.1.397</m:example-app.version>
      </m:properties>
    </m:project>
  `), { "example-app.version": "2.1.397" });
});

test("resolves chained properties in Maven dependency coordinates", () => {
  const versions = parseVersions(`
    <project>
      <groupId>com.example</groupId>
      <version>3.3-SNAPSHOT</version>
      <properties>
        <base.version>2.1.397</base.version>
        <example-app.version>\${base.version}-patch.1</example-app.version>
        <root.version>\${pom.version}</root.version>
      </properties>
      <dependencies>
        <dependency>
          <groupId>\${project.groupId}</groupId>
          <artifactId>example-app</artifactId>
          <version>\${example-app.version}</version>
        </dependency>
      </dependencies>
    </project>
  `);

  assert.equal(versions["example-app.version"], "2.1.397-patch.1");
  assert.equal(versions["root.version"], "3.3-SNAPSHOT");
  assert.equal(versions["com.example:example-app"], "2.1.397-patch.1");
});

test("reads multiple dependencies and skips those without an explicit version", () => {
  assert.deepEqual(parseVersions(`
    <project>
      <dependencies>
        <dependency>
          <groupId>example</groupId><artifactId>first</artifactId><version>1.0.0</version>
        </dependency>
        <dependency>
          <groupId>example</groupId><artifactId>second</artifactId><version>2.0.0</version>
        </dependency>
        <dependency>
          <groupId>example</groupId><artifactId>managed</artifactId>
        </dependency>
      </dependencies>
    </project>
  `), { "example:first": "1.0.0", "example:second": "2.0.0" });
});

test("uses locally declared parent coordinates for project aliases", () => {
  assert.deepEqual(parseVersions(`
    <project>
      <parent>
        <groupId>example</groupId><artifactId>parent</artifactId><version>4.0.0</version>
      </parent>
      <artifactId>child</artifactId>
      <properties>
        <inherited.version>\${project.version}</inherited.version>
      </properties>
      <dependencies>
        <dependency>
          <groupId>\${project.groupId}</groupId>
          <artifactId>dependency</artifactId><version>1.0.0</version>
        </dependency>
      </dependencies>
    </project>
  `), { "inherited.version": "4.0.0", "example:dependency": "1.0.0" });
});

test("skips unresolved and cyclic properties without losing valid references", () => {
  assert.deepEqual(parseVersions(`
    <project>
      <properties>
        <example-app.version>2.1.397</example-app.version>
        <missing.version>\${not.present}</missing.version>
        <cycle.first>\${cycle.second}</cycle.first>
        <cycle.second>\${cycle.first}</cycle.second>
      </properties>
    </project>
  `), { "example-app.version": "2.1.397" });
});

test("does not treat inactive profiles or plugin dependencies as project dependencies", () => {
  assert.deepEqual(parseVersions(`
    <project>
      <properties><example-app.version>2.1.397</example-app.version></properties>
      <profiles>
        <profile>
          <properties><example-app.version>9.0.0</example-app.version></properties>
          <dependencies>
            <dependency>
              <groupId>example</groupId><artifactId>profile</artifactId><version>9.0.0</version>
            </dependency>
          </dependencies>
        </profile>
      </profiles>
      <build>
        <plugins>
          <plugin>
            <dependencies>
              <dependency>
                <groupId>example</groupId><artifactId>plugin</artifactId><version>8.0.0</version>
              </dependency>
            </dependencies>
          </plugin>
        </plugins>
      </build>
    </project>
  `), { "example-app.version": "2.1.397" });
});

test("rejects malformed XML and non-POM documents with clear errors", () => {
  assert.throws(
    () => parser.parseDependencies("<project><properties></project>"),
    (error) => {
      assert.match(error.message, /Invalid pom\.xml content:/);
      assert.ok(error.cause instanceof Error);
      return true;
    }
  );
  assert.throws(
    () => parser.parseDependencies("<settings><servers /></settings>"),
    /pom\.xml must contain a <project> element\./
  );
});

test("re-resolves an unknown cached Maven dependency and persists its version", async (context) => {
  const rootId = "root";
  const appId = "app";
  const rootVersion = "1.0.0";
  const appVersion = "2.3.4";
  const tagPattern = "^\\d+\\.\\d+\\.\\d+(-patch\\.\\d+)?$";
  const projectDefinition = {
    id: rootId,
    name: "Configuration",
    repoUrl: "https://example.com/configuration.git",
    description: "Configuration project",
    tagPattern,
    dependencies: [{
      project: {
        id: appId,
        name: "Application",
        repoUrl: "https://example.com/application.git",
        description: "Application project",
        tagPattern,
        dependencies: null,
      },
      manifestPath: "pom.xml",
      versionReference: "example-app.version",
    }],
  };
  const directory = await mkdtemp(path.join(os.tmpdir(), "dependency-parser-maven-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const projectFile = path.join(directory, "projects.json");
  const treeFile = path.join(directory, "dependency-trees.json");
  await writeFile(projectFile, JSON.stringify({ projects: { [rootId]: projectDefinition } }));
  await writeFile(treeFile, JSON.stringify({
    projects: {
      [rootId]: {
        versions: {
          [rootVersion]: [{
            commitHash: null,
            projectConfiguration: JSON.stringify(projectDefinition),
            root: {
            projectId: rootId,
            projectName: "Configuration",
            version: rootVersion,
            dependencies: [{
              projectId: appId,
              projectName: "Application",
              version: "unknown",
              dependencies: [],
            }],
            },
          }],
        },
      },
    },
  }));

  const dataStore = new JsonFileDataStore(treeFile, projectFile);
  const project = await dataStore.getProjectById(rootId);
  assert.ok(project);
  const cloneRoot = path.join(directory, "repositories", "git");
  const rootPath = path.join(cloneRoot, rootId);
  const appPath = path.join(cloneRoot, appId);
  let manifestReads = 0;
  const gitClient = {
    hasClone: async (repoUrl, repoPath) =>
      (repoUrl === project.repoUrl && repoPath === rootPath) ||
      (repoUrl === project.dependencies[0].project.repoUrl && repoPath === appPath),
    hasRef: async (repoPath, ref) =>
      (repoPath === rootPath && ref === rootVersion) ||
      (repoPath === appPath && ref === appVersion),
    syncTags: async () => assert.fail("Existing clones with matching tags must be reused."),
    fileExists: async (repoPath, filePath, ref) =>
      repoPath === rootPath && filePath === "pom.xml" && ref === rootVersion,
    getFileContent: async (repoPath, filePath, ref) => {
      assert.equal(repoPath, rootPath);
      assert.equal(filePath, "pom.xml");
      assert.equal(ref, rootVersion);
      manifestReads += 1;
      return `<project xmlns="http://maven.apache.org/POM/4.0.0">
        <properties><example-app.version>${appVersion}</example-app.version></properties>
      </project>`;
    },
  };
  const resolver = new DependencyResolverService(
    { getProject: (projectId) => projectId === rootId ? project : undefined },
    gitClient,
    [parser],
    cloneRoot,
    dataStore
  );

  const resolved = await resolver.resolve(rootId, rootVersion);
  assert.equal(resolved.root.version, rootVersion);
  assert.equal(resolved.root.dependencies[0].projectName, "Application");
  assert.equal(resolved.root.dependencies[0].version, appVersion);
  assert.equal(manifestReads, 1);

  const persisted = await dataStore.getDependencyTree(rootId, rootVersion);
  assert.equal(persisted.root.dependencies[0].version, appVersion);
  await resolver.resolve(rootId, rootVersion);
  assert.equal(manifestReads, 1);
});