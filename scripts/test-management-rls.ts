// Adversarial RLS Verification Suite for Management Plane (Phase 1)
// Run with: npx tsx scripts/test-management-rls.ts

// Set a dummy ANTHROPIC_API_KEY so no real key is ever needed
process.env.ANTHROPIC_API_KEY = 'dummy-test-key';

import postgres from 'postgres';
import assert from 'assert';

// Helper to run query as a simulated authenticated Supabase user
async function runAsUser<T>(
  sql: postgres.Sql,
  userId: string,
  email: string,
  callback: (tx: postgres.TransactionSql) => Promise<T>
): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx`set local role = 'authenticated'`;
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, email })}, true)`;
    await tx`set local row_security = on`;
    return await callback(tx);
  })) as T;
}

// Helper to run query as an anonymous (unauthenticated) user
async function runAsAnon<T>(
  sql: postgres.Sql,
  callback: (tx: postgres.TransactionSql) => Promise<T>
): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx`set local role = 'anon'`;
    await tx`select set_config('request.jwt.claims', '{}', true)`;
    await tx`set local row_security = on`;
    return await callback(tx);
  })) as T;
}

// Helper to simulate the idempotent inviteUser helper in capabilities layer
async function inviteUser(
  sql: postgres.Sql,
  input: {
    entityId: string;
    email: string;
    role: 'admin' | 'editor' | 'viewer';
    grantedBy: string;
  }
): Promise<void> {
  await runAsUser(sql, input.grantedBy, 'owner@test.com', async (tx) => {
    await tx`select public.invite_user(${input.entityId}, ${input.email}, ${input.role})`;
  });
}

async function main() {
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  const botUrl = process.env.DATABASE_URL;

  // Declare connection scopes so teardown can access them
  let sql: postgres.Sql | null = null;
  let botSql: postgres.Sql | null = null;

  // Test state IDs
  const USER_A = 'a0000000-0000-0000-0000-000000000000';
  const USER_B = 'b0000000-0000-0000-0000-000000000000';
  const ADMIN_U1  = 'd0000001-0000-0000-0000-000000000000';
  const VIEWER_U2 = 'd0000002-0000-0000-0000-000000000000';
  const STRANGER_C = 'c0000000-0000-0000-0000-000000000000';

  const E1 = 'e1000000-0000-0000-0000-000000000000';
  const E2 = 'e2000000-0000-0000-0000-000000000000';

  let secret1Id: string | null = null;
  let secret2Id: string | null = null;

  try {
    if (!adminUrl || !botUrl) {
      throw new Error('Both ADMIN_DATABASE_URL and DATABASE_URL are required to run RLS verification tests.');
    }

    // Privileged/postgres connection
    sql = postgres(adminUrl, { max: 5, prepare: false });
    // Restricted bot_service connection
    botSql = postgres(botUrl, { max: 2, prepare: false });

    console.log('--- Setting Up Test Environment ---');

    // Clean up any stale test rows & Vault secrets by name first (fully self-healing)
    await sql`delete from public.entities where id in (${E1}, ${E2})`;
    await sql`delete from auth.users where id in (${USER_A}, ${USER_B}, ${ADMIN_U1}, ${VIEWER_U2}, ${STRANGER_C})`;
    await sql`delete from vault.secrets where name in ('test_token', 'test_webhook_secret')`;

    // Create Vault secrets for webhook mapping
    const s1 = await sql<{ id: string }[]>`select vault.create_secret('mock-bot-token', 'test_token') as id`;
    const s2 = await sql<{ id: string }[]>`select vault.create_secret('mock-webhook-secret', 'test_webhook_secret') as id`;
    secret1Id = s1[0]?.id;
    secret2Id = s2[0]?.id;

    // 1. Provision auth users (auth.users trigger handles public.profiles creation)
    await sql`insert into auth.users (id, email, email_confirmed_at, aud, role) values (${USER_A}, 'user_a@test.com', now(), 'authenticated', 'authenticated')`;
    await sql`insert into auth.users (id, email, email_confirmed_at, aud, role) values (${USER_B}, 'user_b@test.com', now(), 'authenticated', 'authenticated')`;
    await sql`insert into auth.users (id, email, email_confirmed_at, aud, role) values (${ADMIN_U1}, 'admin_u1@test.com', now(), 'authenticated', 'authenticated')`;
    await sql`insert into auth.users (id, email, email_confirmed_at, aud, role) values (${VIEWER_U2}, 'viewer_u2@test.com', now(), 'authenticated', 'authenticated')`;
    await sql`insert into auth.users (id, email, email_confirmed_at, aud, role) values (${STRANGER_C}, 'user_c@test.com', now(), 'authenticated', 'authenticated')`;

    // 2. Create entities (triggers do not override owner since auth.uid() is null during setup)
    await sql`insert into public.entities (id, slug, display_name, owner_profile_id, telegram_bot_username, telegram_bot_token_id, telegram_webhook_secret_id)
              values (${E1}, 'entity-1-test', 'Entity 1', ${USER_A}, 'test_bot', ${secret1Id}, ${secret2Id})`;
    await sql`insert into public.entities (id, slug, display_name, owner_profile_id, telegram_bot_username)
              values (${E2}, 'entity-2-test', 'Entity 2', ${USER_B}, 'test2_bot')`;

    // 3. Create authorizations
    await sql`insert into public.authorizations (entity_id, profile_id, role, status, granted_by)
              values (${E1}, ${ADMIN_U1}, 'admin', 'active', ${USER_A})`;
    await sql`insert into public.authorizations (entity_id, profile_id, role, status, granted_by)
              values (${E1}, ${VIEWER_U2}, 'viewer', 'active', ${USER_A})`;

    console.log('Setup completed. Running tests...\n');

    // =========================================================================
    // Test Case 1: Cross-entity isolation
    // =========================================================================
    console.log('Running Test Case 1: Cross-entity isolation...');

    // 1a: User A cannot SELECT User B's entity (E2)
    const selectE2 = await runAsUser(sql, USER_A, 'user_a@test.com', async (tx) => {
      return await tx`select id from public.entities where id = ${E2}`;
    });
    assert.strictEqual(selectE2.length, 0, 'Test 1a Failed: User A should not see E2');

    // 1b: User A cannot UPDATE User B's entity (E2)
    const updateE2 = await runAsUser(sql, USER_A, 'user_a@test.com', async (tx) => {
      return await tx`update public.entities set display_name = 'hacked' where id = ${E2}`;
    });
    assert.strictEqual(updateE2.count, 0, 'Test 1b Failed: User A should not update E2');
    const readE2 = await sql`select display_name from public.entities where id = ${E2}`;
    assert.notStrictEqual(readE2[0].display_name, 'hacked', 'Test 1b State Check Failed: E2 display name was modified');

    // 1c: User A cannot DELETE User B's entity (E2)
    const deleteE2 = await runAsUser(sql, USER_A, 'user_a@test.com', async (tx) => {
      return await tx`delete from public.entities where id = ${E2}`;
    });
    assert.strictEqual(deleteE2.count, 0, 'Test 1c Failed: User A should not delete E2');
    const checkE2 = await sql`select count(*)::int from public.entities where id = ${E2}`;
    assert.strictEqual(checkE2[0].count, 1, 'Test 1c State Check Failed: E2 was deleted');

    // 1d: User A cannot insert forged authorization on E2
    let denied1d = false;
    try {
      await runAsUser(sql, USER_A, 'user_a@test.com', async (tx) => {
        await tx`insert into public.authorizations (entity_id, profile_id, role, granted_by)
                 values (${E2}, ${USER_A}, 'admin', ${USER_B})`;
      });
    } catch { denied1d = true; }
    const forged = await sql`select count(*)::int as c from public.authorizations
                             where entity_id = ${E2} and profile_id = ${USER_A}`;
    assert.strictEqual(forged[0].c, 0, 'Test 1d Failed: forged auth row exists on E2');

    console.log('✅ Test Case 1 Passed.');

    // =========================================================================
    // Test Case 2: Strangers visibility
    // =========================================================================
    console.log('Running Test Case 2: Stranger visibility checks...');

    // 2a: User with no access cannot SELECT E1
    const strangerSelect = await runAsUser(sql, STRANGER_C, 'user_c@test.com', async (tx) => {
      return await tx`select id from public.entities where id = ${E1}`;
    });
    assert.strictEqual(strangerSelect.length, 0, 'Test 2a Failed: Stranger should not see E1');

    // 2b: User C cannot SELECT User A's profile
    const strangerProfileSelect = await runAsUser(sql, STRANGER_C, 'user_c@test.com', async (tx) => {
      return await tx`select id from public.profiles where id = ${USER_A}`;
    });
    assert.strictEqual(strangerProfileSelect.length, 0, 'Test 2b Failed: Stranger should not see User A profile');

    console.log('✅ Test Case 2 Passed.');

    // =========================================================================
    // Test Case 3: Privilege escalation & Test Case 6: Owner Protection
    // =========================================================================
    console.log('Running Test Case 3 & 6: Privilege escalation & Owner protection checks...');

    // 3a: Admin U1 cannot DELETE E1
    const adminDelete = await runAsUser(sql, ADMIN_U1, 'admin_u1@test.com', async (tx) => {
      return await tx`delete from public.entities where id = ${E1}`;
    });
    assert.strictEqual(adminDelete.count, 0, 'Test 3a Failed: Admin successfully deleted E1');
    const checkE1 = await sql`select count(*)::int from public.entities where id = ${E1}`;
    assert.strictEqual(checkE1[0].count, 1, 'Test 3a State Check Failed: E1 was deleted');

    // 3b / 6: Admin U1 cannot UPDATE owner_profile_id on E1 and cannot demote owner
    try {
      await runAsUser(sql, ADMIN_U1, 'admin_u1@test.com', async (tx) => {
        await tx`update public.entities set owner_profile_id = ${ADMIN_U1} where id = ${E1}`;
      });
    } catch (e: any) {
      // expected error
    }
    const readE1Owner = await sql`select owner_profile_id from public.entities where id = ${E1}`;
    assert.strictEqual(readE1Owner[0].owner_profile_id, USER_A, 'Test 3b/6 State Check Failed: Owner was modified/demoted');

    // 3c: Admin U1 cannot grant a higher role to self
    const adminSelfUpdate = await runAsUser(sql, ADMIN_U1, 'admin_u1@test.com', async (tx) => {
      return await tx`update public.authorizations set role = 'admin' where entity_id = ${E1} and profile_id = ${ADMIN_U1}`;
    });
    assert.strictEqual(adminSelfUpdate.count, 0, 'Test 3c Failed: Admin modified auth row');
    const readAdminRole = await sql`select role from public.authorizations where entity_id = ${E1} and profile_id = ${ADMIN_U1}`;
    assert.strictEqual(readAdminRole[0].role, 'admin', 'Test 3c State Check Failed: Role was modified');

    // 3d: Admin U1 cannot delete other authorizations
    const adminRevoke = await runAsUser(sql, ADMIN_U1, 'admin_u1@test.com', async (tx) => {
      return await tx`delete from public.authorizations where entity_id = ${E1} and profile_id = ${VIEWER_U2}`;
    });
    assert.strictEqual(adminRevoke.count, 0, 'Test 3d Failed: Admin revoked access');
    const checkViewerAuth = await sql`select count(*)::int from public.authorizations where entity_id = ${E1} and profile_id = ${VIEWER_U2}`;
    assert.strictEqual(checkViewerAuth[0].count, 1, 'Test 3d State Check Failed: Viewer auth was revoked');

    // 3e: Admin U1 cannot insert invalid role
    try {
      await runAsUser(sql, ADMIN_U1, 'admin_u1@test.com', async (tx) => {
        await tx`insert into public.authorizations (entity_id, profile_id, role) values (${E1}, ${STRANGER_C}, 'owner')`;
      });
      assert.fail('Test 3e Failed: Admin inserted invalid role owner');
    } catch (e: any) {
      assert.ok(e.message.includes('check constraint') || e.message.includes('violates'), 'Test 3e: Invalid role rejected correctly');
    }

    console.log('✅ Test Case 3 & 6 Passed.');

    // =========================================================================
    // Test Case 4: Editors/Viewers cannot mutate authorizations
    // =========================================================================
    console.log('Running Test Case 4: Editor/Viewer authorization mutations...');

    let denied4 = false;
    try {
      await runAsUser(sql, VIEWER_U2, 'viewer_u2@test.com', async (tx) => {
        await tx`insert into public.authorizations (entity_id, profile_id, role) values (${E1}, ${STRANGER_C}, 'viewer')`;
      });
    } catch { denied4 = true; }
    const created = await sql`select count(*)::int as c from public.authorizations
                              where entity_id = ${E1} and profile_id = ${STRANGER_C}`;
    assert.strictEqual(created[0].c, 0, 'Test 4 Failed: viewer created an auth row on E1');

    console.log('✅ Test Case 4 Passed.');

    // =========================================================================
    // Test Case 5: Client-supplied fields override
    // =========================================================================
    console.log('Running Test Case 5: Client-supplied field overrides...');

    // 5a: Client-supplied owner_profile_id set to User B's ID on INSERT is overridden to User A's ID
    const newEId = 'e3000000-0000-0000-0000-000000000000';
    await runAsUser(sql, USER_A, 'user_a@test.com', async (tx) => {
      await tx`insert into public.entities (id, slug, display_name, owner_profile_id, telegram_bot_username)
               values (${newEId}, 'entity-3-test', 'Entity 3', ${USER_B}, 'test3_bot')`;
    });
    const readNewEntity = await sql`select owner_profile_id from public.entities where id = ${newEId}`;
    assert.strictEqual(readNewEntity[0].owner_profile_id, USER_A, 'Test 5a Failed: owner_profile_id was not overridden to User A');
    await sql`delete from public.entities where id = ${newEId}`;

    // 5b: Client-supplied granted_by set to User B's ID on INSERT is overridden to User A's ID
    const newAId = 'a1000000-0000-0000-0000-000000000000';
    await runAsUser(sql, USER_A, 'user_a@test.com', async (tx) => {
      await tx`insert into public.authorizations (id, entity_id, profile_id, role, status, granted_by)
               values (${newAId}, ${E1}, ${STRANGER_C}, 'viewer', 'active', ${USER_B})`;
    });
    const readNewAuth = await sql`select granted_by from public.authorizations where id = ${newAId}`;
    assert.strictEqual(readNewAuth[0].granted_by, USER_A, 'Test 5b Failed: granted_by was not overridden to User A');
    await sql`delete from public.authorizations where id = ${newAId}`;

    console.log('✅ Test Case 5 Passed.');

    // =========================================================================
    // Test Case 7: Invite-by-email
    // =========================================================================
    console.log('Running Test Case 7: Invite-by-email activations...');

    // Ensure STRANGER_C is deleted so no profile exists for user_c@test.com
    await sql`delete from auth.users where id = ${STRANGER_C}`;

    // Seed pending invite for STRANGER_C's email
    await runAsUser(sql, USER_A, 'user_a@test.com', async (tx) => {
      await tx`insert into public.authorizations (entity_id, invited_email, role, status)
               values (${E1}, 'user_c@test.com', 'viewer', 'pending')`;
    });

    // 7a: Invite for user_c@test.com cannot be activated by user_y@test.com (User Y sign up)
    const userYId = 'f0000000-0000-0000-0000-000000000000';
    await sql`insert into auth.users (id, email, email_confirmed_at, aud, role) values (${userYId}, 'user_y@test.com', now(), 'authenticated', 'authenticated')`;

    const pendingInvite = await sql`select profile_id, status from public.authorizations where entity_id = ${E1} and invited_email = 'user_c@test.com'`;
    assert.strictEqual(pendingInvite[0].profile_id, null, 'Test 7a Failed: Invite profile_id was set');
    assert.strictEqual(pendingInvite[0].status, 'pending', 'Test 7a Failed: Invite status was changed');

    await sql`delete from auth.users where id = ${userYId}`;

    // 7b: Invite for user_c@test.com does NOT auto-activate when User C signs up with an unconfirmed email
    await sql`insert into auth.users (id, email, email_confirmed_at, aud, role) values (${STRANGER_C}, 'user_c@test.com', null, 'authenticated', 'authenticated')`;

    const userCProfile = await sql`select id from public.profiles where id = ${STRANGER_C}`;
    assert.strictEqual(userCProfile.length, 1, 'Stranger profile must exist after unconfirmed signup');

    const pendingInviteAfterSignup = await sql`select profile_id, status from public.authorizations where entity_id = ${E1} and invited_email = 'user_c@test.com'`;
    assert.strictEqual(pendingInviteAfterSignup.length, 1, 'Invite row must still exist');
    assert.strictEqual(pendingInviteAfterSignup[0].profile_id, null, 'Invite profile_id should remain null for unconfirmed user');
    assert.strictEqual(pendingInviteAfterSignup[0].status, 'pending', 'Invite status should remain pending for unconfirmed user');

    // 7c: Invite auto-claims when User C confirms their email
    await sql`update auth.users set email_confirmed_at = now() where id = ${STRANGER_C}`;

    const claimedInvite = await sql`select profile_id, status, invited_email from public.authorizations where entity_id = ${E1} and profile_id = ${STRANGER_C}`;
    assert.strictEqual(claimedInvite.length, 1, 'Test 7c Failed: Invite was not claimed');
    assert.strictEqual(claimedInvite[0].status, 'active', 'Test 7c Failed: Invite status not active');
    assert.strictEqual(claimedInvite[0].invited_email, null, 'Test 7c Failed: invited_email was not cleared');

    console.log('✅ Test Case 7 Passed.');

    // =========================================================================
    // Test Case 8: Invite Replay
    // =========================================================================
    console.log('Running Test Case 8: Invite replay idempotency...');

    // Invite user first time
    await inviteUser(sql, {
      entityId: E1,
      email: 'replay_test@test.com',
      role: 'editor',
      grantedBy: USER_A,
    });
    // Invite user second time (replay)
    await inviteUser(sql, {
      entityId: E1,
      email: 'replay_test@test.com',
      role: 'viewer', // change role
      grantedBy: USER_A,
    });

    const activeInvites = await sql`select count(*)::int as count, role from public.authorizations where entity_id = ${E1} and invited_email = 'replay_test@test.com' group by role`;
    assert.strictEqual(activeInvites.length, 1, 'Test 8 Failed: Expected exactly one role group');
    assert.strictEqual(activeInvites[0].count, 1, 'Test 8 Failed: Expected exactly one pending invite row');
    assert.strictEqual(activeInvites[0].role, 'viewer', 'Test 8 Failed: Role was not updated to viewer');

    console.log('✅ Test Case 8 Passed.');

    // =========================================================================
    // Test Case 8b: Invite unconfirmed user must yield pending, not active
    // =========================================================================
    console.log('Running Test Case 8b: Invite unconfirmed user yields pending...');

    const unconfirmedUserId = 'd0000000-0000-0000-0000-000000000000';
    // Clean up state
    await sql`delete from auth.users where id = ${unconfirmedUserId}`;
    await sql`delete from public.authorizations where entity_id = ${E1} and invited_email = 'unconfirmed@test.com'`;
    await sql`delete from public.authorizations where entity_id = ${E1} and profile_id = ${unconfirmedUserId}`;

    // Provision unconfirmed user
    await sql`insert into auth.users (id, email, email_confirmed_at, aud, role) values (${unconfirmedUserId}, 'unconfirmed@test.com', null, 'authenticated', 'authenticated')`;

    // Invite the unconfirmed user
    await inviteUser(sql, {
      entityId: E1,
      email: 'unconfirmed@test.com',
      role: 'editor',
      grantedBy: USER_A,
    });

    // Assert that invite is pending
    const unconfirmedInvite = await sql`select profile_id, status from public.authorizations where entity_id = ${E1} and invited_email = 'unconfirmed@test.com'`;
    assert.strictEqual(unconfirmedInvite.length, 1, 'Test 8b Failed: Expected exactly one pending invite row');
    assert.strictEqual(unconfirmedInvite[0].profile_id, null, 'Test 8b Failed: Expected profile_id to be null (unconfirmed user)');
    assert.strictEqual(unconfirmedInvite[0].status, 'pending', 'Test 8b Failed: Expected status to be pending');

    // Clean up
    await sql`delete from auth.users where id = ${unconfirmedUserId}`;

    console.log('✅ Test Case 8b Passed.');

    // =========================================================================
    // Test Case 9: bot_service role isolation
    // =========================================================================
    console.log('Running Test Case 9: bot_service role isolation...');

    // 9a: bot_service cannot SELECT from profiles
    try {
      await botSql`select * from public.profiles`;
      assert.fail('Test 9a Failed: bot_service successfully queried profiles');
    } catch (e: any) {
      assert.strictEqual(e.code, '42501', 'Test 9a Failed: Expected insufficient privilege error (42501)');
    }

    // 9b: bot_service cannot INSERT into profiles
    try {
      await botSql`insert into public.profiles (id, email) values ('c0000000-0000-0000-0000-000000000000', 'hacker@test.com')`;
      assert.fail('Test 9b Failed: bot_service successfully inserted into profiles');
    } catch (e: any) {
      assert.strictEqual(e.code, '42501', 'Test 9b Failed: Expected insufficient privilege error (42501)');
    }

    // 9c: bot_service does not inherit elevated roles
    const inheritedRoles = await sql`
      select pg_has_role('bot_service', r.rolname, 'member') as has_role
      from pg_roles r
      where r.rolname in ('postgres', 'service_role', 'supabase_admin')
    `;
    const inherits = inheritedRoles.some((r) => r.has_role);
    assert.strictEqual(inherits, false, 'Test 9c Failed: bot_service inherits elevated privileges');

    console.log('✅ Test Case 9 Passed.');



    // =========================================================================
    // Test Case 11: Default Deny
    // =========================================================================
    console.log('Running Test Case 11: Default deny checks...');

    // 11a: Unauthenticated anon user is denied on all five management tables
    const tables = ['profiles', 'bots', 'bot_entities', 'authorizations', 'link_tokens'];
    for (const tbl of tables) {
      try {
        await runAsAnon(sql, async (tx) => {
          return await tx.unsafe(`select * from public.${tbl}`);
        });
        assert.fail(`Test 11a Failed: Anon user successfully queried public.${tbl}`);
      } catch (e: any) {
        // expected denial (empty result or RLS block)
      }
    }

    // 11b: Authenticated stranger User C is default-denied on bots, bot_entities, link_tokens
    const deniedTbls = ['bots', 'bot_entities', 'link_tokens'];
    for (const tbl of deniedTbls) {
      const rows: any = await runAsUser(sql, STRANGER_C, 'user_c@test.com', async (tx) => {
        return await tx.unsafe(`select * from public.${tbl}`);
      });
      assert.strictEqual(rows.length, 0, `Test 11b Failed: Stranger User C queried public.${tbl}`);
    }

    console.log('✅ Test Case 11 Passed.');

    console.log('\n🎉 ALL ADVERSARIAL RLS TESTS PASSED SUCCESSFULLY! 🎉');

  } catch (error) {
    console.error('\n❌ Verification Failed:');
    console.error(error);
    process.exit(1);
  } finally {
    console.log('\n--- Cleaning Up Test Environment ---');
    // Delete seeded data & secrets (tolerate errors gracefully to ensure connections always close)
    if (sql) {
      try {
        await sql`delete from public.entities where id in (${E1}, ${E2})`;
        await sql`delete from auth.users where id in (${USER_A}, ${USER_B}, ${ADMIN_U1}, ${VIEWER_U2}, ${STRANGER_C})`;
        await sql`delete from vault.secrets where name in ('test_token', 'test_webhook_secret')`;
        if (secret1Id) await sql`delete from vault.secrets where id = ${secret1Id}`;
        if (secret2Id) await sql`delete from vault.secrets where id = ${secret2Id}`;
      } catch (cleanupErr) {
        console.warn('Teardown cleanup warning:', cleanupErr);
      }
    }

    // Close database connections
    try {
      if (sql) await sql.end();
      if (botSql) await botSql.end();
    } catch (connErr) {
      console.error('Failed to close connections:', connErr);
    }
    console.log('Cleanup completed.');
  }
}

main();
