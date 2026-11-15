'use strict';
require('./release-workspace-cases.cjs').run('sidebar-layout').catch(error => { console.error(error); process.exitCode = 1; });
