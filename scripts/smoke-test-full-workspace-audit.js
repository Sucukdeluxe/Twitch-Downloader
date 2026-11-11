'use strict';
require('./release-workspace-cases.cjs').run('full-workspace-audit').catch(error => { console.error(error); process.exitCode = 1; });
