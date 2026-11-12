// Keep the macOS gate independent of Homebrew and other host media tools.
require('./smoke-test-precise-trim').run({ macOnly: true }).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
