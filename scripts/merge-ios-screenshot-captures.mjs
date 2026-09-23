#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `${label} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function copyUniqueEntries(source, destination, seen, label) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (seen.has(entry.name)) {
      throw new Error(`duplicate ${label}: ${entry.name}`);
    }
    seen.add(entry.name);
    cpSync(path.join(source, entry.name), path.join(destination, entry.name), { recursive: true });
  }
}

export function mergeIosScreenshotCaptures({ family, inputRoot, outputRoot }) {
  if (!["iphone", "ipad-13"].includes(family)) {
    throw new Error(`unsupported screenshot family: ${family}`);
  }
  if (existsSync(outputRoot)) {
    throw new Error(`screenshot merge output already exists: ${outputRoot}`);
  }
  const shardRoots = readdirSync(inputRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(inputRoot, entry.name));
  if (shardRoots.length !== 2) {
    throw new Error(`expected two ${family} capture shards, found ${shardRoots.length}`);
  }

  const shards = shardRoots.map((root) => {
    const metadata = readJson(path.join(root, "metadata.json"), "capture metadata");
    if (
      metadata.deviceFamily !== family ||
      metadata.partCount !== 2 ||
      ![1, 2].includes(metadata.part)
    ) {
      throw new Error(
        `capture metadata does not bind ${family} part ${metadata.part ?? "unknown"}/2`,
      );
    }
    for (const key of ["xcodeVersion", "fastlaneVersion", "nodeVersion"]) {
      requiredString(metadata[key], `capture metadata ${key}`);
    }
    return { metadata, root };
  });
  shards.sort((left, right) => left.metadata.part - right.metadata.part);
  if (shards[0].metadata.part !== 1 || shards[1].metadata.part !== 2) {
    throw new Error(`capture metadata does not contain unique ${family} parts 1 and 2`);
  }
  const commonMetadata = {
    deviceFamily: family,
    fastlaneVersion: shards[0].metadata.fastlaneVersion,
    nodeVersion: shards[0].metadata.nodeVersion,
    xcodeVersion: shards[0].metadata.xcodeVersion,
  };
  for (const shard of shards.slice(1)) {
    for (const key of ["xcodeVersion", "fastlaneVersion", "nodeVersion"]) {
      if (shard.metadata[key] !== commonMetadata[key]) {
        throw new Error(`${family} capture shards disagree on ${key}`);
      }
    }
  }

  const screenshotsOutput = path.join(outputRoot, "screenshots");
  const xcresultsOutput = path.join(outputRoot, "xcresults");
  mkdirSync(screenshotsOutput, { recursive: true });
  mkdirSync(xcresultsOutput, { recursive: true });
  const screenshotNames = new Set();
  const xcresultNames = new Set();
  const attempts = [];
  for (const shard of shards) {
    copyUniqueEntries(
      path.join(shard.root, "screenshots"),
      screenshotsOutput,
      screenshotNames,
      "screenshot",
    );
    copyUniqueEntries(
      path.join(shard.root, "xcresults"),
      xcresultsOutput,
      xcresultNames,
      "xcresult",
    );
    const attemptPayload = readJson(
      path.join(shard.root, "capture-attempts.json"),
      "capture attempts",
    );
    if (attemptPayload.schemaVersion !== 1 || !Array.isArray(attemptPayload.attempts)) {
      throw new Error("capture attempts schema is invalid");
    }
    attempts.push(...attemptPayload.attempts);
  }
  const familyScreenshots = [...screenshotNames].filter((name) =>
    family === "iphone" ? name.startsWith("iPhone ") : name.startsWith("iPad "),
  );
  if (familyScreenshots.length !== 4) {
    throw new Error(`expected four ${family} screenshots, found ${familyScreenshots.length}`);
  }
  const watchScreenshots = [...screenshotNames].filter((name) => name.startsWith("Apple Watch "));
  if (watchScreenshots.length !== (family === "ipad-13" ? 1 : 0)) {
    throw new Error(`unexpected ${family} Watch screenshot count: ${watchScreenshots.length}`);
  }
  const expectedNames = [
    "01-control-connected",
    "02-chat-connected",
    "03-agent-connected",
    "04-settings-connected",
  ];
  for (const expected of expectedNames) {
    if (!familyScreenshots.some((name) => name.endsWith(`-${expected}.png`))) {
      throw new Error(`${family} screenshot merge omitted ${expected}`);
    }
  }

  writeFileSync(
    path.join(outputRoot, "capture-attempts.json"),
    `${JSON.stringify({ schemaVersion: 1, attempts }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(outputRoot, "metadata.json"),
    `${JSON.stringify(commonMetadata, null, 2)}\n`,
  );
  return {
    attempts: attempts.length,
    screenshots: screenshotNames.size,
    xcresults: xcresultNames.size,
  };
}

function main() {
  const { values } = parseArgs({
    options: {
      family: { type: "string" },
      input: { type: "string" },
      output: { type: "string" },
    },
  });
  const result = mergeIosScreenshotCaptures({
    family: requiredString(values.family, "--family"),
    inputRoot: path.resolve(requiredString(values.input, "--input")),
    outputRoot: path.resolve(requiredString(values.output, "--output")),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
