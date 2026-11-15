import { CORE_CAPABILITY_SCHEMA, validateCoreCapability } from "../../../core/client/schema.js";

// ComponentValidator — Inspects candidate UI and Policy code against core capabilities
// and security boundaries before mounting into the sandbox iframe (KTD5, R13, R14, AE2).

export interface ValidationError {
  type: "unsupported_capability" | "prohibited_global" | "unknown_method" | "syntax_error";
  identifier: string;
  message: string;
  alternative?: string;
}

export interface ValidationReport {
  valid: boolean;
  callsDetected: string[];
  globalsDetected: string[];
  errors: ValidationError[];
  approvedCode?: string;
}

// Restricted globals that violate sandboxed network or execution boundaries
const PROHIBITED_GLOBALS = [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "Worker",
  "SharedWorker"
];

export class ComponentValidator {
  validateCode(code: string): ValidationReport {
    const errors: ValidationError[] = [];
    const callsDetected: string[] = [];
    const globalsDetected: string[] = [];

    // 1. Basic syntax sanity check
    try {
      // Test parse via Function constructor (without executing user code)
      new Function("digiDx", "container", `"use strict"; return () => {\n${code}\n};`);
    } catch (syntaxErr) {
      errors.push({
        type: "syntax_error",
        identifier: "syntax",
        message: `JavaScript syntax error: ${syntaxErr instanceof Error ? syntaxErr.message : String(syntaxErr)}`
      });
      return {
        valid: false,
        callsDetected,
        globalsDetected,
        errors
      };
    }

    // 2. Scan for prohibited global network / execution primitives
    for (const glob of PROHIBITED_GLOBALS) {
      const regex = new RegExp(`\\b${glob}\\s*(\\(|\\.)`, "g");
      if (regex.test(code)) {
        globalsDetected.push(glob);
        errors.push({
          type: "prohibited_global",
          identifier: glob,
          message: `Direct network egress via '${glob}' is prohibited by the periphery sandbox security policy (R10).`,
          alternative: "Interact with the station exclusively through the injected 'digiDx' CoreClient SDK."
        });
      }
    }

    // 3. Scan for digiDx / window.digiDx method invocations
    const digiDxCallRegex = /(?:window\.)?digiDx\.([a-zA-Z0-9_$]+)\s*\(/g;
    let match: RegExpExecArray | null;

    while ((match = digiDxCallRegex.exec(code)) !== null) {
      const methodName = match[1];
      if (methodName && !callsDetected.includes(methodName)) {
        callsDetected.push(methodName);
      }
    }

    // Also check for common radio capability keywords in variable or function calls (e.g. rotator, heading)
    for (const unsupp of CORE_CAPABILITY_SCHEMA.unsupported) {
      for (const alias of unsupp.aliases) {
        const aliasRegex = new RegExp(`(?:digiDx\\.)?\\b${alias}\\s*\\(`, "i");
        if (aliasRegex.test(code) && !callsDetected.includes(alias)) {
          callsDetected.push(alias);
        }
      }
    }

    // 4. Validate each detected capability against CORE_CAPABILITY_SCHEMA
    for (const call of callsDetected) {
      const result = validateCoreCapability(call);
      if (!result.valid) {
        errors.push({
          type: result.unsupported ? "unsupported_capability" : "unknown_method",
          identifier: call,
          message: result.reason ?? `'${call}' is not supported by the core SDK.`,
          alternative: result.alternative
        });
      }
    }

    const valid = errors.length === 0;

    return {
      valid,
      callsDetected,
      globalsDetected,
      errors,
      approvedCode: valid ? code : undefined
    };
  }
}
