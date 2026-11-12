'use strict';
require('./release-workspace-cases.cjs').run('roadmap-cleanup-ui').catch(error => { console.error(error); process.exitCode = 1; });
