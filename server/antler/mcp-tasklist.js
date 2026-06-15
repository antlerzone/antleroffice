// Split boss instructions into subtasks and assign MCP accounts (round-robin or @label).

function parseNumberedSteps(text) {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const numbered = lines.filter((l) => /^\d+[\.)]\s+/.test(l));
  if (numbered.length >= 2) {
    return numbered.map((line) => line.replace(/^\d+[\.)]\s+/, '').trim());
  }
  if (lines.length >= 2 && lines.every((l) => l.length < 240)) {
    return lines;
  }
  return [String(text || '').trim()].filter(Boolean);
}

function parseAccountHint(instruction) {
  const m = String(instruction || '').match(/^@([^:\n]+):\s*([\s\S]*)$/);
  if (!m) return null;
  return { label: m[1].trim(), instruction: (m[2] || '').trim() || String(instruction).trim() };
}

function buildAccountPool(mcpBindings, registry) {
  const pool = [];
  for (const binding of mcpBindings || []) {
    if (!binding?.mcpId) continue;
    const accounts = registry.resolveMcpAccountsForBinding(
      binding.mcpId,
      binding.accountIds,
    );
    for (const account of accounts) {
      pool.push({ mcpId: binding.mcpId, accountId: account.id, account });
    }
  }
  return pool;
}

/**
 * @returns {Array<{ instruction: string, mcpId: string|null, accountId: string|null, accountLabel: string|null }>}
 */
function assignTasklistAccounts(text, mcpBindings, registry) {
  const steps = parseNumberedSteps(text);
  const pool = buildAccountPool(mcpBindings, registry);

  return steps.map((instruction, index) => {
    const hinted = parseAccountHint(instruction);
    if (hinted) {
      const hit = pool.find(
        (p) => p.account.label.toLowerCase() === hinted.label.toLowerCase(),
      );
      if (hit) {
        return {
          instruction: hinted.instruction,
          mcpId: hit.mcpId,
          accountId: hit.accountId,
          accountLabel: hit.account.label,
        };
      }
    }

    const pick = pool.length ? pool[index % pool.length] : null;
    return {
      instruction: hinted?.instruction || instruction,
      mcpId: pick?.mcpId || null,
      accountId: pick?.accountId || null,
      accountLabel: pick?.account?.label || null,
    };
  });
}

function hasMultiAccountBindings(mcpBindings, registry) {
  const pool = buildAccountPool(mcpBindings, registry);
  return pool.length > 1;
}

module.exports = {
  parseNumberedSteps,
  assignTasklistAccounts,
  buildAccountPool,
  hasMultiAccountBindings,
};
