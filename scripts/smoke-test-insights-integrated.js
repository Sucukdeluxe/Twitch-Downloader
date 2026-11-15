'use strict';
require('./release-workspace-cases.cjs').run('insights-integrated').catch(error => { console.error(error); process.exitCode = 1; });
