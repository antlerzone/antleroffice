// Plan 4a — host office sharing (invite code via ECS + local host URL).

const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');
const ecsAuth = require('./ecs-auth');

function sharePath() {
  return path.join(store.getDataDir(), 'office-share.json');
}

function readShare() {
  try {
    return JSON.parse(fs.readFileSync(sharePath(), 'utf8'));
  } catch {
    return { enabled: false, officeId: null, inviteCode: null, hostUrl: null, memberToken: null, role: null };
  }
}

function writeShare(data) {
  fs.writeFileSync(sharePath(), JSON.stringify(data, null, 2), 'utf8');
  return data;
}

async function enableShare({ name, bossAccessToken } = {}) {
  const base = ecsAuth.ecsBaseUrl();
  if (!base) throw new Error('ECS_BASE_URL required for office sharing');
  if (!bossAccessToken) throw new Error('Boss login required');

  const res = await fetch(`${base}/api/offices`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bossAccessToken}`,
    },
    body: JSON.stringify({ name: name || 'AntlerOffice' }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `ECS office create failed (${res.status})`);

  const port = process.env.PORT || 3020;
  const hostUrl = process.env.OFFICE_HOST_URL || `http://127.0.0.1:${port}`;
  const share = writeShare({
    enabled: true,
    officeId: data.office?.id,
    inviteCode: data.office?.inviteCode,
    hostUrl,
    memberToken: null,
    role: 'owner',
  });
  return share;
}

async function joinShare({ inviteCode, hostUrl, bossAccessToken } = {}) {
  const base = ecsAuth.ecsBaseUrl();
  if (!base) throw new Error('ECS_BASE_URL required');
  if (!bossAccessToken) throw new Error('Boss login required');

  const res = await fetch(`${base}/api/offices/join`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bossAccessToken}`,
    },
    body: JSON.stringify({ inviteCode, hostUrl }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Join failed (${res.status})`);

  const share = writeShare({
    enabled: true,
    officeId: data.office?.id,
    inviteCode: null,
    hostUrl: hostUrl || data.hostUrl,
    memberToken: data.memberToken,
    role: data.role || 'member',
  });
  return share;
}

function getShareInfo() {
  return readShare();
}

function disableShare() {
  return writeShare({
    enabled: false,
    officeId: null,
    inviteCode: null,
    hostUrl: null,
    memberToken: null,
    role: null,
  });
}

module.exports = {
  enableShare,
  joinShare,
  getShareInfo,
  disableShare,
};
