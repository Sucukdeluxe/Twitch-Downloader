'use strict';
require('./release-workspace-cases.cjs').run('audit-regressions').catch(error => { console.error(error); process.exitCode = 1; });
