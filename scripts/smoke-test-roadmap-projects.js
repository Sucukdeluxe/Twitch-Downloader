'use strict';
require('./release-workspace-cases.cjs').run('roadmap-projects').catch(error => { console.error(error); process.exitCode = 1; });
