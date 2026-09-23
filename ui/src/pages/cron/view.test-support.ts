import { render } from "lit";
import { expect } from "vitest";
import type { CronJob } from "../../api/types.ts";
import { createChannelCapability } from "../../lib/channels/index.ts";
import { createInitialCronState } from "../../lib/cron/index.ts";
import { DEFAULT_CRON_FORM } from "../../test-helpers/cron.ts";
import type { CronProps } from "./view-types.ts";
import { renderCron } from "./view.ts";

export function createCronViewJob(id: string, overrides: Partial<CronJob> = {}): CronJob {
  return {
    id,
    name: "Daily ping",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "cron", expr: "0 9 * * *" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "ping" },
    ...overrides,
  } as CronJob;
}

type CronStateAliases = {
  loading?: CronProps["state"]["cronLoading"];
  hasLoaded?: boolean;
  listError?: CronProps["state"]["cronJobsError"];
  status?: CronProps["state"]["cronStatus"];
  jobs?: CronProps["state"]["cronJobs"];
  jobsTotal?: CronProps["state"]["cronJobsTotal"];
  jobsQuery?: CronProps["state"]["cronJobsQuery"];
  jobsEnabledFilter?: CronProps["state"]["cronJobsEnabledFilter"];
  jobsScheduleKindFilter?: CronProps["state"]["cronJobsScheduleKindFilter"];
  jobsLastStatusFilter?: CronProps["state"]["cronJobsLastStatusFilter"];
  busy?: CronProps["state"]["cronBusy"];
  form?: CronProps["state"]["cronForm"];
  fieldErrors?: CronProps["state"]["cronFieldErrors"];
  editingJob?: CronProps["state"]["cronEditingJob"];
  createOpen?: CronProps["state"]["cronCreateOpen"];
  runs?: CronProps["state"]["cronRuns"];
  runsQuery?: CronProps["state"]["cronRunsQuery"];
  runsSortDir?: CronProps["state"]["cronRunsSortDir"];
};

type CronTestOverrides = Omit<Partial<CronProps>, "state" | "channels" | "suggestions"> &
  CronStateAliases & {
    state?: Partial<CronProps["state"]>;
    channelIds?: string[];
    channelLabels?: NonNullable<CronProps["channels"]["channelsSnapshot"]>["channelLabels"];
    channelMeta?: NonNullable<CronProps["channels"]["channelsSnapshot"]>["channelMeta"];
    suggestions?: Partial<CronProps["suggestions"]>;
  };

function createCronViewProps(overrides: CronTestOverrides = {}): CronProps {
  const jobs = overrides.jobs ?? [];
  const jobsTotal = overrides.jobsTotal ?? 0;
  const state = Object.assign(createInitialCronState({ connected: true }), {
    cronLoading: overrides.loading ?? false,
    cronJobsError: overrides.listError ?? null,
    cronStatus:
      overrides.status === undefined
        ? {
            enabled: true,
            triggersEnabled: true,
            jobs: Math.max(jobsTotal, jobs.length),
          }
        : overrides.status,
    cronJobs: jobs,
    cronJobsTotal: jobsTotal,
    cronJobsSnapshotRevision: (overrides.hasLoaded ?? true) ? "test" : null,
    cronJobsQuery: overrides.jobsQuery ?? "",
    cronJobsEnabledFilter: overrides.jobsEnabledFilter ?? "all",
    cronJobsScheduleKindFilter: overrides.jobsScheduleKindFilter ?? "all",
    cronJobsLastStatusFilter: overrides.jobsLastStatusFilter ?? "all",
    cronError: overrides.error ?? null,
    cronBusy: overrides.busy ?? false,
    cronForm: overrides.form ?? { ...DEFAULT_CRON_FORM },
    cronFieldErrors: overrides.fieldErrors ?? {},
    cronEditingJob: overrides.editingJob ?? null,
    cronCreateOpen: overrides.createOpen ?? false,
    cronRuns: overrides.runs ?? [],
    cronRunsQuery: overrides.runsQuery ?? "",
    cronRunsSortDir: overrides.runsSortDir ?? "desc",
    ...overrides.state,
  });
  const channelState = createChannelCapability({
    snapshot: { client: null, phase: "connected" },
    subscribe: () => () => undefined,
  }).state;
  channelState.channelsSnapshot = {
    ts: 0,
    channelOrder: overrides.channelIds ?? [],
    channelLabels: overrides.channelLabels ?? {},
    channelMeta: overrides.channelMeta ?? [],
    channels: {},
    channelAccounts: {},
    channelDefaultAccountId: {},
  };
  const suggestions: CronProps["suggestions"] = {
    agentSuggestions: [],
    modelSuggestions: [],
    timezoneSuggestions: [],
    deliveryToSuggestions: [],
    accountTargets: [],
    ...overrides.suggestions,
  };
  return {
    canManage: overrides.canManage ?? true,
    error: overrides.error ?? null,
    heartbeatScratch: overrides.heartbeatScratch ?? "",
    listTab: overrides.listTab ?? "tasks",
    detailTab: overrides.detailTab ?? "settings",
    runsState: overrides.runsState ?? "ready",
    onListTabChange: () => undefined,
    onDetailTabChange: () => undefined,
    onFormChange: () => undefined,
    onRefresh: () => undefined,
    onSubmit: () => undefined,
    onSubmitRunNow: () => undefined,
    onSelectJob: () => undefined,
    onOpenCreate: () => undefined,
    onClosePanel: () => undefined,
    onClone: () => undefined,
    onToggle: () => undefined,
    onRun: () => undefined,
    onRemove: () => undefined,
    onLoadMoreJobs: () => undefined,
    onJobsFiltersChange: () => undefined,
    onJobsFiltersReset: () => undefined,
    onLoadMoreRuns: () => undefined,
    onRunsFiltersChange: () => undefined,
    ...overrides,
    state,
    channels: channelState,
    suggestions,
  };
}

export function renderCronView(overrides: CronTestOverrides = {}) {
  const container = document.createElement("div");
  render(renderCron(createCronViewProps(overrides)), container);
  return container;
}

export function getButtonByText(container: Element, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (btn) => btn.textContent?.replace(/\s+/g, " ").trim() === text,
  );
  expect(button).toBeInstanceOf(HTMLButtonElement);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected button with text "${text}"`);
  }
  return button;
}

export function getElement<T extends Element>(
  container: Element,
  selector: string,
  constructor: new () => T,
): T {
  const element = container.querySelector<T>(selector);
  expect(element).toBeInstanceOf(constructor);
  if (!(element instanceof constructor)) {
    throw new Error(`Expected ${selector} to match ${constructor.name}`);
  }
  return element;
}

export function selectSegmented(control: HTMLElement) {
  const group = control.closest<HTMLElement & { value: string }>("wa-radio-group");
  expect(group).not.toBeNull();
  if (!group) {
    return;
  }
  group.value = control.getAttribute("value") ?? "";
  group.dispatchEvent(new Event("change", { bubbles: true }));
}

export function findToggleByLabel(container: Element, label: string) {
  return (
    Array.from(container.querySelectorAll("wa-switch.settings-toggle")).find((toggle) =>
      toggle.textContent?.includes(label),
    ) ?? null
  );
}
