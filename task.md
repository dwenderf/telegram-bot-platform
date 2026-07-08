# Task List: Long-Message Splitting

- [x] Implement `splitFormattedMessage` and `sendFormattedMessage` in `lib/telegram.ts`
- [x] Swap plain `sendMessage` calls with `sendFormattedMessage` in `app/api/webhooks/platform/[botSlug]/route.ts`
- [x] Create the new test suite `scripts/test-long-message-splitting.ts`
- [x] Verify script compilation and type safety (`npm run check:scripts`)
- [x] Run the new test suite (`scripts/test-long-message-splitting.ts`)
- [x] Run other test suites to check for regressions
- [x] Verify Next.js production build (`npm run build`)
- [x] Create walkthrough report
