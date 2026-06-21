// COO executes CEO Future Plan items — no self-brainstorming.

const office = require('./office-state');
const orgRoles = require('./org-roles');
const registry = require('./registry-store');
const heartbeatConfig = require('./coo-heartbeat-config-store');
const companyFramework = require('./company-framework');

function hasHigherPriorityWork(discoveredItems) {
  return (discoveredItems || []).some(
    (i) => i.needsCeo || (i.autoRunnable && i.priority <= 3 && i.kind !== 'ceo_future_plan'),
  );
}

function hasActiveJobs() {
  return registry.listDeliverables().some((d) => d.kind === 'job' && d.status === 'in_progress');
}

function canExecuteFuturePlan(config, discoveredItems) {
  if (!config.autonomousLoop) return false;
  if (!office.state?.agents) return false;
  if (!orgRoles.findHiredCoo()) return false;
  if (!companyFramework.isConfigured()) return false;
  if (!companyFramework.hasPendingFuturePlan()) return false;
  if (hasHigherPriorityWork(discoveredItems)) return false;
  if (hasActiveJobs()) return false;
  return true;
}

function discoverCeoFuturePlanItems(discoveredItems, config = heartbeatConfig.getConfig()) {
  if (!canExecuteFuturePlan(config, discoveredItems)) return [];

  const fw = companyFramework.getFramework();
  const next = companyFramework.peekNextFuturePlanItem(fw);
  if (!next) return [];

  return [
    {
      priority: 4,
      kind: 'ceo_future_plan',
      autoRunnable: true,
      needsCeo: false,
      futurePlanItem: next,
      summary: `CEO Future Plan: ${next.slice(0, 80)}${next.length > 80 ? '…' : ''}`,
      instruction: companyFramework.formatExecuteFuturePlanInstruction(next, fw),
    },
  ];
}

function markFuturePlanItemCompleted(itemText) {
  return companyFramework.completeFuturePlanItem(itemText);
}

module.exports = {
  discoverCeoFuturePlanItems,
  canExecuteFuturePlan,
  markFuturePlanItemCompleted,
};
