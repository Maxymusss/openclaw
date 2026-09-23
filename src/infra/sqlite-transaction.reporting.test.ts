import { DatabaseSync } from "node:sqlite";
import { isMainThread, threadId } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { runSqliteTransactionSync } from "./sqlite-transaction-core.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

const defaultLogger = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../logging/subsystem.js", () => ({ createSubsystemLogger: () => defaultLogger }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it.each(["default", "custom"])(
  "preserves the %s reporter and diagnostic thresholds",
  (reporter) => {
    const db = new DatabaseSync(":memory:");
    const customLogger = { warn: vi.fn() };
    const logger = reporter === "custom" ? customLogger : undefined;
    const selected = logger ?? defaultLogger;
    let now = 0;
    let stepMs = 499;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const exec = db.exec.bind(db);
    vi.spyOn(db, "exec").mockImplementation((sql) => {
      exec(sql);
      now += stepMs;
    });
    const write = () => {
      now += stepMs;
      return "committed";
    };
    try {
      const options = { logger, databaseLabel: "reporting", operationLabel: "write" };
      expect(runSqliteImmediateTransactionSync(db, write, options)).toBe("committed");
      expect(selected.warn).not.toHaveBeenCalled();
      stepMs = 1_000;
      expect(runSqliteImmediateTransactionSync(db, write, options)).toBe("committed");
      expect(selected.warn).toHaveBeenCalledTimes(3);
      const common = {
        async: false,
        database: "reporting",
        elapsedMs: 1_000,
        isMainThread,
        operation: "write",
        pid: process.pid,
        threadId,
      };
      expect(selected.warn).toHaveBeenNthCalledWith(1, "slow SQLite transaction lock wait", {
        ...common,
        step: "begin",
        beginAdmission: { nativeAttempts: 1, nativeMs: 1_000, serviceCalls: 0, serviceMs: 0 },
      });
      expect(selected.warn).toHaveBeenNthCalledWith(2, "slow SQLite transaction lock wait", {
        ...common,
        step: "commit",
      });
      expect(selected.warn).toHaveBeenNthCalledWith(3, "slow SQLite transaction hold", {
        ...common,
        elapsedMs: 2_000,
        thresholdMs: 1_000,
      });
      expect((logger ? defaultLogger : customLogger).warn).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  },
);

it.each([false, true])(
  "preserves the settled transaction when its hold reporter throws (rollback: %s)",
  (rollback) => {
    const db = new DatabaseSync(":memory:");
    const failure = new Error("original transaction failure");
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const heldAtReport: boolean[] = [];
    const warn = vi.fn(() => {
      heldAtReport.push(db.isTransaction);
      throw new Error("hold reporter failure");
    });
    try {
      db.exec("CREATE TABLE entries (value TEXT NOT NULL)");
      const operation = () =>
        runSqliteImmediateTransactionSync(
          db,
          () => {
            db.prepare("INSERT INTO entries VALUES ('committed')").run();
            now += 1_000;
            if (rollback) {
              throw failure;
            }
            return "committed";
          },
          { logger: { warn } },
        );
      if (rollback) {
        let caught: unknown;
        try {
          operation();
        } catch (error) {
          caught = error;
        }
        expect(caught).toBe(failure);
      } else {
        expect(operation()).toBe("committed");
      }
      expect(db.isTransaction).toBe(false);
      expect(db.prepare("SELECT value FROM entries").all()).toEqual(
        rollback ? [] : [{ value: "committed" }],
      );
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        "slow SQLite transaction hold",
        expect.objectContaining({ elapsedMs: 1_000 }),
      );
      expect(heldAtReport).toEqual([false]);
      expect(defaultLogger.warn).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  },
);

it("keeps an explicit no-op reporter independent of default reporting", () => {
  const db = new DatabaseSync(":memory:");
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    runSqliteTransactionSync(
      db,
      () => {
        now += 1_000;
      },
      "immediate",
      { logger: { warn() {} } },
    );
    expect(db.isTransaction).toBe(false);
    expect(defaultLogger.warn).not.toHaveBeenCalled();
  } finally {
    db.close();
  }
});
