'use strict';
require('./release-workspace-cases.cjs').run('roadmap-clips').catch(error => { console.error(error); process.exitCode = 1; });
