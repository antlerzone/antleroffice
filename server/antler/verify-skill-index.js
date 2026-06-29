#!/usr/bin/env node
/**
 * P1 verification — keyword skill index + on-demand systemForAgent loading.
 * Usage: node server/antler/verify-skill-index.js
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const results = [];

function pass(name, detail) {
  results.push({ name, ok: true, detail });
  console.log(`OK ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(name, detail) {
  results.push({ name, ok: false, detail });
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

function verifySkillIndexModule() {
  const skillIndex = require("./skill-index");

  const entries = skillIndex.buildIndex([
    {
      id: "xhs_publish",
      name: "XHS Publisher",
      description: "Publish posts to Xiaohongshu",
      keywords: ["小红书", "xhs", "种草"],
      system: "FULL XHS SYSTEM PROMPT",
    },
    {
      id: "bookkeeper",
      name: "Bookkeeper",
      description: "Accounting entries",
      system: "FULL BOOKKEEPER SYSTEM PROMPT",
    },
  ]);

  const matched = skillIndex.matchSkills("请帮我发一篇小红书种草笔记", entries);
  if (matched.length === 1 && matched[0].id === "xhs_publish") {
    pass("matchSkills hits explicit keyword", matched[0].id);
  } else {
    fail("matchSkills hits explicit keyword", JSON.stringify(matched.map((s) => s.id)));
  }

  const none = skillIndex.matchSkills("整理一下会议纪要", entries);
  if (!none.length) {
    pass("matchSkills returns empty when no hit");
  } else {
    fail("matchSkills returns empty when no hit", JSON.stringify(none.map((s) => s.id)));
  }

  const inferred = skillIndex.inferKeywords({ id: "ad_copywriter", name: "Ad Copywriter", description: "Write ads" });
  if (inferred.includes("Ad Copywriter") || inferred.includes("copywriter")) {
    pass("inferKeywords fallback", inferred.slice(0, 3).join(", "));
  } else {
    fail("inferKeywords fallback", inferred.join(", "));
  }

  const block = skillIndex.renderIndexBlock(entries);
  if (block.includes("keyword index") && block.includes("XHS Publisher")) {
    pass("renderIndexBlock", `${block.length} chars`);
  } else {
    fail("renderIndexBlock", "missing expected lines");
  }
}

function verifySystemForAgent() {
  const tmp = path.join(os.tmpdir(), `ao2-skill-index-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  process.env.ANTLEROFFICE_DATA_DIR = tmp;

  const store = require("./store");
  store.setDataDir(tmp);

  const registry = require("./registry-store");
  registry.addSkill({
    name: "Primary Dept",
    system: "PRIMARY DEPT FULL SYSTEM",
    keywords: ["primary"],
  });
  const primary = registry.listSkills().find((s) => s.name === "Primary Dept");
  registry.updateSkill(primary.id, { system: primary.system });

  registry.addSkill({
    name: "Extra XHS",
    system: "EXTRA XHS FULL SYSTEM BODY",
    keywords: ["小红书", "xhs"],
  });
  const extra = registry.listSkills().find((s) => s.name === "Extra XHS");

  const agentRuntime = require("./agent-runtime");

  const agentHit = {
    role: "custom_worker",
    skillIds: [primary.id, extra.id],
    baselineSkillIds: [primary.id],
  };

  const promptHit = agentRuntime.systemForAgent(agentHit, { taskText: "发小红书帖子" });
  if (promptHit.includes("PRIMARY DEPT FULL SYSTEM") && promptHit.includes("EXTRA XHS FULL SYSTEM BODY")) {
    pass("systemForAgent loads primary + matched extra", `${promptHit.length} chars`);
  } else {
    fail("systemForAgent loads primary + matched extra", promptHit.slice(0, 200));
  }

  const promptMiss = agentRuntime.systemForAgent(agentHit, { taskText: "写周报" });
  if (promptMiss.includes("PRIMARY DEPT FULL SYSTEM") && !promptMiss.includes("EXTRA XHS FULL SYSTEM BODY")) {
    pass("systemForAgent keeps index-only for unmatched extra");
  } else {
    fail("systemForAgent keeps index-only for unmatched extra", promptMiss.includes("EXTRA XHS FULL SYSTEM BODY") ? "extra expanded" : promptMiss.slice(0, 200));
  }

  if (promptMiss.includes("keyword index") && promptMiss.includes("Extra XHS")) {
    pass("systemForAgent renders lightweight index");
  } else {
    fail("systemForAgent renders lightweight index");
  }

  const fullLen = promptHit.length;
  const indexLen = promptMiss.length;
  pass("context size delta", `matched ${fullLen} vs index-only ${indexLen} (saved ${fullLen - indexLen})`);

  fs.rmSync(tmp, { recursive: true, force: true });
  delete require.cache[require.resolve("./store")];
  delete require.cache[require.resolve("./registry-store")];
  delete require.cache[require.resolve("./agent-runtime")];
}

function main() {
  console.log("AntlerOffice P1 skill index verify\n");
  verifySkillIndexModule();
  console.log("");
  verifySystemForAgent();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    process.exitCode = 1;
    for (const f of failed) console.error(`  - ${f.name}: ${f.detail}`);
  } else {
    console.log("\nAll P1 skill index checks passed.");
  }
}

main();
