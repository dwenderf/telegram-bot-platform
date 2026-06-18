/**
 * GitHub API Service Wrapper
 * Handles base64 decoding, file retrieval, and commit comparisons.
 */

interface GitHubFileResponse {
  content: string;
  sha: string;
  encoding: string;
}

interface GitHubCompareResponse {
  files?: Array<{
    filename: string;
    previous_filename?: string;
    status: 'added' | 'removed' | 'modified' | 'renamed' | string;
  }>;
}

/**
 * Helper to build GitHub request headers
 */
function getHeaders(token: string) {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'telegram-bot-platform',
  };
  
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  
  return headers;
}

/**
 * Decodes base64 content safely to UTF-8, preserving multibyte characters (like 'ä')
 */
export function decodeBase64Utf8(base64Content: string): string {
  // Clean newlines/whitespace that GitHub API sometimes wraps base64 content in
  const cleanBase64 = base64Content.replace(/\s+/g, '');
  return Buffer.from(cleanBase64, 'base64').toString('utf8');
}

/**
 * Fetches a file's content and SHA from a GitHub repository.
 */
export async function fetchGitHubFile(
  owner: string,
  repo: string,
  path: string,
  branch: string,
  token: string
): Promise<{ content: string; sha: string }> {
  const encodedPath = encodeURIComponent(path);
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}?ref=${branch}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: getHeaders(token),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to fetch file ${path} from GitHub (${res.status}): ${errorText}`);
  }

  const data = (await res.json()) as GitHubFileResponse;

  if (data.encoding !== 'base64') {
    throw new Error(`Unsupported GitHub file encoding: ${data.encoding}`);
  }

  const decodedContent = decodeBase64Utf8(data.content);

  return {
    content: decodedContent,
    sha: data.sha,
  };
}

/**
 * Compares two commits using the GitHub Compare API to find which files changed.
 */
export async function compareGitHubCommits(
  owner: string,
  repo: string,
  before: string,
  after: string,
  token: string
): Promise<{
  added: string[];
  modified: string[];
  removed: string[];
  renamed: Array<{ from: string; to: string }>;
}> {
  const url = `https://api.github.com/repos/${owner}/${repo}/compare/${before}...${after}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: getHeaders(token),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to compare commits ${before}...${after} on GitHub (${res.status}): ${errorText}`);
  }

  const data = (await res.json()) as GitHubCompareResponse;

  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  const renamed: Array<{ from: string; to: string }> = [];

  if (data.files) {
    for (const file of data.files) {
      switch (file.status) {
        case 'added':
          added.push(file.filename);
          break;
        case 'modified':
          modified.push(file.filename);
          break;
        case 'removed':
          removed.push(file.filename);
          break;
        case 'renamed':
          if (file.previous_filename) {
            renamed.push({ from: file.previous_filename, to: file.filename });
          } else {
            // Fallback if previous_filename is missing for some reason
            added.push(file.filename);
          }
          break;
        default:
          // Treat any other status (e.g. copied/changed) as modified
          modified.push(file.filename);
          break;
      }
    }
  }

  return { added, modified, removed, renamed };
}
