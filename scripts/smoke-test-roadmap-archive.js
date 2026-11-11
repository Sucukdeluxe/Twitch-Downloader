'use strict';
require('./release-workspace-cases.cjs').run('roadmap-archive').catch(error => { console.error(error); process.exitCode = 1; });
