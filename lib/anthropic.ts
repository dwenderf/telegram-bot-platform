// Backwards-compatibility wrapper for existing test harnesses
import { setGlobalMock, CallModelInput, CallModelResult } from './model';

export type { CallModelInput, CallModelResult } from './model';

export function setMockCallModel(
  mock: ((input: CallModelInput) => Promise<CallModelResult>) | null
) {
  setGlobalMock(mock);
}
