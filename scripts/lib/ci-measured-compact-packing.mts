import { createHash } from "node:crypto";
import type { CompactNodeTestShard, NodeTestShardGroup } from "./ci-node-test-plan.mts";

const FIXED_JOB_SECONDS = 60;
const MAX_PACKED_JOB_SECONDS = 720;

// Complete serial BS8/two-worker child observations from 35702479645,
// 35702772380 and 35707408465. Failed children are not successful wall samples.
const TOOLING_WALLS: Record<string, { fingerprint: string; seconds: number }> = {
  "core-tooling-1": {
    fingerprint: "cc58959ec5a174f28b70f4d5da588926b0a5304826dc91e0be424211ff9f63fe",
    seconds: 193,
  },
  "core-tooling-2": {
    fingerprint: "b9abf19c69cc96ef8c3a5d067d99a9166418a505678d5b7afb33c625c2aa1e91",
    seconds: 123,
  },
  "core-tooling-3": {
    fingerprint: "011e6f71982b1963c86b542ab81c6d6f7eedd0f728ca5bdb530857024b05a7b4",
    seconds: 161,
  },
  "core-tooling-4": {
    fingerprint: "bf341b52dd5e5ec871a4d74d00e56c9140e79297044e1e8cc423d262769d5ad2",
    seconds: 88,
  },
  "core-tooling-5": {
    fingerprint: "474e29d440551fc73c2ad678c0fe470d8abeba4845ae3549d16954a96851e756",
    seconds: 218,
  },
  "core-tooling-6-hosted-1": {
    fingerprint: "4b9450dedc5e7d153523fd52ccdaf8b83d9fc7f91baf26cfc92ec60c969c519e",
    seconds: 147,
  },
  "core-tooling-7-hosted-1": {
    fingerprint: "9935f8d1d694ed59a777d48a28814fd73b39785c20ec3c73c7e3fc78c7be2733",
    seconds: 276,
  },
  "core-tooling-12-hosted-1": {
    fingerprint: "8e700883fa93d7714ec08eaf74a97da3a14c76c9abdce25f80a5f034e5427059",
    seconds: 373,
  },
  "core-tooling-13-hosted-2": {
    fingerprint: "f0d4f13d612aa5d924a204c7c08612976a64d22c06f90a4dee24b6bc52d6b841",
    seconds: 240,
  },
  "core-tooling-12-hosted-2": {
    fingerprint: "46c9fd1d91f1b27a3053d7ffe8e2e855b45c0abe50572d444fc7d5fdd0318dd5",
    seconds: 206,
  },
  "core-tooling-13-hosted-1": {
    fingerprint: "ece99c506874619e8076efd308265838d150410af18866af36bbad53a448ff7f",
    seconds: 202,
  },
};

const SERIAL_TAIL_PAIRS = [
  {
    config: "test/vitest/vitest.cli-process.config.ts",
    children: [
      {
        key: "agentic-cli-process#selector-54-f7826a9ef2c4#generation-8e36d2d43531#part-6-of-7#include-14-4eac8c23d157",
        seconds: 498,
      },
      {
        key: "agentic-cli-process#selector-54-f7826a9ef2c4#generation-8e36d2d43531#part-7-of-7#include-15-d305c0ae5c0a",
        seconds: 643,
      },
    ],
  },
  {
    config: "test/vitest/vitest.tooling.config.ts",
    children: [
      {
        key: "core-tooling-6#selector-79-8962b2387129#generation-1f9a356acb92#part-2-of-2#include-78-7a0f52a33d72",
        seconds: 219,
      },
      {
        key: "core-tooling-8#selector-42-d01b820346c9#generation-7b6f7f3a2425#part-2-of-2#include-41-a1c886e94c53",
        seconds: 529,
      },
    ],
  },
];

function serialTwoWorkerJob(job: CompactNodeTestShard, runner: string): boolean {
  return (
    job.runner === runner &&
    job.planConcurrency === 1 &&
    !job.requiresDist &&
    !job.pretestBuildMode &&
    Object.entries(job.env ?? {}).every(
      ([key, value]) => key === "OPENCLAW_VITEST_MAX_WORKERS" && value === "2",
    ) &&
    job.groups.every(
      (group) =>
        !group.requiresDist &&
        !group.pretestBuildMode &&
        group.fallbackMaxWorkers === undefined &&
        group.minTotalMemoryBytes === undefined,
    )
  );
}

function toolingWall(group: NodeTestShardGroup): number | undefined {
  const observation = TOOLING_WALLS[group.shard_name];
  if (!observation || !group.includePatterns?.length) {
    return undefined;
  }
  // Hash the executed child contract, including selector order. A changed
  // inventory or policy expires this placement observation rather than shrinking it.
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        configs: group.configs,
        env: Object.fromEntries(
          Object.entries(group.env ?? {}).toSorted(([a], [b]) => a.localeCompare(b)),
        ),
        includePatterns: group.includePatterns,
        shard_name: group.shard_name,
        ...(group.timing_key ? { timing_key: group.timing_key } : {}),
      }),
    )
    .digest("hex");
  return fingerprint === observation.fingerprint ? observation.seconds : undefined;
}

