'use strict';
require('./release-workspace-cases.cjs').run('roadmap-index').catch(error => { console.error(error); process.exitCode = 1; });
