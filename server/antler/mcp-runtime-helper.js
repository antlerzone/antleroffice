// Shared MCP runtime context for OpenClaw task prompts.

function registry() {
  return require('./registry-store');
}

function normalizeBindings(bindings) {
  if (!Array.isArray(bindings)) return [];
  return bindings
    .filter((b) => b && b.mcpId)
    .map((b) => ({
      mcpId: b.mcpId,
      accountIds: Array.isArray(b.accountIds) ? b.accountIds.filter(Boolean) : [],
    }));
}

function resolveMcpRuntimeFromBindings(bindings) {
  const normalized = normalizeBindings(bindings);

  const mcpServers = normalized
    .map((binding) => {
      const reg = registry();
      const mcp = reg.getMcp(binding.mcpId);
      if (!mcp) return null;
      const accounts = reg.resolveMcpAccountsForBinding(binding.mcpId, binding.accountIds);
      return {
        id: mcp.id,
        name: mcp.name,
        slug: (mcp.description || '').includes('bundled:')
          ? mcp.description.replace(/^.*bundled:/, '').trim()
          : '',
        url: mcp.url,
        command: mcp.command,
        args: mcp.args,
        env: mcp.env,
        transport: mcp.transport,
        bindingAccountIds: binding.accountIds,
        accounts: accounts.map((acc) => ({
          id: acc.id,
          label: acc.label,
          authType: acc.authType,
          headers: reg.buildMcpAccountHeaders(acc),
        })),
      };
    })
    .filter(Boolean);

  return { mcpBindings: normalized, mcpServers };
}

function formatMcpServersBlock(mcpServers) {
  const list = Array.isArray(mcpServers) ? mcpServers.filter(Boolean) : [];
  if (!list.length) return '';

  const lines = list.map((s) => {
    if (s.transport === 'http' && s.url) {
      const auth =
        s.accounts?.[0]?.headers && Object.keys(s.accounts[0].headers).length
          ? `\n  Auth headers: ${JSON.stringify(s.accounts[0].headers)}`
          : '';
      return `- ${s.name} (HTTP): ${s.url}${auth}`;
    }
    const cmd = [s.command, ...(s.args || [])].filter(Boolean).join(' ');
    const envKeys = s.env && typeof s.env === 'object' ? Object.keys(s.env).filter((k) => s.env[k]) : [];
    const envHint = envKeys.length ? `\n  Env: ${envKeys.join(', ')} (configured)` : '';
    return `- ${s.name} (stdio): ${cmd || s.id}${envHint}`;
  });

  return (
    'Bound MCP tools for this agent (use when the task needs web research, scraping, or browser automation):\n' +
    `${lines.join('\n')}\n` +
    'Prefer these tools over guessing when live web data or browser interaction is required.'
  );
}

module.exports = {
  resolveMcpRuntimeFromBindings,
  formatMcpServersBlock,
};
