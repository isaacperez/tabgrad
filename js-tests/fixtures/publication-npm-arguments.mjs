// Argument observation only: no npm module, network, browser or credentials.
process.stdout.write(JSON.stringify({ arguments: process.argv.slice(2) }));
