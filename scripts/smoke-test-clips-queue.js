'use strict';
require('./release-queue-cases.cjs').run('clips-queue').catch(error => { console.error(error); process.exitCode = 1; });
