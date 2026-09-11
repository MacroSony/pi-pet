import { Type } from "typebox";
import coreModule from "./index.js";

// Pi's extension loader exposes bundled dependencies such as TypeBox through
// its TypeScript/ESM loader. Keep the implementation in dependency-free
// CommonJS for runtime tests, and inject the loader-owned TypeBox here so a
// source checkout does not need its own node_modules directory.
const core = ((coreModule as any).default || coreModule) as any;

export default function piPetExtension(pi: any) {
  return core(pi, { Type });
}
