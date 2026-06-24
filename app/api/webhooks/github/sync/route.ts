import { NextRequest, NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { createHmac, timingSafeEqual } from 'crypto';
import { sql, withTenantContext } from '@/lib/supabase';
import { fetchGitHubFile, compareGitHubCommits } from '@/lib/github';
import { Entity } from '@/lib/capabilities';

/**
 * Verify GitHub webhook HMAC-SHA256 signature
 */
function verifySignature(body: string, signature: string | null, secret: string): boolean {
  if (!signature || !secret) return false;
  
  const hmac = createHmac('sha256', secret);
  const calculatedSignature = 'sha256=' + hmac.update(body).digest('hex');
  
  const sigBuffer = Buffer.from(signature, 'utf8');
  const calcBuffer = Buffer.from(calculatedSignature, 'utf8');
  
  return sigBuffer.length === calcBuffer.length && timingSafeEqual(sigBuffer, calcBuffer);
}

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();
    const signature = req.headers.get('x-hub-signature-256');
    const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET || '';

    // 1. Authenticate webhook origin using signature (global secret)
    if (!verifySignature(rawBody, signature, webhookSecret)) {
      console.warn('Unauthorized GitHub sync attempt (invalid signature)');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const payload = JSON.parse(rawBody);
    const ref = payload.ref;
    const repository = payload.repository;
    
    if (!ref || !repository) {
      return NextResponse.json({ ok: true, msg: 'Not a push event' });
    }

    const repoName = repository.name;
    const repoOwner = repository.owner?.login || repository.owner?.name;
    const branchName = ref.replace('refs/heads/', '');
    
    const before = payload.before;
    const after = payload.after;

    // 2. Bootstrap RLS: Resolve the entity ID from public repo owner and name
    // This calls the SECURITY DEFINER function to bypass RLS and get the non-secret UUID.
    const bootstrapResult = await sql<any[]>`
      select resolve_entity_id_by_repo(${repoOwner}, ${repoName}) as id
    `;

    const entityId = bootstrapResult[0]?.id;
    if (!entityId) {
      console.info(`No matching entity found for repo: ${repoOwner}/${repoName}`);
      return NextResponse.json({ ok: true, msg: 'Repo not tracked' });
    }

    // 3. Fetch config inside the RLS context of the resolved entity ID
    // We fetch the decrypted GitHub PAT token using get_current_entity_secret
    const entity = await withTenantContext(entityId, async (tx) => {
      const rows = await tx<Entity[]>`
        select e.id, e.slug, e.github_owner, e.github_repo, e.github_branch, e.context_root,
               get_current_entity_secret(e.github_token_id) as github_token
        from entities e
        where e.id = ${entityId}
        limit 1
      `;
      return rows[0];
    });

    if (!entity) {
      return NextResponse.json({ ok: true, msg: 'Tenant config mismatch' });
    }

    // Gracefully check for incomplete configuration or missing token (e.g. in v1)
    if (
      !entity.github_owner ||
      !entity.github_repo ||
      !entity.github_branch ||
      !entity.context_root ||
      !entity.github_token
    ) {
      console.info(`Skipping GitHub sync for entity ${entity.slug}: incomplete GitHub configuration or missing Vault token`);
      return NextResponse.json({ ok: true, msg: 'GitHub configuration incomplete' });
    }

    const githubOwner = entity.github_owner;
    const githubRepo = entity.github_repo;
    const githubBranch = entity.github_branch;
    const contextRoot = entity.context_root;
    const githubToken = entity.github_token;

    // Verify the push is on the tracked branch
    if (branchName !== githubBranch) {
      return NextResponse.json({ ok: true, msg: `Ignoring push to non-tracked branch: ${branchName}` });
    }

    // Zero SHA indicates branch creation/deletion - nothing to compare
    const isZeroSha = /^0+$/.test(before) || /^0+$/.test(after);
    if (isZeroSha) {
      return NextResponse.json({ ok: true, msg: 'Branch modification without commit history comparison' });
    }

    // 4. Delegate cache sync to background task using waitUntil
    waitUntil(
      (async () => {
        try {
          console.info(`Starting GitHub cache sync for ${entity.slug} between ${before.slice(0, 7)}...${after.slice(0, 7)}`);

          // Fetch commit diff from GitHub Compare API using decrypted token
          const { added, modified, removed, renamed } = await compareGitHubCommits(
            githubOwner,
            githubRepo,
            before,
            after,
            githubToken
          );

          const contextPrefix = `${contextRoot}/`;
          const isContextFile = (path: string) => path.startsWith(contextPrefix) && path.endsWith('.md');

          // Process deletions and updates within the RLS context
          await withTenantContext(entity.id, async (tx) => {
            // Process deletions (removed & renames old path)
            const pathsToDelete = [
              ...removed.filter(isContextFile),
              ...renamed.map((r) => r.from).filter(isContextFile),
            ];

            for (const path of pathsToDelete) {
              await tx`
                delete from doc_cache
                where entity_id = ${entity.id}
                  and doc_path = ${path}
              `;
              console.info(`Deleted cached doc: ${path}`);
            }

            // Process upserts (added, modified & renames new path)
            const pathsToUpsert = [
              ...added.filter(isContextFile),
              ...modified.filter(isContextFile),
              ...renamed.map((r) => r.to).filter(isContextFile),
            ];

            for (const path of pathsToUpsert) {
              try {
                // Fetch latest file content and Git SHA from GitHub
                const fileData = await fetchGitHubFile(
                  githubOwner,
                  githubRepo,
                  path,
                  githubBranch,
                  githubToken
                );

                // Upsert file cache in database
                await tx`
                  insert into doc_cache (entity_id, doc_path, content, git_sha, synced_at)
                  values (${entity.id}, ${path}, ${fileData.content}, ${fileData.sha}, now())
                  on conflict (entity_id, doc_path) do update set
                    content = excluded.content,
                    git_sha = excluded.git_sha,
                    synced_at = now()
                `;
                console.info(`Synced cached doc: ${path}`);
              } catch (err) {
                console.error(`Failed to sync file ${path}:`, err);
              }
            }
          });

          console.info(`Completed GitHub cache sync for ${entity.slug}`);
        } catch (err: any) {
          console.error(`Error in background GitHub sync task:`, err.message);
        }
      })()
    );

    return NextResponse.json({ ok: true, msg: 'Sync task started' });
  } catch (error: any) {
    console.error('GitHub sync webhook crashed:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
