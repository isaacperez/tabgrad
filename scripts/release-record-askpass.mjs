#!/usr/bin/env node
// Git invokes this trusted helper directly; never print a token to a log/report.
const match = /^(Username|Password) for '(https:\/\/[^']+)': ?$/.exec(process.argv[2] ?? "");
let accepted = false;
if (match) {
  const url = new URL(match[2]);
  accepted = url.hostname === "github.com" && url.port === "" && url.pathname === "/"
    && url.password === "" && url.search === "" && url.hash === ""
    && (match[1] === "Username" ? url.username === "" : url.username === "x-access-token");
}
if (!accepted || !process.env.GITHUB_TOKEN) process.exitCode = 1;
else process.stdout.write(`${match[1] === "Username" ? "x-access-token" : process.env.GITHUB_TOKEN}\n`);
