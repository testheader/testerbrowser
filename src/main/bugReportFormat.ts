/**
 * Pure, dependency-free helpers behind index.ts's bug-report IPC handler
 * (#280). Kept out of index.ts because importing that module at all triggers
 * Electron's full app bootstrap (app.whenReady(), window creation,
 * autoUpdater) as a side effect of module load, so nothing inside it is
 * directly unit-testable — same rationale as logTail.ts (#226).
 */

export interface DiagnosticsSummary {
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  osRelease: string;
  recentErrors: { ts: number; message: string }[];
  appLog: { text: string; truncated: boolean };
}

/** Same <details> wrapper shape as renderer/utils.js's formatAppLogBlock(). */
export function formatAppLogBlockText(appLog: { text: string; truncated: boolean }): string {
  const lineCount = appLog.text ? appLog.text.split('\n').length : 0;
  const summary = `App log (last ${lineCount} lines${appLog.truncated ? ', truncated' : ''})`;
  return `<details><summary>${summary}</summary>\n\n\`\`\`\n${appLog.text}\n\`\`\`\n</details>`;
}

/** Mirrors renderer/bugreport.js's own preview formatting exactly, so what
 *  the user sees (and can edit) matches what gets posted verbatim. */
export function buildDefaultDiagnosticsText(d: DiagnosticsSummary): string {
  const lines = [
    `TesterBrowser: ${d.version}`,
    `Electron: ${d.electron}  Chrome: ${d.chrome}  Node: ${d.node}`,
    `${d.platform} ${d.arch} (${d.osRelease})`,
    '',
    d.recentErrors.length
      ? `Recent app errors:\n${d.recentErrors.map(e => `[${new Date(e.ts).toLocaleTimeString()}] ${e.message}`).join('\n')}`
      : 'No recent app errors recorded.',
    '',
    formatAppLogBlockText(d.appLog),
  ];
  return lines.join('\n');
}

export function wrapDiagnosticsMarkdown(area: string, text: string): string {
  return [
    '<details><summary>Diagnostics</summary>', '',
    '```', `Feature area: ${area}`, '', text, '```',
    '</details>',
  ].join('\n');
}

/** The GitHub issue title bugreport:submit creates — area prefix, first
 *  line of the description only, capped to GitHub's comfortable title
 *  length. */
export function buildBugReportTitle(area: string, description: string): string {
  return `[${area}] ${description.trim().split('\n')[0].slice(0, 80)}`;
}

export interface ProjectV2Node { id: string; title: string }

/** Finds a GitHub Projects (v2) board titled "Testerbrowser" (case-
 *  insensitive substring match) among the owner's boards, or null if none
 *  match. */
export function findProjectBoardId(nodes: ProjectV2Node[]): string | null {
  const project = nodes.find((p) => p.title.toLowerCase().includes('testerbrowser'));
  return project ? project.id : null;
}

/** Whether the addProjectV2ItemById mutation actually added the item. */
export function projectItemWasAdded(
  json: { data?: { addProjectV2ItemById?: { item?: { id?: string } | null } | null } | null } | null | undefined
): boolean {
  return !!json?.data?.addProjectV2ItemById?.item?.id;
}
