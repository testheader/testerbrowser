#!/usr/bin/env node
// Release notes for the bump-version and status jobs in .github/workflows/build.yml.
//
//   changelog  Group the commits since the last release into a version section,
//              prepend it to CHANGELOG.md and write the release body.
//   status     Replace the build-status block in a release body with the job results.
//
// Commits are read with the Conventional Commit prefixes the bump step already
// relies on, so a commit that doesn't follow the convention lands under "Other".

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

/**
 * @typedef {{ hash: string, type: string, scope: string | null, breaking: boolean, description: string }} Commit
 */

const CHANGELOG_HEADER = '# Changelog\n\n';
const STATUS_START = '<!-- build-status:start -->';
const STATUS_END = '<!-- build-status:end -->';
const BUMP_COMMIT = /^chore: bump version to /;
const SUBJECT = /^(\w+)(\([^)]*\))?(!)?:\s*(.+)$/;

const RESULT_ICONS = {
  success: '✅',
  failure: '❌',
  cancelled: '⚪',
  skipped: '➖',
};

// Parses one commit's subject and body. Returns null for non-conventional subjects
// (they still count as "Other") and for the bot's own version bump commits.
function parseCommit({ hash, subject, body = '' }) {
  if (BUMP_COMMIT.test(subject)) return null;
  const match = SUBJECT.exec(subject);
  const breaking = Boolean(match && match[3]) || /BREAKING CHANGE/.test(body);
  if (!match) {
    return { hash, type: 'other', scope: null, breaking, description: subject };
  }
  return {
    hash,
    type: match[1].toLowerCase(),
    scope: match[2] ? match[2].slice(1, -1) : null,
    breaking,
    description: match[4],
  };
}

/**
 * Sorts parsed commits into the sections shown in the changelog.
 * @param {Array<ReturnType<typeof parseCommit>>} commits
 * @returns {{ breaking: Commit[], features: Commit[], fixes: Commit[], other: Commit[] }}
 */
function groupCommits(commits) {
  /** @type {{ breaking: Commit[], features: Commit[], fixes: Commit[], other: Commit[] }} */
  const groups = { breaking: [], features: [], fixes: [], other: [] };
  for (const commit of commits) {
    if (!commit) continue;
    if (commit.breaking) groups.breaking.push(commit);
    else if (commit.type === 'feat') groups.features.push(commit);
    else if (commit.type === 'fix') groups.fixes.push(commit);
    else groups.other.push(commit);
  }
  return groups;
}

function formatLine(commit) {
  const scope = commit.scope ? `**${commit.scope}:** ` : '';
  return `- ${scope}${commit.description} (${commit.hash.slice(0, 7)})`;
}

// The body shared by the changelog section and the GitHub release notes.
function renderBody(groups) {
  const sections = [
    ['Breaking changes', groups.breaking],
    ['Features', groups.features],
    ['Fixes', groups.fixes],
    ['Other', groups.other],
  ];
  const parts = sections
    .filter(([, items]) => items.length > 0)
    .map(([title, items]) => `### ${title}\n\n${items.map(formatLine).join('\n')}`);
  return parts.length > 0 ? parts.join('\n\n') : '_No changes recorded._';
}

// Turns job results ({ 'bump-version': { result }, ... }) into the status block.
function renderStatusBlock(needs, runUrl) {
  const entries = Object.entries(needs);
  const allPassed = entries.every(([, job]) => job.result === 'success');
  const lines = entries.map(([name, job]) => {
    const icon = RESULT_ICONS[job.result] || '❔';
    return `- ${icon} ${name}: ${job.result}`;
  });
  const heading = allPassed ? '**Build passed**' : '**Build did not pass**';
  const link = runUrl ? `\n\n[Workflow run](${runUrl})` : '';
  return `${STATUS_START}\n### Build status\n\n${heading}\n\n${lines.join('\n')}${link}\n${STATUS_END}`;
}

// Replaces an existing status block in a release body, or appends one.
function replaceStatusBlock(body, block) {
  const start = body.indexOf(STATUS_START);
  const end = body.indexOf(STATUS_END);
  if (start !== -1 && end !== -1 && end > start) {
    return body.slice(0, start) + block + body.slice(end + STATUS_END.length);
  }
  return `${body.trimEnd()}\n\n${block}\n`;
}

// Prepends a version section under the changelog's title. Re-running for a
// version that is already present leaves the file alone.
function prependSection(existing, version, section) {
  if (existing.includes(`## v${version} `)) return existing;
  const rest = existing.startsWith(CHANGELOG_HEADER)
    ? existing.slice(CHANGELOG_HEADER.length)
    : existing;
  const tail = rest.trimStart();
  return tail ? `${CHANGELOG_HEADER}${section}\n\n${tail}` : `${CHANGELOG_HEADER}${section}\n`;
}

// Reads commits in `since..until`, or the whole history up to `until` when `since` is empty.
function readCommits(since, until = 'HEAD') {
  const range = since ? `${since}..${until}` : until;
  const out = execFileSync('git', ['log', '--format=%H%x1f%s%x1f%b%x1e', range], {
    encoding: 'utf8',
  });
  return out
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash, subject, body = ''] = record.split('\x1f');
      return { hash, subject, body };
    });
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    options[rest[i].replace(/^--/, '')] = rest[i + 1];
  }
  return { command, options };
}

function runChangelog({ version, since = '', until, date, changelog, notesOut }) {
  const commits = readCommits(since, until).map(parseCommit);
  const body = renderBody(groupCommits(commits));
  const section = `## v${version} — ${date}\n\n${body}`;

  const existing = fs.existsSync(changelog) ? fs.readFileSync(changelog, 'utf8') : '';
  fs.writeFileSync(changelog, prependSection(existing, version, section));

  const pending = `${STATUS_START}\n### Build status\n\n⏳ Builds pending\n${STATUS_END}`;
  fs.writeFileSync(notesOut, `${body}\n\n${pending}\n`);
}

function runStatus({ body: bodyPath, out, needs, runUrl }) {
  const body = fs.readFileSync(bodyPath, 'utf8');
  const block = renderStatusBlock(JSON.parse(needs), runUrl);
  fs.writeFileSync(out, replaceStatusBlock(body, block));
}

function main(argv) {
  const { command, options } = parseArgs(argv);
  if (command === 'changelog') {
    runChangelog({
      version: options.version,
      since: options.since,
      until: options.until,
      date: options.date || new Date().toISOString().slice(0, 10),
      changelog: options.changelog || 'CHANGELOG.md',
      notesOut: options['notes-out'],
    });
  } else if (command === 'status') {
    runStatus({
      body: options.body,
      out: options.out,
      needs: process.env.NEEDS_JSON,
      runUrl: process.env.RUN_URL,
    });
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  parseCommit,
  groupCommits,
  renderBody,
  renderStatusBlock,
  replaceStatusBlock,
  prependSection,
};
