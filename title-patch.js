'use strict';

const patcher = require('./src/compatibility/title-patch');

if (require.main === module) patcher.runCli();

module.exports = patcher;
