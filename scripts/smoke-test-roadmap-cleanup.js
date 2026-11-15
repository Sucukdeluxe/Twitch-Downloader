'use strict';
require('./release-workspace-cases.cjs').run('roadmap-cleanup').catch(error => { console.error(error); process.exitCode = 1; });
