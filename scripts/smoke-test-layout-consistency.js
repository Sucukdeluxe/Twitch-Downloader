'use strict';
require('./release-workspace-cases.cjs').run('layout-consistency').catch(error => { console.error(error); process.exitCode = 1; });
