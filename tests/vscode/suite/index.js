const projectExplorerSuite = require('./project-explorer.test');

async function run() {
  await projectExplorerSuite.run();
}

module.exports = { run };
