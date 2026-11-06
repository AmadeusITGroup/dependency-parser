const mainlinePattern = /^main\.([1-9]\d*)$/;
const pullRequestPattern = /^main\.(0|[1-9]\d*)-pr([1-9]\d*)\.([1-9]\d*)$/;

function validateAttempt(attempt) {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("Workflow run attempts must be positive safe integers.");
  }
}

function attemptTimestamp(run, attempt) {
  const timestamp = Date.parse(attempt === 1 ? run.created_at : run.run_started_at);
  if (!Number.isFinite(timestamp)) {
    throw new Error("Workflow attempt timestamps are missing or invalid.");
  }
  return timestamp;
}

function isAtOrBefore(run, attempt, cutoff) {
  const timestamp = attemptTimestamp(run, attempt);
  return timestamp < cutoff.timestamp ||
    (timestamp === cutoff.timestamp &&
      (run.id < cutoff.runId || (run.id === cutoff.runId && attempt <= cutoff.attempt)));
}

async function pullRequestSequence({ github, context, runAttempt, tags }) {
  validateAttempt(runAttempt);
  const number = context.payload.pull_request.number;
  const runName = `CI PR ${number}`;
  const { data: current } = await github.rest.actions.getWorkflowRun({
    ...context.repo, run_id: context.runId,
  });
  if (current.id !== context.runId || current.event !== "pull_request" ||
    current.display_title !== runName || current.run_attempt !== runAttempt) {
    throw new Error("Current PR workflow metadata does not match this run and attempt.");
  }
  const cutoff = {
    timestamp: attemptTimestamp(current, runAttempt), runId: current.id, attempt: runAttempt,
  };
  const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
    ...context.repo, workflow_id: current.workflow_id, per_page: 100,
  });
  if (!runs.some(run => run.id === current.id)) {
    throw new Error("The current PR run is missing from Actions history.");
  }

  let sequence = BigInt(runAttempt);
  for (const run of runs) {
    if (run.id === current.id || run.event !== "pull_request" || run.display_title !== runName) {
      continue;
    }
    validateAttempt(run.run_attempt);
    let attempt = run.run_attempt;
    let details = run;
    // Rank attempts, not run IDs: an older workflow can be rerun after newer PR commits.
    while (attempt > 1 && !isAtOrBefore(details, attempt, cutoff)) {
      attempt -= 1;
      if (attempt > 1) {
        const { data } = await github.rest.actions.getWorkflowRunAttempt({
          ...context.repo, run_id: run.id, attempt_number: attempt,
        });
        if (data.id !== run.id || data.run_attempt !== attempt) {
          throw new Error("Historical workflow metadata does not match the requested attempt.");
        }
        details = data;
      }
    }
    if (isAtOrBefore(details, attempt, cutoff)) {
      sequence += BigInt(attempt);
    }
  }
  for (const tag of tags) {
    const match = pullRequestPattern.exec(tag.name);
    if (match && match[2] === String(number) && BigInt(match[3]) >= sequence) {
      sequence = BigInt(match[3]) + 1n;
    }
  }
  return sequence;
}

async function determineVersion({ github, context, runAttempt, tags: suppliedTags }) {
  const isPullRequest = context.eventName === "pull_request";
  if (!isPullRequest &&
    context.ref !== `refs/heads/${context.payload.repository.default_branch}`) {
    throw new Error("Mainline build tags can only be allocated on the default branch.");
  }
  const tags = suppliedTags ?? await github.paginate(github.rest.repos.listTags, {
    ...context.repo, per_page: 100,
  });
  const mainline = tags.filter(tag => mainlinePattern.test(tag.name)).sort((left, right) => {
    const leftNumber = BigInt(left.name.slice("main.".length));
    const rightNumber = BigInt(right.name.slice("main.".length));
    return leftNumber > rightNumber ? -1 : leftNumber < rightNumber ? 1 : 0;
  });
  const latest = mainline[0]?.name ?? "main.0";
  let version;
  if (isPullRequest) {
    const sequence = await pullRequestSequence({ github, context, runAttempt, tags });
    version = `${latest}-pr${context.payload.pull_request.number}.${sequence}`;
  } else {
    const existing = mainline.find(tag => tag.commit.sha === context.sha);
    version = existing?.name ?? `main.${BigInt(latest.slice("main.".length)) + 1n}`;
  }
  if (version.length > 128) {
    throw new Error("The generated version exceeds Docker's 128-character tag limit.");
  }
  return { version, revision: context.sha };
}

module.exports = { determineVersion };
