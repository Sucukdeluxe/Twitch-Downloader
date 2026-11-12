'use strict';
require('./release-queue-cases.cjs').run('full-queue-audit').catch(error => { console.error(error); process.exitCode = 1; });
