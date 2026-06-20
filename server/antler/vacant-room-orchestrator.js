// Vacant room → CEO marketing pipeline trigger (P5 placeholder + local hook).

const agentRuntime = require('./agent-runtime');
const bossChat = require('./boss-chat-store');

/**
 * Build a CEO instruction from Coliving vacant-room payload.
 * @param {object} room - { roomId, title, price, location, mediaUrls, ... }
 */
function buildVacantRoomInstruction(room = {}) {
  const id = room.roomId || room.id || room.unit || 'unknown';
  const title = room.title || room.name || `Room ${id}`;
  const price = room.price || room.rent || '';
  const location = room.location || room.address || '';
  const media = room.mediaUrls || room.photos || [];
  const mediaNote = media.length ? `\nPhotos: ${media.slice(0, 5).join(', ')}` : '';

  return (
    `Room ${id} is now VACANT — run marketing workflow for FB group promo.\n\n` +
    `Title: ${title}\n` +
    (price ? `Price: ${price}\n` : '') +
    (location ? `Location: ${location}\n` : '') +
    mediaNote +
    `\n\nUse CEO plan with departments: Marketing. ` +
    `Steps should include [Product Research] (if hired), [Marketing Manager] plan, ` +
    `[Marketing Editor] copy, [Graphic Design] cover, [Marketing Junior] schedule FB.`
  );
}

/**
 * Default plan template for vacant room (boss/CEO can override).
 */
function vacantRoomPlanTemplate(room = {}) {
  const id = room.roomId || room.id || 'unit';
  return `## Plan overview
Vacant room ${id} — multi-platform promo (start with FB).

## Departments involved
- Marketing

## Steps
- [ ] [Product Research] Competitor / market scan for similar rooms (if hired)
- [ ] [Marketing Manager] Quarterly / multi-platform plan + sign-off criteria (if hired)
- [ ] [Marketing Editor] Draft FB group post copy (if hired)
- [ ] [Marketing Manager] REVIEW copy → REVISION → [Marketing Editor] (if Manager + Editor hired)
- [ ] [Graphic Design] Cover / listing image brief (if hired)
- [ ] [Marketing Manager] REVIEW design → REVISION → [Graphic Design] (if Manager + Design hired)
- [ ] [Marketing Junior] Validate copy+assets and schedule FB group post
`;
}

/**
 * Trigger CEO pipeline for a vacant room event.
 */
async function runVacantRoomPipeline(roomPayload = {}, opts = {}) {
  const room = roomPayload.room || roomPayload;
  const instruction = opts.instruction || buildVacantRoomInstruction(room);
  const ownerKey = opts.ownerKey || 'webhook:coliving';
  const orgRoles = require('./org-roles');
  const thread =
    opts.threadId
      ? { id: opts.threadId }
      : bossChat.ensureDefaultThread(orgRoles.SECRETARY_ROLE, ownerKey, 'Coliving');
  const threadId = thread?.id || null;

  return agentRuntime.handleInstruction(instruction, {
    mode: 'agent',
    threadId,
    ownerKey,
    authorName: 'Coliving',
  });
}

module.exports = {
  buildVacantRoomInstruction,
  vacantRoomPlanTemplate,
  runVacantRoomPipeline,
};
