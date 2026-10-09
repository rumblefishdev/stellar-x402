import {
  MemoryCatalogStore,
  MemoryRateLimitStore,
  MemorySettlementStore,
  MemorySpendStore,
} from "../src/adapters/memory.js";
import {
  catalogStoreContract,
  rateLimitStoreContract,
  settlementStoreContract,
  spendStoreContract,
} from "./port-contracts.js";

settlementStoreContract(() => new MemorySettlementStore());
spendStoreContract(() => new MemorySpendStore());
rateLimitStoreContract(() => new MemoryRateLimitStore());
catalogStoreContract(() => new MemoryCatalogStore());
