import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { GitRefNotFoundError, IGitClient } from "../../domain/interfaces/IGitClient";
import { Version } from "../../domain/models/Version";
import { CommitComparisonTagHints, CommitDiff } from "../../domain/types/CommitDiff";
import { ConcurrencyLimiter, ReadWriteLock } from "../../utils/ConcurrencyLimiter";
import { logger } from "../../utils/logger";

const execFile = promisify(execFileCallback);

type ExecFileError = Error & {
  code?: number | string;
  stderr?: string;
  stdout?: string;
};

type GitRef = { oid: string; name: string };
type ComparisonTag = GitRef & { commitHash: string };
type GitCommandOptions = { trimOutput?: boolean; input?: string };
type ComparisonRepository = {
  path: Promise<string>;
  users: number;
  initialized: boolean;
  objectIdLength: number;
};

const COMPARISON_REPOSITORY_LIMIT = 8;
const COMPARISON_INITIAL_DEPTH = 64;
const COMPARISON_DEEPENING_ROUNDS = 4;

class GitCommandError extends Error {
  constructor(message: string, readonly code?: number | string) {
    super(message);
  }
}

export class GitCliClient implements IGitClient {
  private readonly tagSyncQueues = new Map<string, Promise<string>>();
  private readonly repositoryLocks = new Map<string, ReadWriteLock>();
  private readonly comparisonRepositories = new Map<string, ComparisonRepository>();
  private readonly commandLimiter: ConcurrencyLimiter;
  private readonly githubCredentials?: string;
  private reftableSupport?: Promise<boolean>;

  constructor(
    private readonly gitBinary = "git",
    maximumConcurrency = 4,
    private readonly githubToken?: string
  ) {
    this.commandLimiter = new ConcurrencyLimiter(maximumConcurrency);
    if (githubToken) {
      this.githubCredentials = Buffer.from(`x-access-token:${githubToken}`).toString("base64");
    }
  }

  async clone(repoUrl: string, targetPath?: string): Promise<string> {
    const clonePath = targetPath ?? (await this.createClonePath());

    return this.withRepositoryAccess(clonePath, true, async () => {
      if (targetPath) {
        await mkdir(path.dirname(targetPath), { recursive: true });
      }
      await this.runGit(["clone", repoUrl, clonePath]);
      return clonePath;
    });
  }

  async syncTags(repoUrl: string, targetPath?: string, tagPattern?: string | null): Promise<string> {
    const remote = this.resolveRepoUrl(repoUrl);
    const clonePath = targetPath ?? await this.createClonePath();
    const key = path.resolve(clonePath);
    const previous = this.tagSyncQueues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.withRepositoryAccess(clonePath, true, async () => {
      if (tagPattern) {
        const existing = await this.hasCloneUnlocked(remote, clonePath);
        const managed = existing &&
          await this.getOptionalConfig(clonePath, "dependencyParser.tagCatalog") === "selective";
        if ((!existing || managed) && await this.supportsReftable()) {
          return this.syncSelectedTags(remote, clonePath, tagPattern, existing);
        }
      }
      return this.syncRepositoryTags(remote, clonePath);
    }));
    this.tagSyncQueues.set(key, next);