/** Reuse measured serial placement without replacing the general capacity-pricing owner. */
export function rebalanceMeasuredHybridJobs(
  jobs: CompactNodeTestShard[],
  options: {
    runner: string;
    canShare: (groups: NodeTestShardGroup[]) => boolean;
  },
): CompactNodeTestShard[] {
  const split = jobs.flatMap((job) => {
    const pair =
      serialTwoWorkerJob(job, options.runner) && job.groups.length === 2
        ? SERIAL_TAIL_PAIRS.find(({ config, children }) =>
            children.every(({ key }) =>
              job.groups.some(
                (group) =>
                  group.timing_key === key &&
                  group.configs.length === 1 &&
                  group.configs[0] === config &&
                  Object.entries(group.env ?? {}).every(
                    ([name, value]) => name === "OPENCLAW_VITEST_MAX_WORKERS" && value === "2",
                  ),
              ),
            ),
          )
        : undefined;
    if (!pair) {
      return [job];
    }
    return job.groups.map((group, index) => ({
      ...job,
      checkName: index === 0 ? job.checkName : `${job.checkName}-tail`,
      shardName: index === 0 ? job.shardName : `${job.shardName}-tail`,
      groups: [group],
      predictedSeconds: Math.max(
        job.predictedSeconds ?? 0,
        pair.children.find(({ key }) => key === group.timing_key)!.seconds + FIXED_JOB_SECONDS,
      ),
    }));
  });

  const measured = split.flatMap((job) => {
    if (!serialTwoWorkerJob(job, options.runner)) {
      return [];
    }
    const walls = job.groups.map(toolingWall);
    if (walls.some((seconds) => seconds === undefined)) {
      return [];
    }
    return [
      {
        job,
        seconds: Math.max(
          job.predictedSeconds ?? 0,
          walls.reduce<number>((sum, seconds) => sum + seconds!, 0),
        ),
      },
    ];
  });
  const priced = new Map(
    measured.map(({ job, seconds }) => [
      job,
      {
        ...job,
        predictedSeconds: Math.ceil(seconds + FIXED_JOB_SECONDS),
      },
    ]),
  );
  const candidates = measured
    .filter(({ seconds }) => seconds + FIXED_JOB_SECONDS <= MAX_PACKED_JOB_SECONDS)
    .toSorted((a, b) => b.seconds - a.seconds || a.job.checkName.localeCompare(b.job.checkName));
  if (candidates.length < 2) {
    return split.map((job) => priced.get(job) ?? job);
  }
  const names = candidates.flatMap(({ job }) => job.groups.map((group) => group.shard_name));
  if (new Set(names).size !== names.length) {
    return split.map((job) => priced.get(job) ?? job);
  }

  const workBudget = MAX_PACKED_JOB_SECONDS - FIXED_JOB_SECONDS;
  const minimumJobs = Math.ceil(
    candidates.reduce((sum, entry) => sum + entry.seconds, 0) / workBudget,
  );
  for (let count = minimumJobs; count < candidates.length; count += 1) {
    const bins: Array<{ jobs: CompactNodeTestShard[]; seconds: number }> = Array.from(
      { length: count },
      () => ({ jobs: [], seconds: 0 }),
    );
    const fitted = candidates.every(({ job, seconds }) => {
      const bin = bins
        .filter(
          (candidate) =>
            candidate.seconds + seconds <= workBudget &&
            (candidate.jobs.length === 0 ||
              candidate.jobs[0]!.timeoutMinutes === job.timeoutMinutes) &&
            options.canShare([...candidate.jobs.flatMap((entry) => entry.groups), ...job.groups]),
        )
        .toSorted((a, b) => a.seconds - b.seconds)[0];
      if (!bin) {
        return false;
      }
      bin.jobs.push(job);
      bin.seconds += seconds;
      return true;
    });
    if (!fitted) {
      continue;
    }
    const retired = new Set(candidates.map(({ job }) => job));
    const packed = bins
      .filter((bin) => bin.jobs.length > 0)
      .map(({ jobs: originals, seconds }) =>
        Object.assign({}, originals[0]!, {
          groups: originals.flatMap((job) => job.groups),
          env: { ...originals[0]!.env, OPENCLAW_VITEST_MAX_WORKERS: "2" },
          predictedSeconds: Math.ceil(seconds + FIXED_JOB_SECONDS),
        }),
      );
    return [
      ...split.filter((job) => !retired.has(job)).map((job) => priced.get(job) ?? job),
      ...packed,
    ];
  }
  return split.map((job) => priced.get(job) ?? job);
}
