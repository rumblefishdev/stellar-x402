import { MemoryKeyStore, apiKeyStoreContract, sealedKeyStoreContract } from "./testing.js";

// The in-memory store other packages test against keeps the same contracts as PostgreSQL's.
apiKeyStoreContract(() => new MemoryKeyStore());
sealedKeyStoreContract(() => {
  const store = new MemoryKeyStore();
  return { registry: store, sealed: store };
});