    return next.finally(() => {
      if (this.tagSyncQueues.get(key) === next) {
        this.tagSyncQueues.delete(key);
      }
    });
  }

  async cloneFiles(
    repoUrl: string,
    filePaths: string[],
    targetPath?: string
  ): Promise<string> {
    const normalizedFilePaths = Array.from(
      new Set(filePaths.map(filePath => this.normalizeRepoFilePath(filePath)))
    );

    if (normalizedFilePaths.length === 0) {
      throw new Error("At least one file path is required for a sparse clone.");
    }

    const clonePath = targetPath ?? (await this.createClonePath());

    return this.withRepositoryAccess(clonePath, true, () =>
      this.cloneSelectedFiles(repoUrl, normalizedFilePaths, clonePath)
    );
  }

  private async cloneSelectedFiles(
    repoUrl: string,
    normalizedFilePaths: string[],
    clonePath: string
  ): Promise<string> {
    try {
      await mkdir(path.dirname(clonePath), { recursive: true });

      await this.runGit([
        "clone",
        "--filter=blob:none",
        "--no-checkout",
        repoUrl,
        clonePath,
      ]);
      await this.runGit(["sparse-checkout", "init", "--no-cone"], clonePath);
      await this.runGit(
        ["sparse-checkout", "set", "--no-cone", "--", ...normalizedFilePaths],
        clonePath
      );
      await this.runGit(["checkout"], clonePath);

      const missingFilePaths = [];
      for (const filePath of normalizedFilePaths) {
        if (!(await this.fileExistsUnlocked(clonePath, filePath))) {
          missingFilePaths.push(filePath);
        }
      }

      if (missingFilePaths.length > 0) {
        throw new Error(
          `Files not found in repository "${repoUrl}": ${missingFilePaths.join(", ")}.`
        );
      }

      return clonePath;
    } catch (error) {
      await this.removeUnlocked(clonePath);
      throw error;
    }
  }

  async checkout(repoPath: string, ref: string): Promise<void> {
    await this.withRepositoryAccess(repoPath, true, () =>
      this.runGit(["checkout", "--force", ref], repoPath)
    );
  }

  async hasRef(repoPath: string, ref: string): Promise<boolean> {
    this.assertSafeRef(ref);

    return this.withRepositoryAccess(repoPath, false, async () => {
      try {
        await this.runGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repoPath);
        return true;
      } catch {
        return false;
      }
    });
  }

  async getFileContent(repoPath: string, filePath: string, ref?: string): Promise<string> {
    const gitPath = this.resolveRepoGitPath(repoPath, filePath);
    if (ref !== undefined) {
      this.assertSafeRef(ref);
    }

    return this.withRepositoryAccess(repoPath, false, () =>
      this.runGit(["show", `${ref ?? "HEAD"}:${gitPath}`], repoPath, { trimOutput: false })
    );
  }

  async fileExists(repoPath: string, filePath: string, ref?: string): Promise<boolean> {
    return this.withRepositoryAccess(repoPath, false, () =>
      this.fileExistsUnlocked(repoPath, filePath, ref)
    );
  }

  private async fileExistsUnlocked(repoPath: string, filePath: string, ref?: string): Promise<boolean> {
    if (ref !== undefined) {
      this.assertSafeRef(ref);
      const gitPath = this.resolveRepoGitPath(repoPath, filePath);

      try {
        await this.runGit(["cat-file", "-e", `${ref}:${gitPath}`], repoPath);
        return true;
      } catch {
        return false;
      }
    }

    const absoluteFilePath = this.resolveRepoFilePath(repoPath, filePath);

    try {
      await access(absoluteFilePath);
      return true;
    } catch (error) {
      const fileAccessError = error as NodeJS.ErrnoException;
      if (fileAccessError.code === "ENOENT") {
        return false;
      }

      throw fileAccessError;
    }
  }

  async getTags(repoPath: string): Promise<Version[]> {
    const output = await this.withRepositoryAccess(repoPath, false, () => this.runGit(
      [
        "for-each-ref",
        "--sort=-creatordate",
        "--format=%(refname:lstrip=2)%09%(creatordate:iso-strict)%09%(objectname)%09%(*objectname)",
        "refs/tags",
      ],
      repoPath
    ));

    return output
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => this.parseTagLine(line));
  }

  async compareCommits(
    repoUrl: string, fromRef: string, toRef: string, tagHints?: CommitComparisonTagHints
  ): Promise<CommitDiff> {
    this.assertSafeRef(fromRef);
    this.assertSafeRef(toRef);
    const remote = this.resolveRepoUrl(repoUrl);
    const candidates = this.comparisonTagCandidates(fromRef, toRef);
    if (!candidates) {
      logger.debug("Using full Git ref resolution for commit comparison.");
      return this.compareWithFullRepository(remote, fromRef, toRef);
    }

    const hinted = this.hintedComparisonTags(fromRef, toRef, tagHints);
    const initial = hinted ?? await this.discoverComparisonTags(remote, candidates);
    if (!initial) {
      logger.debug("Using full Git ref resolution for commit comparison.");
      return this.compareWithFullRepository(remote, fromRef, toRef);
    }

    return this.withComparisonRepository(remote, async (repoPath, cached) => {
      let selected = initial;
      await this.prepareComparisonRepository(
        remote, repoPath, cached, selected[0][0].oid.length, !hinted
      );
      try {
        await this.fetchComparisonTags(repoPath, selected, [`--depth=${COMPARISON_INITIAL_DEPTH}`]);
      } catch (error) {
        if (!(error instanceof GitCommandError) || error.code !== 128) {
          throw error;
        }
        const refreshed = await this.discoverComparisonTags(remote, candidates);
        if (!refreshed) {
          logger.debug("Requested tags require full Git ref resolution.");
          return this.compareWithFullRepository(remote, fromRef, toRef);
        }
        const names = (tags: [ComparisonTag[], ComparisonTag[]]) =>
          tags.flat().map(tag => tag.name).sort().join("\0");
        if (names(refreshed) === names(selected) &&
          refreshed[0][0].oid.length === cached.objectIdLength) {
          throw error;
        }
        logger.debug("Refreshing comparison tag hints from the remote repository.");
        selected = refreshed;
        await this.prepareComparisonRepository(
          remote, repoPath, cached, selected[0][0].oid.length, true
        );
        await this.fetchComparisonTags(repoPath, selected, [`--depth=${COMPARISON_INITIAL_DEPTH}`]);
      }
      const result = await this.readAdaptiveComparison(repoPath, candidates, selected);
      if (!result) {
        logger.debug("Noncommit tag aliases require full Git ref resolution.");
        return this.compareWithFullRepository(remote, fromRef, toRef);
      }
      return result;
    }, initial[0][0].oid.length);
  }

  async clearCommitComparisonCache(): Promise<void> {
    const repositories = [...this.comparisonRepositories.values()];
    this.comparisonRepositories.clear();
    await Promise.all(repositories.map(async cached => this.remove(await cached.path)));
  }

  private comparisonTagCandidates(fromRef: string, toRef: string): [string[], string[]] | null {
    const candidates: [string[], string[]] = [[fromRef], [toRef]];
    // Object IDs, pseudo-refs and revision expressions retain full-clone resolution.
    if (candidates.flat().some(ref =>
      /[\s~^:?*[\\]|\.\.|@\{/.test(ref) || /^[a-f0-9]{4,64}$/i.test(ref) ||
      /^[A-Z_]+$/.test(ref) || ref === "@" ||
      /^(?:(?:refs\/)?remotes\/)?origin(?:\/HEAD)?$/.test(ref)
    )) {
      return null;
    }
    return candidates;
  }

  private hintedComparisonTags(
    fromRef: string, toRef: string, hints?: CommitComparisonTagHints
  ): [ComparisonTag[], ComparisonTag[]] | null {
    if (!hints || [fromRef, toRef].some(ref => /^(refs|tags|heads|remotes|origin)(\/|$)/.test(ref))) {
      return null;
    }
    const hashes = [hints.fromCommitHash, hints.toCommitHash];
    if (hashes.some(hash => !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(hash)) ||
      hashes[0].length !== hashes[1].length) {
      throw new Error("Commit comparison tag hints have invalid object identities.");
    }
    return [
      [{ name: `refs/tags/${fromRef}`, oid: hashes[0], commitHash: hashes[0] }],
      [{ name: `refs/tags/${toRef}`, oid: hashes[1], commitHash: hashes[1] }],
    ];
  }

  private comparisonRefNames(ref: string): string[] {
    const names = [
      ref, `refs/${ref}`, `refs/tags/${ref}`, `refs/heads/${ref}`,
      `refs/remotes/${ref}`, `refs/remotes/${ref}/HEAD`,
    ];
    const branch = /^(?:(?:refs\/)?remotes\/)?origin\/(.+)$/.exec(ref)?.[1];
    if (branch) {
      names.push(`refs/heads/${branch}`);
    }
    return names;
  }

  private async discoverComparisonTags(
    repoUrl: string, candidates: [string[], string[]]
  ): Promise<[ComparisonTag[], ComparisonTag[]] | null> {
    const patterns = [...new Set(candidates.flat().flatMap(ref => this.comparisonRefNames(ref)))]
      .filter(name => name.startsWith("refs/"));
    const refs = await this.readRemoteRefs(repoUrl, patterns);
    return this.selectComparisonTags(new Map(refs.map(ref => [ref.name, ref])), candidates);
  }

  private async getComparisonTags(
    repoPath: string, candidates: [string[], string[]], allowedNames?: ReadonlySet<string>
  ): Promise<[ComparisonTag[], ComparisonTag[]] | null> {
    const patterns = allowedNames ? [...allowedNames] :
      [...new Set(candidates.flat().flatMap(ref => this.comparisonRefNames(ref)))];
    let output: string;
    try {
      output = await this.runGit(["show-ref", "--dereference", "--", ...patterns], repoPath);
    } catch (error) {
      if (error instanceof GitCommandError && error.code === 1) {
        return null;
      }
      throw error;
    }
    const refs = new Map(this.parseRefs(output.replace(/^([a-f0-9]+) /gm, "$1\t"))
      .filter(ref => !allowedNames || allowedNames.has(ref.name.replace(/\^\{\}$/, "")))
      .map(ref => [ref.name, ref]));
    return this.selectComparisonTags(refs, candidates);
  }

  private selectComparisonTags(
    refs: ReadonlyMap<string, GitRef>, candidates: [string[], string[]]
  ): [ComparisonTag[], ComparisonTag[]] | null {
    const selectTags = (values: string[]): ComparisonTag[] | null => {
      const tags: ComparisonTag[] = [];
      for (const value of values) {
        const ref = this.comparisonRefNames(value).map(name => refs.get(name))
          .find(candidate => candidate);
        if (ref) {
          if (!ref.name.startsWith("refs/tags/")) {
            return null;
          }
          tags.push({ ...ref, commitHash: refs.get(`${ref.name}^{}`)?.oid ?? ref.oid });
        }
      }
      if (tags.length === 0) {
        throw new GitRefNotFoundError(values[0]);
      }
      return tags;
    };
    const fromTags = selectTags(candidates[0]);
    const toTags = selectTags(candidates[1]);
    return fromTags && toTags ? [fromTags, toTags] : null;
  }

  private async withComparisonRepository<Result>(
    repoUrl: string,
    operation: (repoPath: string, cached: ComparisonRepository) => Promise<Result>,
    objectIdLength = 40
  ): Promise<Result> {
    const cached = this.comparisonRepositories.get(repoUrl) ?? {
      path: this.createComparisonRepository(repoUrl, objectIdLength),
      users: 0,
      initialized: true,
      objectIdLength,
    };
    this.comparisonRepositories.delete(repoUrl);
    this.comparisonRepositories.set(repoUrl, cached);
    cached.users += 1;
    try {
      let repoPath: string;
      try {
        repoPath = await cached.path;
      } catch (error) {
        if (this.comparisonRepositories.get(repoUrl) === cached) {
          this.comparisonRepositories.delete(repoUrl);
        }
        throw error;
      }
      return await this.withRepositoryAccess(repoPath, true, () => operation(repoPath, cached));
    } finally {
      cached.users -= 1;
      for (const [remote, entry] of this.comparisonRepositories) {
        if (this.comparisonRepositories.size <= COMPARISON_REPOSITORY_LIMIT) {
          break;
        }
        if (entry.users === 0) {
          this.comparisonRepositories.delete(remote);
          await this.remove(await entry.path);
        }
      }
    }
  }

  private async createComparisonRepository(repoUrl: string, objectIdLength: number): Promise<string> {
    const repoPath = await this.createClonePath();
    try {
      await this.initializeComparisonRepository(repoUrl, repoPath, objectIdLength);
      return repoPath;
    } catch (error) {
      await this.remove(repoPath);
      throw error;
    }
  }

  private async initializeComparisonRepository(
    repoUrl: string, repoPath: string, objectIdLength: number
  ): Promise<void> {
    await this.runGit([
      "init", `--object-format=${objectIdLength === 64 ? "sha256" : "sha1"}`, repoPath,
    ]);
    await this.runGit(["remote", "add", "origin", repoUrl], repoPath);
  }

  private async prepareComparisonRepository(
    repoUrl: string, repoPath: string, cached: ComparisonRepository,
    objectIdLength: number, verified: boolean
  ): Promise<void> {
    if (!cached.initialized || verified && cached.objectIdLength !== objectIdLength) {
      cached.initialized = false;
      await this.removeUnlocked(repoPath);
      await this.initializeComparisonRepository(repoUrl, repoPath, objectIdLength);
      cached.objectIdLength = objectIdLength;
      cached.initialized = true;
    }
  }

  private fetchComparisonTags(
    repoPath: string, selected: [ComparisonTag[], ComparisonTag[]], depthArgs: string[]
  ): Promise<string> {
    const tags = [...new Map(selected.flat().map(tag => [tag.name, tag])).values()];
    return this.runGit([
      "fetch", "--atomic", "--filter=tree:0", "--no-tags", "--no-write-fetch-head",
      "--no-auto-maintenance", "--refmap=", ...depthArgs, "--stdin", "origin",
    ], repoPath, { input: tags.map(tag => `+${tag.name}:${tag.name}`).join("\n") + "\n" });
  }

  private async readAdaptiveComparison(
    repoPath: string, candidates: [string[], string[]], selected: [ComparisonTag[], ComparisonTag[]]
  ): Promise<CommitDiff | null> {
    const allowedNames = new Set(selected.flat().map(tag => tag.name));
    let result = await this.readTagComparison(repoPath, candidates, allowedNames);
    let round = 0;
    while (result && await this.reachesShallowBoundary(repoPath, result)) {
      const complete = round >= COMPARISON_DEEPENING_ROUNDS;
      const depthArgs = complete ? ["--unshallow"] :
        [`--deepen=${COMPARISON_INITIAL_DEPTH * 2 ** round}`];
      logger.debug({ depthArgs }, "Deepening exclusive commit history before returning the comparison.");
      await this.fetchComparisonTags(repoPath, selected, depthArgs);
      result = await this.readTagComparison(repoPath, candidates, allowedNames);
      if (complete && result && await this.reachesShallowBoundary(repoPath, result)) {
        throw new Error("Git could not retrieve a complete commit comparison.");
      }
      round += 1;
    }
    return result;
  }

  private async readTagComparison(
    repoPath: string, candidates: [string[], string[]], allowedNames: ReadonlySet<string>
  ): Promise<CommitDiff | null> {
    const tags = await this.getComparisonTags(repoPath, candidates, allowedNames);
    if (!tags) {
      return null;
    }
    const fromHash = tags[0][0].commitHash;
    const toHash = tags[1][0].commitHash;
    try {
      return await this.readCommitDiff(repoPath, fromHash, toHash, true);
    } catch (error) {
      if (!(error instanceof GitCommandError) || error.code !== 128) {
        throw error;
      }
      let fromCommitHash: string;
      let toCommitHash: string;
      try {
        fromCommitHash = await this.resolveComparisonTag(repoPath, candidates[0][0], tags[0]);
        toCommitHash = await this.resolveComparisonTag(repoPath, candidates[1][0], tags[1]);
      } catch (resolutionError) {
        if (resolutionError instanceof GitRefNotFoundError) {
          return null;
        }
        throw resolutionError;
      }
      if (fromCommitHash === fromHash && toCommitHash === toHash) {
        throw error;
      }
      return this.readCommitDiff(repoPath, fromCommitHash, toCommitHash);
    }
  }

  private async reachesShallowBoundary(repoPath: string, result: CommitDiff): Promise<boolean> {
    let contents: string;
    try {
      contents = await readFile(path.join(repoPath, ".git", "shallow"), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return false;
      }
      throw error;
    }
    const boundaries = new Set(contents.split(/\r?\n/).filter(Boolean));
    if ([...boundaries].some(hash => !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(hash))) {
      throw new Error("Git returned an invalid shallow boundary.");
    }
    // Unknown ancestors are harmless only when their boundary is shared by both refs.
    return result.fromOnly.some(commit => boundaries.has(commit.hash)) ||
      result.toOnly.some(commit => boundaries.has(commit.hash));
  }

  private async resolveComparisonTag(
    repoPath: string, ref: string, tags: ComparisonTag[]
  ): Promise<string> {
    for (const tag of tags) {
      try {
        return await this.resolveCommitHash(repoPath, ref, [tag.name]);
      } catch (error) {
        if (!(error instanceof GitRefNotFoundError)) {
          throw error;
        }
      }
    }
    throw new GitRefNotFoundError(ref);
  }

  private async compareWithFullRepository(
    repoUrl: string, fromRef: string, toRef: string
  ): Promise<CommitDiff> {
    const repoPath = await this.createClonePath();
    try {
      await this.syncTags(repoUrl, repoPath);
      return await this.withRepositoryAccess(repoPath, false, async () => {
        const fromCommitHash = await this.resolveCommitHash(repoPath, fromRef);
        const toCommitHash = await this.resolveCommitHash(repoPath, toRef);
        return this.readCommitDiff(repoPath, fromCommitHash, toCommitHash);
      });
    } finally {
      await this.remove(repoPath);
    }
  }

  private async readCommitDiff(
    repoPath: string, fromCommitHash: string, toCommitHash: string, validateEqual = false
  ): Promise<CommitDiff> {
    const result: CommitDiff = { fromCommitHash, toCommitHash, fromOnly: [], toOnly: [] };
    if (fromCommitHash === toCommitHash && !validateEqual) {
      return result;
    }
    const output = await this.runGit([
      "log", "--left-right", "--topo-order", "-z", "--format=%m%x00%H%x00%cI%x00%s",
      `${fromCommitHash}...${toCommitHash}`, "--",
    ], repoPath, { trimOutput: false });
    const fields = output.split("\0");
    if (fields[fields.length - 1] === "") {
      fields.pop();
    }
    if (fields.length % 4 !== 0) {
      throw new Error("Git returned an invalid commit comparison.");
    }
    for (let index = 0; index < fields.length; index += 4) {
      const [side, hash, committedAt, subject] = fields.slice(index, index + 4);
      if ((side !== "<" && side !== ">") || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(hash) ||
        Number.isNaN(Date.parse(committedAt))) {
        throw new Error("Git returned an invalid commit comparison.");
      }
      (side === "<" ? result.fromOnly : result.toOnly).push({ hash, subject, committedAt });
    }
    return result;
  }

  private async resolveCommitHash(
    repoPath: string, ref: string, candidates = [ref]
  ): Promise<string> {
    for (const candidate of candidates) {
      try {
        const hash = await this.runGit([
          "rev-parse", "--verify", "--quiet", "--end-of-options", `${candidate}^{commit}`,
        ], repoPath);
        if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(hash)) {
          throw new Error("Git returned an invalid commit hash.");
        }
        return hash;
      } catch (error) {
        if (!(error instanceof GitCommandError) || error.code !== 1) {
          throw error;
        }
      }
    }
    throw new GitRefNotFoundError(ref);
  }

  async remove(repoPath: string): Promise<void> {
    return this.withRepositoryAccess(repoPath, true, () => this.removeUnlocked(repoPath));
  }

  private async removeUnlocked(repoPath: string): Promise<void> {
    await rm(repoPath, { recursive: true, force: true });
  }

  async hasClone(repoUrl: string, targetPath: string): Promise<boolean> {
    return this.withRepositoryAccess(targetPath, false, () =>
      this.hasCloneUnlocked(repoUrl, targetPath)
    );
  }

  private async hasCloneUnlocked(repoUrl: string, targetPath: string): Promise<boolean> {
    const remote = this.resolveRepoUrl(repoUrl);
    try {
      await access(path.join(targetPath, ".git"));
      const originUrl = await this.runGit(["config", "--get", "remote.origin.url"], targetPath);
      return this.resolveRepoUrl(originUrl) === remote;
    } catch {
      return false;
    }
  }

  private async syncRepositoryTags(repoUrl: string, targetPath: string): Promise<string> {
    if (!(await this.hasCloneUnlocked(repoUrl, targetPath))) {
      await this.removeUnlocked(targetPath);
      await mkdir(path.dirname(targetPath), { recursive: true });
      await this.runGit([
        "clone",
        "--no-checkout",
        "--filter=blob:none",
        repoUrl,
        targetPath,
      ]);
      // Clone packs the initial tag refs instead of creating one loose file per tag.
      return targetPath;
    }

    if (await this.getOptionalConfig(targetPath, "dependencyParser.tagCatalog") === "selective") {
      await this.expandCatalog(repoUrl, targetPath);
      return targetPath;
    }

    await this.runGit(
      ["fetch", "--atomic", "--no-tags", "--prune", "--refmap=", "origin", "+refs/tags/*:refs/tags/*"],
      targetPath
    );
    return targetPath;
  }

  private async expandCatalog(repoUrl: string, targetPath: string): Promise<void> {
    const head = (await this.runGit(["ls-remote", "--symref", "--", repoUrl, "HEAD"]))
      .replace(/\r\n/g, "\n");
    const defaultBranch = /^ref: (refs\/heads\/[^\t\r\n]+)\tHEAD$/m.exec(head)?.[1];
    const hasHead = /^[a-f0-9]{40}(?:[a-f0-9]{24})?\tHEAD$/im.test(head);
    const args = ["fetch", "--atomic", "--no-tags", "--prune", "--refmap="];
    if (await this.runGit(["rev-parse", "--is-shallow-repository"], targetPath) === "true") {
      args.push("--unshallow");
    }
    args.push("origin", "+refs/heads/*:refs/remotes/origin/*", "+refs/tags/*:refs/tags/*");
    if (hasHead) {
      args.push("+HEAD:refs/remotes/origin/HEAD");
    }
    await this.runGit(args, targetPath);
    if (hasHead) {
      const oid = await this.runGit(["rev-parse", "refs/remotes/origin/HEAD^{commit}"], targetPath);
      if (defaultBranch) {
        await this.runGit(["update-ref", defaultBranch, oid], targetPath);
        await this.runGit(["symbolic-ref", "HEAD", defaultBranch], targetPath);
        const name = defaultBranch.slice("refs/heads/".length);
        await this.runGit(["config", `branch.${name}.remote`, "origin"], targetPath);
        await this.runGit(["config", `branch.${name}.merge`, defaultBranch], targetPath);
      } else {
        await this.runGit(["update-ref", "--no-deref", "HEAD", oid], targetPath);
      }
    }
    await this.runGit(["config", "dependencyParser.tagCatalog", "packed"], targetPath);
  }

  private async supportsReftable(): Promise<boolean> {
    this.reftableSupport ??= this.runGit(["--version"]).then(version => {
      const match = /^git version (\d+)\.(\d+)/.exec(version);
      const supported = Boolean(match &&
        (Number(match[1]) > 2 || Number(match[1]) === 2 && Number(match[2]) >= 45));
      if (!supported) {
        logger.warn({ gitVersion: version }, "Selective tag discovery needs Git 2.45+; using packed cloning.");
      }
      return supported;
    });
    return this.reftableSupport;
  }

  private async getOptionalConfig(repoPath: string, key: string): Promise<string | null> {
    try {
      return await this.runGit(["config", "--get", key], repoPath);
    } catch (error) {
      if (error instanceof GitCommandError && error.code === 1) {
        return null;
      }
      throw error;
    }
  }

  private async readRemoteRefs(repoUrl: string, patterns: readonly string[]): Promise<GitRef[]> {
    const output = await this.runGit(["ls-remote", "--refs", "--", repoUrl, ...patterns]);
    return this.parseRefs(output);
  }

  private parseRefs(output: string): GitRef[] {
    return output.split(/\r?\n/).filter(Boolean).map(line => {
      const [oid, name] = line.split("\t");
      if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(oid ?? "") || !name?.startsWith("refs/")) {
        throw new Error("Git returned an invalid reference advertisement.");
      }
      return { oid, name };
    });
  }

  private async initializeTagCatalog(
    repoUrl: string, targetPath: string, oidLength: number
  ): Promise<void> {
    await mkdir(path.dirname(targetPath), { recursive: true });
    await this.runGit([
      "init", "--quiet", "--ref-format=reftable",
      `--object-format=${oidLength === 64 ? "sha256" : "sha1"}`, targetPath,
    ]);
    await this.runGit(["remote", "add", "origin", repoUrl], targetPath);
    await this.runGit(["config", "remote.origin.promisor", "true"], targetPath);
    await this.runGit(["config", "remote.origin.partialclonefilter", "blob:none"], targetPath);
    await this.runGit(["config", "extensions.partialClone", "origin"], targetPath);
    await this.runGit(["config", "dependencyParser.tagCatalog", "selective"], targetPath);
  }

  private async syncSelectedTags(
    repoUrl: string, targetPath: string, tagPattern: string, existing: boolean
  ): Promise<string> {
    const remote = (await this.readRemoteRefs(repoUrl, ["refs/tags/*"]))
      .filter(ref => ref.name.startsWith("refs/tags/"));
    const pattern = new RegExp(tagPattern);
    const selected = remote.filter(ref => pattern.test(ref.name.slice("refs/tags/".length)));
    if (!existing && (remote.length === 0 || selected.length === remote.length)) {
      return this.syncRepositoryTags(repoUrl, targetPath);
    }
    if (!existing) {
      await this.removeUnlocked(targetPath);
      await this.initializeTagCatalog(repoUrl, targetPath, remote[0].oid.length);
    }
    const local = this.parseRefs(await this.runGit([
      "for-each-ref", "--format=%(objectname)%09%(refname)", "refs/tags",
    ], targetPath));
    const localOids = new Map(local.map(ref => [ref.name, ref.oid]));
    const changed = selected.filter(ref => localOids.get(ref.name) !== ref.oid);
    if (changed.length > 0) {
      // An anonymous target avoids a second full ref listing; retain origin as the sole promisor.
      await this.runGit([
        "fetch", "--atomic", "--depth=1", "--filter=blob:none", "--no-tags",
        "--refmap=", "--no-auto-maintenance", "--stdin", "--", repoUrl,
      ], targetPath, { input: changed.map(ref => `+${ref.oid}:${ref.name}`).join("\n") + "\n" });
      if (await this.getOptionalConfig(targetPath, `remote.${repoUrl}.promisor`) !== null) {
        await this.runGit(["config", "--remove-section", `remote.${repoUrl}`], targetPath);
      }
    }
    const selectedNames = new Set(selected.map(ref => ref.name));
    const deleted = local.filter(ref => !selectedNames.has(ref.name));
    if (deleted.length > 0) {
      await this.runGit(["update-ref", "--stdin"], targetPath, {
        input: "start\n" + deleted.map(ref => `delete ${ref.name} ${ref.oid}`).join("\n") +
          "\nprepare\ncommit\n",
      });
    }
    const actual = this.parseRefs(await this.runGit([
      "for-each-ref", "--format=%(objectname)%09%(refname)", "refs/tags",
    ], targetPath));
    const expected = new Map(selected.map(ref => [ref.name, ref.oid]));
    if (actual.length !== expected.size || actual.some(ref => expected.get(ref.name) !== ref.oid)) {
      throw new Error("Git tag catalog did not match the complete remote snapshot.");
    }
    logger.debug({ discoveredTags: remote.length, matchingTags: selected.length,
      fetchedTags: changed.length, removedRefs: deleted.length }, "Git tag catalog synchronized.");
    return targetPath;
  }

  private async createClonePath(): Promise<string> {
    const baseDirectory = path.join(os.tmpdir(), "dependency-parser");
    await mkdir(baseDirectory, { recursive: true });
    return mkdtemp(path.join(baseDirectory, "repo-"));
  }

  private resolveRepoUrl(repoUrl: string): string {
    if (repoUrl.trim() === "" || repoUrl.startsWith("-")) {
      throw new Error("Repository URL is required and must not start with '-'.");
    }
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(repoUrl);
    const scp = !/^[a-z]:/i.test(repoUrl) && /^[^/\\]+:/.test(repoUrl);
    return url || scp ? repoUrl : path.resolve(repoUrl);
  }

  private withRepositoryAccess<Result>(
    repoPath: string,
    write: boolean,
    operation: () => Promise<Result>
  ): Promise<Result> {
    const key = path.resolve(repoPath);
    const lock = this.repositoryLocks.get(key) ?? new ReadWriteLock();
    this.repositoryLocks.set(key, lock);
    const pending = write ? lock.write(operation) : lock.read(operation);
    return pending.finally(() => {
      if (lock.idle && this.repositoryLocks.get(key) === lock) {
        this.repositoryLocks.delete(key);
      }
    });
  }

  private runGit(
    args: string[],
    cwd?: string,
    options?: GitCommandOptions
  ): Promise<string> {
    return this.commandLimiter.run(() => this.executeGit(args, cwd, options));
  }

  private buildGitEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    if (!this.githubCredentials) {
      return environment;
    }

    const configCount = environment.GIT_CONFIG_COUNT ?? "0";
    const count = Number(configCount);
    if (!/^\d+$/.test(configCount) || !Number.isSafeInteger(count + 2)) {
      throw new Error("Invalid GIT_CONFIG_COUNT for GitHub token authentication.");
    }

    // Clear inherited headers at this scope before supplying the token.
    return {
      ...environment,
      GIT_CONFIG_COUNT: String(count + 2),
      [`GIT_CONFIG_KEY_${count}`]: "http.https://github.com/.extraHeader",
      [`GIT_CONFIG_VALUE_${count}`]: "",
      [`GIT_CONFIG_KEY_${count + 1}`]: "http.https://github.com/.extraHeader",
      [`GIT_CONFIG_VALUE_${count + 1}`]: `AUTHORIZATION: basic ${this.githubCredentials}`,
    };
  }

  private async executeGit(
    args: string[],
    cwd?: string,
    options?: GitCommandOptions
  ): Promise<string> {
    try {
      const command = execFile(this.gitBinary, args, {
        cwd,
        env: this.buildGitEnvironment(),
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
      });
      let inputError: Error | undefined;
      if (options?.input !== undefined) {
        if (!command.child.stdin) {
          throw new Error("Git stdin is unavailable.");
        }
        command.child.stdin.on("error", error => { inputError = error; });
        command.child.stdin.end(options.input, "utf8");
      }
      const { stdout } = await command;
      if (inputError) {
        throw inputError;
      }

      return options?.trimOutput === false ? stdout : stdout.trim();
    } catch (error) {
      const gitError = error as ExecFileError;
      throw new GitCommandError(this.buildGitErrorMessage(args, gitError), gitError.code);
    }
  }

  private buildGitErrorMessage(args: string[], error: ExecFileError): string {
    const stderr = error.stderr?.trim();
    const stdout = error.stdout?.trim();
    const details = stderr || stdout || error.message;

    const message = `Git command failed: ${this.gitBinary} ${args.join(" ")}. ${details}`;
    if (!this.githubToken || !this.githubCredentials) {
      return message;
    }
    return message
      .split(this.githubCredentials).join("[REDACTED]")
      .split(this.githubToken).join("[REDACTED]");
  }

  private parseTagLine(line: string): Version {
    const [version, creationDateValue, objectHash, peeledObjectHash] = line.split("\t");
    const commitHash = peeledObjectHash || objectHash || null;

    return new Version(
      version,
      creationDateValue ? new Date(creationDateValue) : null,
      commitHash
    );
  }

  private assertSafeRef(ref: string): void {
    if (ref.trim() === "" || ref.startsWith("-") || /[\0\r\n]/.test(ref)) {
      throw new Error(`Invalid git ref "${ref}".`);
    }
  }

  private normalizeRepoFilePath(filePath: string): string {
    const normalizedPath = filePath.trim().replace(/\\/g, "/");
    const pathSegments = normalizedPath.split("/");

    if (
      normalizedPath === "" ||
      path.posix.isAbsolute(normalizedPath) ||
      pathSegments.includes("..")
    ) {
      throw new Error(`Invalid repository file path "${filePath}".`);
    }

    return normalizedPath.replace(/^\.\//, "");
  }

  private resolveRepoFilePath(repoPath: string, filePath: string): string {
    const absoluteRepoPath = path.resolve(repoPath);
    const absoluteFilePath = path.resolve(repoPath, filePath);
    const relativePath = path.relative(absoluteRepoPath, absoluteFilePath);

    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error(`File "${filePath}" is outside of repository "${repoPath}".`);
    }

    return absoluteFilePath;
  }

  private resolveRepoGitPath(repoPath: string, filePath: string): string {
    const absoluteRepoPath = path.resolve(repoPath);
    const absoluteFilePath = this.resolveRepoFilePath(repoPath, filePath);
    const relativePath = path.relative(absoluteRepoPath, absoluteFilePath);

    return relativePath.split(path.sep).join("/");
  }
}
