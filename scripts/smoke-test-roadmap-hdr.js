'use strict';
require('./release-workspace-cases.cjs').run('roadmap-hdr').catch(error => { console.error(error); process.exitCode = 1; });
