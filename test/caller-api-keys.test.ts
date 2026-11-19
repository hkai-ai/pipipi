import { createInMemoryCallerApiKeyStore } from "../src/caller-api-keys/memory.js";
import { callerApiKeyContract } from "./support/caller-api-key-contract.js";

callerApiKeyContract((clock) => createInMemoryCallerApiKeyStore({ clock }));
