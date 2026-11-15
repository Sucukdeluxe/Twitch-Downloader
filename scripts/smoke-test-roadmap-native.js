'use strict';
require('./release-workspace-cases.cjs').run('roadmap-native').catch(error => { console.error(error); process.exitCode = 1; });
