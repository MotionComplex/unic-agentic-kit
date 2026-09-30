'use strict';

// The cockpit's API contract version, shared by the server and the browser.
//
// Why this exists: web/app.js is a STATIC file, so a browser reload always picks up the newest UI —
// but src/server.js is only read when the process starts. Update the plugin without restarting the
// server and you get a fresh page calling routes the running server has never heard of, which
// surfaces as a bare "Not found" toast with no hint that the server is the stale half.
//
// BUMP THIS whenever the HTTP surface changes in a way the UI depends on (new route, new required
// field, changed response shape). The browser compares its compiled-in expectation against
// GET /api/version and tells the user to restart the cockpit instead of failing mysteriously.
const API_VERSION = '5';

module.exports = { API_VERSION };
