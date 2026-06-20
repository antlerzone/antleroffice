// Back-compat shim — use portal-partner-oauth.js for Coliving + AntlerChat + AntlerHub.

const portal = require('./portal-partner-oauth');

module.exports = {
  colivingEcsBase: () => portal.ecsBase('coliving'),
  colivingApiBase: () => portal.apiBase('coliving'),
  desktopFrontendOrigin: portal.desktopFrontendOrigin,
  buildOAuthStartUrl: (provider) => portal.buildOAuthStartUrl('coliving', provider),
  verifyPortalToken: (token) => portal.verifyPortalToken('coliving', token),
  fetchApiCredentials: (email) => portal.fetchApiCredentials('coliving', email),
  completeOAuth: (token) => portal.completeOAuth('coliving', token),
  isConnected: () => portal.isConnected('coliving'),
  getConnection: () => portal.readConnection('coliving'),
  clearConnection: () => {
    const fs = require('node:fs');
    const path = require('node:path');
    try {
      fs.unlinkSync(path.join(require('./store').getDataDir(), 'portal-oauth-coliving.json'));
    } catch { /* ignore */ }
  },
  authHeaders: () => portal.authHeaders('coliving'),
  publicStatus: () => portal.publicStatus('coliving'),
  callbackHtml: (opts) => portal.callbackHtml({ ...opts, partnerId: 'coliving' }),
  templateRequiresColivingOAuth: portal.templateRequiresPortalOAuth,
};
