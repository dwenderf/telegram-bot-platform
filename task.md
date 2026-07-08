# Task List: Thread & Group Registry

- [x] Create additive database migration `supabase/migrations/20260709000000_thread_registry_columns.sql`
- [x] Modify `lib/capabilities.ts`:
  - [x] Import `postgres` at the top
  - [x] Create and export the `registerThread` function
  - [x] Update `logMessage` to call `registerThread` inside the active transaction
- [x] Modify `app/api/webhooks/platform/[botSlug]/route.ts`:
  - [x] Import `registerThread` from capabilities
  - [x] Add the service message handler branch
- [x] Create the new test suite `scripts/test-thread-registry.ts`
- [x] Verify script compilation and type safety (`npm run check:scripts`)
- [x] Run the new test suite (`scripts/test-thread-registry.ts`)
- [x] Run other test suites to check for regressions
- [x] Verify Next.js production build (`npm run build`)
- [x] Create walkthrough report
