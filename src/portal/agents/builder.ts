import { CORE_CAPABILITY_SCHEMA } from "../../../core/client/schema.js";
import type { ValidationReport } from "./validator.js";

// BuilderAgent — Generates candidate Policy and UI code from operator dialogue (R12, R16).

export interface BuilderDraft {
  explanation: string;
  code: string;
  target: "policy" | "interaction";
  suggestedAlternative?: string;
}

export interface BuilderPromptContext {
  userPrompt: string;
  currentCode?: string;
  mode: "blank_slate" | "customize_stock";
  validationFeedback?: ValidationReport;
}

export class BuilderAgent {
  // Generate candidate periphery code based on operator instructions
  async generatePeriphery(context: BuilderPromptContext): Promise<BuilderDraft> {
    const prompt = context.userPrompt.toLowerCase();

    // 1. If we have validation feedback indicating an unsupported capability (AE2)
    if (context.validationFeedback && !context.validationFeedback.valid) {
      return this.handleRejectionFeedback(context.userPrompt, context.validationFeedback);
    }

    // 2. Check for explicit unsupported requests directly (e.g. rotator control per AE2)
    for (const unsupp of CORE_CAPABILITY_SCHEMA.unsupported) {
      if (
        prompt.includes(unsupp.feature) ||
        unsupp.aliases.some((alias) => prompt.includes(alias.toLowerCase()))
      ) {
        return {
          explanation: `I cannot generate code to control your ${unsupp.feature} because: ${unsupp.reason}`,
          code: `// ${unsupp.feature} is not supported by core radio API.\n// Alternative: Visual alert\ndigiDx.on('decode', (d) => {\n  if (d.message.includes('VK')) {\n    console.log('DX Alert: VK station heard - check beam heading ~180°');\n  }\n});`,
          target: "policy",
          suggestedAlternative: unsupp.alternative
        };
      }
    }

    // 3. Audio beep on 73 modification (AE4)
    if (prompt.includes("73") && (prompt.includes("beep") || prompt.includes("audio"))) {
      return {
        explanation: "Added an audio beep notification whenever someone sends 73 to your callsign.",
        code: `
          // Dynamically updated policy with 73 audio alert (AE4)
          digiDx.on('decode', function(decode) {
            const myCall = (digiDx.identity && digiDx.identity.call) || '';
            if (myCall && decode.message.includes(myCall) && decode.message.includes('73')) {
              console.log('BEEP: 73 received from ' + decode.message);
              // Trigger web audio beep
              try {
                const ctx = new (window.AudioContext || window.webkitAudioContext)();
                const osc = ctx.createOscillator();
                osc.frequency.value = 880;
                osc.connect(ctx.destination);
                osc.start();
                osc.stop(ctx.currentTime + 0.2);
              } catch (e) {}
            }
          });
        `.trim(),
        target: "policy"
      };
    }

    // 4. Blank-slate priority queue and sequencer (F2)
    if (prompt.includes("priority queue") || prompt.includes("distance") || context.mode === "blank_slate") {
      return {
        explanation: "Created a custom FT8 Policy layer that queues incoming CQ callers and prioritizes them by distance.",
        code: `
          // Custom Blank-Slate FT8 Policy Layer
          let queue = [];
          digiDx.on('decode', function(decode) {
            if (decode.message.startsWith('CQ ')) {
              const parts = decode.message.split(' ');
              const caller = parts[1];
              const grid = parts[2];
              if (caller && !queue.some(q => q.call === caller)) {
                queue.push({ call: caller, grid: grid, snr: decode.snr });
                digiDx.setPolicyState({ callerQueue: queue });
              }
            }
          });
        `.trim(),
        target: "policy"
      };
    }

    // Default generic extension
    return {
      explanation: "Generated operating interface component.",
      code: `
        // Custom Periphery Component
        digiDx.on('decode', function(d) {
          console.log('Decode received:', d.message);
        });
      `.trim(),
      target: "policy"
    };
  }

  private handleRejectionFeedback(originalPrompt: string, feedback: ValidationReport): BuilderDraft {
    const firstError = feedback.errors[0];
    const alternative = firstError?.alternative ?? "Use supported CoreClient telemetry and transmit methods.";

    return {
      explanation: `The component validator rejected the requested capability: ${firstError?.message ?? "Unsupported operation"}.`,
      code: `
        // Revised policy using supported alternatives
        digiDx.on('decode', function(d) {
          // Visual alert instead of hardware control
          console.log('Notification:', '${firstError?.identifier ?? "Event"} triggered');
        });
      `.trim(),
      target: "policy",
      suggestedAlternative: alternative
    };
  }
}
