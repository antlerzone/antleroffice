#!/usr/bin/env node
/**
 * P2 verification ? task status machine + monitor notifications.
 * Usage: node server/antler/verify-task-monitor.js
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const results = [];

function pass(name, detail) {
  results.push({ name, ok: true, detail });
  console.log(`OK ${name}${detail ? ` ? ${detail}` : ""}`);
}

function fail(name, detail) {
  results.push({ name, ok: false, detail });
  console.error(`FAIL ${name}${detail ? ` ? ${detail}` : ""}`);
}

function setupTmp() {
  const tmp = path.join(os.tmpdir(), `ao2-task-mon-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  process.env.ANTLEROFFICE_DATA_DIR = tmp;
  const store = require("./store");
  store.setDataDir(tmp);
  return tmp;
}

function verifyWorkBoardAndMonitor() {
  const tmp = setupTmp();
  const registry = require("./registry-store");
  const workBoard = require("./work-board");
  const taskMonitor = require("./task-monitor");
  const taskPending = require("./task-pending-store");

  const job = workBoard.ensureTaskJob({
    threadId: "thread-1",
    agentId: "agent-1",
    agentLabel: "Marketing Junior",
    task: "Post to Facebook",
    shortTask: "FB post",
    ownerKey: "local:boss",
  });
  if (job.status === "pending") pass("ensureTaskJob creates pending job", job.id);
  else fail("ensureTaskJob creates pending job", job.status);

  workBoard.markTaskInProgress(job.id);
  const running = registry.getDeliverable(job.id);
  if (running.status === "in_progress") pass("markTaskInProgress");
  else fail("markTaskInProgress", running.status);

  let cooPosts = [];
  const origAddChat = require("./office-state").addChat;
  require("./office-state").addChat = (from, text, threadId) => {
    if (from === "coo") cooPosts.push(String(text));
    return origAddChat(from, text, threadId);
  };

  taskMonitor.handleNeedsInput({
    deliverableId: job.id,
    agent: { id: "agent-1", label: "Marketing Junior", role: "marketing_junior" },
    threadId: "thread-1",
    question: "Which Facebook page should I use?",
    instruction: "Post hello",
    rawTask: "Post hello",
    shortTask: "FB post",
    ownerKey: "local:boss",
  });

  const needs = registry.getDeliverable(job.id);
  if (needs.status === "needs_input") pass("needs_input status on deliverable");
  else fail("needs_input status", needs.status);

  const pending = taskPending.get("thread-1");
  if (pending?.agentId === "agent-1" && pending.partialText.includes("Facebook")) {
    pass("task-pending-store saved resume context");
  } else {
    fail("task-pending-store", JSON.stringify(pending));
  }

  if (cooPosts.some((t) => t.includes("needs your input"))) pass("COO notified on needs_input");
  else fail("COO notified on needs_input", cooPosts.join(" | "));

  cooPosts = [];
  taskMonitor.handleFailed({
    deliverableId: job.id,
    agent: { label: "IT" },
    threadId: "thread-2",
    error: "Build exploded",
  });
  if (cooPosts.some((t) => t.includes("failed"))) pass("COO immediate failure report");
  else fail("COO immediate failure report", cooPosts.join(" | "));

  const j2 = workBoard.ensureTaskJob({ threadId: "t-batch", agentId: "a2", agentLabel: "Admin", task: "t2", shortTask: "t2" });
  const j3 = workBoard.ensureTaskJob({ threadId: "t-batch2", agentId: "a3", agentLabel: "Sales", task: "t3", shortTask: "t3" });
  workBoard.markTaskInProgress(j2.id);
  workBoard.markTaskInProgress(j3.id);
  cooPosts = [];
  taskMonitor.handleComplete({ deliverableId: j2.id, agent: { label: "Admin" }, threadId: "t-batch", result: "Done A" });
  taskMonitor.handleComplete({ deliverableId: j3.id, agent: { label: "Sales" }, threadId: "t-batch2", result: "Done B" });
  taskMonitor.flushCompletions();
  const batchText = cooPosts.join("\n");
  if (cooPosts.length === 1 && batchText.includes("2 tasks completed")) {
    pass("completion batch summary", batchText.slice(0, 80));
  } else {
    fail("completion batch summary", batchText);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
}

function main() {
  console.log("AntlerOffice P2 task monitor verify\n");
  verifyWorkBoardAndMonitor();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
  else console.log("\nAll P2 task monitor checks passed.");
}

main();
