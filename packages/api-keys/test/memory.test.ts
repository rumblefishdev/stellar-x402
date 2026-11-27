import {
  MemoryAccountPlanStore,
  MemoryAccountUsage,
  MemoryKeyStore,
  accountPlanStoreContract,
  accountUsageReaderContract,
  apiKeyStoreContract,
  sealedKeyStoreContract,
} from "./testing.js";

// The in-memory store other packages test against keeps the same contracts as PostgreSQL's.
apiKeyStoreContract(() => new MemoryKeyStore());
sealedKeyStoreContract(() => {
  const store = new MemoryKeyStore();
  return { registry: store, sealed: store };
});
accountPlanStoreContract(() => new MemoryAccountPlanStore());
accountUsageReaderContract(() => {
  const usage = new MemoryAccountUsage();
  return { reader: usage, pay: async (owner, at) => usage.pay(owner, at) };
});
