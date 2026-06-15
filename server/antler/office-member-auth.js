// Plan 4a — verify remote office members against ECS (host-side).

const officeShare = require('./office-share');
const ecsAuth = require('./ecs-auth');

async function verifyMemberWithEcs(officeId, memberToken) {
  const base = ecsAuth.ecsBaseUrl();
  if (!base || !officeId || !memberToken) return { ok: false };
  try {
    const res = await fetch(`${base}/api/offices/${encodeURIComponent(officeId)}`, {
      headers: { Authorization: `Bearer ${memberToken}` },
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) return { ok: false };
    return {
      ok: true,
      role: data.office?.role || 'member',
      userId: data.user?.id || null,
      name: data.user?.name || data.user?.email || 'Member',
    };
  } catch {
    return { ok: false };
  }
}

async function attachOfficeMember(req) {
  const token = req.headers['x-office-member-token'];
  if (!token) {
    req.officeMember = null;
    return;
  }

  const share = officeShare.getShareInfo();
  if (!share.enabled || !share.officeId || share.role !== 'owner') {
    req.officeMember = null;
    return;
  }

  const verified = await verifyMemberWithEcs(share.officeId, token);
  if (!verified.ok) {
    req.officeMember = { invalid: true };
    return;
  }

  req.officeMember = {
    role: verified.role,
    userId: verified.userId,
    name: verified.name,
    token,
  };
}

function enforceOfficeAccess(req, res, next) {
  if (!req.path.startsWith('/api/')) return next();

  const skip = ['/api/boss/auth', '/api/office/share', '/api/auth', '/api/debug'].some((p) =>
    req.path.startsWith(p),
  );
  if (skip) return next();

  if (req.officeMember?.invalid) {
    return res.status(403).json({ ok: false, error: 'Invalid office member token' });
  }

  if (!req.officeMember || req.officeMember.role === 'owner') return next();

  if (req.method === 'GET' || req.method === 'HEAD') return next();

  const memberWritable = ['/api/boss-chats', '/api/agent-runtime', '/api/chat'].some((p) =>
    req.path.startsWith(p),
  );
  if (memberWritable) return next();

  return res.status(403).json({ ok: false, error: 'Read-only office member' });
}

module.exports = {
  attachOfficeMember,
  enforceOfficeAccess,
  verifyMemberWithEcs,
};
