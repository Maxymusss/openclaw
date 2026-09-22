import { render } from "lit";
import { expect } from "vitest";
import type { CronJob } from "../../api/types.ts";
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

type CronTestOverrides = Record<string, unknown>;

function createCronViewProps(overrides: CronTestOverrides = {}): CronProps {
  const value = <T>(key: string, fallback: T): T =>
    key in overrides ? (overrides[key] as T) : fallback;
  const jobs = value<CronProps["state"]["cronJobs"]>("jobs", []);
  const jobsTotal = value("jobsTotal", 0);
  const state = Object.assign(createInitialCronState({ connected: true }), {
    cronLoading: value("loading", false),
    cronJobsError: value("listError", null),
    cronJobsLoadingMore: value("jobsLoadingMore", false),
    cronStatus: value("status", {
      enabled: true,
      triggersEnabled: true,
      jobs: Math.max(jobsTotal, jobs.length),
    }),
    cronJobs: jobs,
    cronJobsTotal: jobsTotal,
    cronJobsHasMore: value("jobsHasMore", false),
    cronJobsSnapshotRevision: value("hasLoaded", true) ? "test" : null,
    cronJobsQuery: value("jobsQuery", ""),
    cronJobsEnabledFilter: value("jobsEnabledFilter", "all"),
    cronJobsScheduleKindFilter: value("jobsScheduleKindFilter", "all"),
    cronJobsLastStatusFilter: value("jobsLastStatusFilter", "all"),
    cronJobsTriggerFilter: value("jobsTriggerFilter", "all"),
    cronJobsSortBy: value("jobsSortBy", "nextRunAtMs"),
    cronJobsSortDir: value("jobsSortDir", "asc"),
    cronError: value("error", null),
    cronBusy: value("busy", false),
    cronForm: value("form", { ...DEFAULT_CRON_FORM }),
    cronFieldErrors: value("fieldErrors", {}),
    cronEditingJob: value("editingJob", null),
    cronCreateOpen: value("createOpen", false),
    cronRuns: value("runs", []),
    cronRunsTotal: value("runsTotal", 0),
    cronRunsHasMore: value("runsHasMore", false),
    cronRunsLoadingMore: value("runsLoadingMore", false),
    cronRunsStatuses: value("runsStatuses", []),
    cronRunsDeliveryStatuses: value("runsDeliveryStatuses", []),
    cronRunsQuery: value("runsQuery", ""),
    cronRunsSortDir: value("runsSortDir", "desc"),
    ...(overrides.state as Partial<CronProps["state"]> | undefined),
  });
  const channels = value<string[]>("channels", []);
  const channelState = {
    channelsSnapshot: {
      channelOrder: channels,
      channelLabels: value("channelLabels", {}),
      channelMeta: value("channelMeta", []),
    },
  } as unknown as CronProps["channels"];
  const suggestions: CronProps["suggestions"] = {
    agentSuggestions: value("agentSuggestions", []),
    modelSuggestions: value("modelSuggestions", []),
    timezoneSuggestions: value("timezoneSuggestions", []),
    deliveryToSuggestions: value("deliveryToSuggestions", []),
    accountTargets: value("accountSuggestions", []),
  };
  return {
    canManage: value("canManage", true),
    error: value("error", null),
    heartbeatScratch: value("heartbeatScratch", ""),
    listTab: value("listTab", "tasks"),
    detailTab: value("detailTab", "settings"),
    runsState: value("runsState", "ready"),
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
  } as CronProps;
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
