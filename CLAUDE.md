# Notes for agents working in this repository

This repository is (or will again be) public. Everything in it is readable by
anyone: files, history, commit messages, pull request titles and
descriptions, comments and Actions logs. A force-push does not remove
anything from GitHub.

Never write any of these, in code, tests, docs, commits or PR text:

- real people's names or email addresses (use made-up fixtures: alice, bob,
  carol, box-a, box-b);
- names of our own machines, servers or internal hosts, real domains other
  than the product's public ones, IP addresses, or home-directory paths
  (use example.com, `$HOME`);
- names of private repositories, internal services or internal processes;
- customers, suppliers, money, or anything about the business;
- tracker, mission or conversation ids, links into the tracker, or quotes
  from conversations ("X decided on <date> …"). State the rule itself, not
  who asked for it or when;
- details of how any real deployment is secured (access rules, firewalls,
  tokens);
- screenshots or fixtures copied from a real account. Use the demo or
  fixture data only.

Internal design notes and plans belong in the private notes repository, not
in `docs/` here. Write pull request descriptions for an outside reader: what
changes and why, in product terms.

The `leak-check` workflow fails a change whose added lines, file names,
commit messages, title or description match one of its private patterns.
It reports only a rule number and a location; fix the named places and push
again. It cannot read images or videos: a new one only gets a warning, so
check every screenshot by eye before adding it.

## Running a local journal

Start a local journal with `bin/matron-journal` (or `npm start`, which runs
it), not `node src/server.js`. On macOS it then runs from a copy of node
named `matron-journal`, so per-app firewalls show it under its own name
instead of as `node`; elsewhere it just runs node. `MATRON_NAMED_NODE=0`
opts out.
