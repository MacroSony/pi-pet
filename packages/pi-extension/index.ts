import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import coreModule from "./index.js";

// Pi's extension loader exposes bundled dependencies such as TypeBox and Text
// through its TypeScript/ESM loader. Keep the implementation in dependency-free
// CommonJS for runtime tests, and inject the loader-owned TypeBox and Text here
// so a source checkout does not need its own node_modules directory.
const core = ((coreModule as any).default || coreModule) as any;

export default function piPetExtension(pi: any) {
  return core(pi, { Type, Text });
}
