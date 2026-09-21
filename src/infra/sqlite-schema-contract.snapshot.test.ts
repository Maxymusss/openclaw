import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  collectSqliteSchemaIssues,
  createSqliteTableContractReader,
} from "./sqlite-schema-contract.js";

it("compares one committed schema and observes later changes on the next inspection", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "openclaw-schema-snapshot-"));
  const filename = path.join(directory, "state.sqlite");
  const writer = new DatabaseSync(filename);
  const schema = "CREATE TABLE a (id INTEGER); CREATE TABLE z (id INTEGER);";
  writer.exec(`PRAGMA journal_mode=WAL; ${schema}`);
  const reader = new DatabaseSync(filename, { readOnly: true });
  try {
    const readTable = createSqliteTableContractReader(reader);
    let changed = false;
    const issues = collectSqliteSchemaIssues(reader, schema, {}, (name) => {
      const contract = readTable(name);
      if (!changed) {
        changed = true;
        const remainingTable = name === "a" ? "z" : "a";
        writer.exec(`ALTER TABLE ${remainingTable} ADD COLUMN later TEXT`);
      }
      return contract;
    });
    expect(changed).toBe(true);
    expect(issues).toEqual([]);
    expect(reader.isTransaction).toBe(false);
    expect(collectSqliteSchemaIssues(reader, schema)).not.toEqual([]);
    expect(reader.isTransaction).toBe(false);
  } finally {
    reader.close();
    writer.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
