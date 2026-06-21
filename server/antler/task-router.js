// Department routing — Coliving operational expenses before Accounting when portal OAuth is connected.

const roster = require('./roster');

const EXPENSE = /(expense|invoice|bill|payment|receipt|cost|spend|报销|费用|发票|utility|utilities|maintenance|repair|cleaning)/i;
const COLIVING_OPS =
  /(coliving|room|tenant|vacant|portal\.colivingjb|colivin|租|房|水电|维修|清洁)/i;
const ACCOUNTING_ONLY =
  /(bukku|reconcil|reconcile|verify|verification|month.?end|bookkeep|flux|variance|tax|payroll|budget|forecast|ledger|aging|close checklist|financial report)/i;
const ADMIN_DOC =
  /(archive|filing|ssm|license|licence|permit|certificate|document vault|admin vault|_inbox|materials\/admin vault)/i;

function colivingPortalConnected() {
  try {
    return require('./portal-partner-oauth').isConnected('coliving');
  } catch {
    return false;
  }
}

function route(instruction) {
  const text = String(instruction || '');

  if (ADMIN_DOC.test(text)) {
    const admin = roster.byRole('admin');
    if (admin) return admin;
  }

  if (ACCOUNTING_ONLY.test(text)) {
    const accounting = roster.byRole('accounting');
    if (accounting) return accounting;
  }

  if (EXPENSE.test(text) && colivingPortalConnected()) {
    const operational = COLIVING_OPS.test(text) || !ACCOUNTING_ONLY.test(text);
    if (operational) {
      const coliving = roster.byRole('coliving_admin');
      if (coliving) return coliving;
    }
  }

  return roster.route(text);
}

module.exports = { route, colivingPortalConnected };
