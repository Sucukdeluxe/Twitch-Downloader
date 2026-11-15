'use strict';
require('./release-queue-cases.cjs').run('queue-startup').catch(error => { console.error(error); process.exitCode = 1; });
